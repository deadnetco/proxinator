/**
 * Forward proxy server - handles HTTP CONNECT requests.
 * Wraps each connection with auth parsing, destination info, and socket binding.
 */
const EventEmitter = require("events");
const http = require("http");
const normalizeAddress = require("../../../utils/ip").normalizeAddress;
const normalizeFamily = require("../../../utils/ip").normalizeFamily;

const PROXY_AGENT = "Proxinator";

/**
 * Write an HTTP response (status line + headers, no body) to a socket.
 *
 * Written as a raw string rather than via http.ServerResponse on purpose: for a
 * 2xx reply to CONNECT, ServerResponse adds "Transfer-Encoding: chunked" and a
 * "0\r\n\r\n" terminator, which then leak into the established tunnel and
 * corrupt it (e.g. TLS "wrong version number"). A raw write keeps every reply -
 * the 200 and the error responses - cleanly framed.
 *
 * @param {http.IncomingMessage} _req - Original request (unused; kept for call compatibility)
 * @param {net.Socket} socket - Socket to write to
 * @param {number} statusCode - HTTP status code
 * @param {string} statusMessage - HTTP status message
 * @param {object} [headers] - Additional headers
 */
const writeResponse = (_req, socket, statusCode, statusMessage, headers) => {
	if (socket.destroyed || !socket.writable) {
		return;
	}

	const responseHeaders = Object.assign({
		"Connection": "Close",
		"Proxy-agent": PROXY_AGENT
	}, headers);

	const headerLines = Object.keys(responseHeaders).map((name) => {
		return name + ": " + responseHeaders[name];
	});

	// Strip CR/LF from the status message so it can't split the response.
	const safeMessage = String(statusMessage).replace(/[\r\n]/g, " ");

	socket.write(
		"HTTP/1.1 " + statusCode + " " + safeMessage + "\r\n" +
		headerLines.join("\r\n") + "\r\n\r\n"
	);
};

/**
 * Create a forward proxy server
 * @param {http.Server} [httpServerOptional] - Existing HTTP server to wrap (creates new if omitted)
 * @returns {object} Server with `on("connection", handler)` and `http` property
 */
module.exports = (httpServerOptional) => {
	const httpServer = httpServerOptional || http.createServer();

	const server = {
		http: httpServer,

		_events: new EventEmitter(),

		/** @type {Set} Active connections */
		_connections: new Set(),

		_init: () => {
			server.http.on("connect", (req, clientSocket, head) => {
				clientSocket.pause();

				req.socket.on("error", (error) => {
					server._emitError( error);

					req.socket.destroy();
				});

				const connection = {
					/** @type {Buffer} Initial data from CONNECT request */
					_head: head,

					/** @type {net.Socket} Raw client socket */
					socket: clientSocket,

					/** @type {http.IncomingMessage} Original CONNECT request */
					request: req,

					/**
					 * Parse Basic proxy auth from Proxy-Authorization header
					 * @returns {{username: string, password: string}|undefined}
					 */
					getAuth: () => {
						const header = req.headers["proxy-authorization"];

						if(!header) {
							return undefined;
						}

						const headerTokens = header.split(" ");

						const headerType = headerTokens[0];
						const headerValue = headerTokens.slice(1).join(" ");

						if(headerType === "Basic") {
							const credentials = Buffer.from(headerValue, "base64").toString();

							const colonIndex = credentials.indexOf(":");

							if(colonIndex === -1) {
								return undefined;
							}

							const username = credentials.slice(0, colonIndex);
							const password = credentials.slice(colonIndex + 1);

							return {
								username,
								password
							};
						}
					},

					/** @returns {number} Local port */
					getPort: () => {
						return req.socket.localPort;
					},

					/** @returns {string} Local host (normalized from IPv4-mapped IPv6) */
					getHost: () => {
						return normalizeAddress(req.socket.localAddress);
					},

					/** @returns {string} Local address family */
					getAddressFamily: () => {
						return normalizeFamily(req.socket.localAddress, req.socket.localFamily);
					},

					/** @returns {number} Remote port */
					getRemotePort: () => {
						return req.socket.remotePort;
					},

					/** @returns {string} Remote host (normalized from IPv4-mapped IPv6) */
					getRemoteHost: () => {
						return normalizeAddress(req.socket.remoteAddress);
					},

					/** @returns {string} Remote address family */
					getRemoteAddressFamily: () => {
						return normalizeFamily(req.socket.remoteAddress, req.socket.remoteFamily);
					},

					/** @returns {URL} Destination URL parsed from CONNECT target */
					getDestination: () => {
						return new URL(`tcp://${req.url}`);
					},

					/**
					 * Send an HTTP error response to the client and close the connection
					 * @param {Error} error - Error with message used as status text
					 * @param {number} [statusOptional] - HTTP status code (default: 400)
					 * @param {object} [headersOptional] - Additional response headers
					 */
					error: (error, statusOptional, headersOptional) => {
						const status = statusOptional ? +statusOptional : 400;

						writeResponse(req, clientSocket, status, error.message, headersOptional);

						connection.end();
					},

					/**
					 * Bind client socket to a target socket, piping data both ways.
					 * Sends "200 Connection Established" to client before piping.
					 * @param {net.Socket} socket - Target socket to pipe to/from
					 * @param {stream.Transform} [up] - Optional transform stream for server-to-client data
					 * @param {stream.Transform} [down] - Optional transform stream for client-to-server data
					 */
					bind: (socket, up, down) => {
						if(connection._head.length > 0) {
							socket.write(connection._head);
						}

						socket.allowHalfOpen = true;
						clientSocket.allowHalfOpen = true;

						clientSocket.on("close", () => {
							socket.end();
						});

						socket.on("close", () => {
							clientSocket.end();
						});

						socket.on("end", () => {
							clientSocket.end();
						});

						clientSocket.on("end", () => {
							socket.end();
						});

						clientSocket.on("error", error => {
							if(error.code === "ECONNRESET") {
								socket.end();
								clientSocket.end();

								return;
							}

							if(error.code !== "EPIPE" && error.code !== "ERR_STREAM_WRITE_AFTER_END") {
								server._emitError( error, connection);
							}

							socket.destroy();
							clientSocket.destroy();
						});

						socket.on("error", error => {
							if(error.code !== "EPIPE" && error.code !== "ERR_STREAM_WRITE_AFTER_END") {
								server._emitError( error, connection);
							}

							socket.destroy();
							clientSocket.destroy();
						});

						writeResponse(req, clientSocket, 200, "Connection Established");

						if(up) {
							socket.pipe(up);
							up.pipe(clientSocket);
						} else {
							socket.pipe(clientSocket);
						}

						if(down) {
							clientSocket.pipe(down);
							down.pipe(socket);
						} else {
							clientSocket.pipe(socket);
						}

						clientSocket.resume();
						socket.resume();
					},

					/**
					 * End the underlying socket connection
					 * @param {...*} args - Arguments passed to socket.end()
					 */
					end: (...args) => {
						// Resume in case the socket is still paused (e.g. end() called
						// before bind()); otherwise FIN from the peer is never read and
						// the half-closed socket hangs.
						req.socket.resume();
						return req.socket.end(...args);
					},

					/** @returns {object} Connection details (local/remote host, port, address family, destination) */
					details: () => {
						return {
							localPort: connection.getPort(),
							localHost: connection.getHost(),
							localAddressFamily: connection.getAddressFamily(),

							remotePort: connection.getRemotePort(),
							remoteHost: connection.getRemoteHost(),
							remoteAddressFamily: connection.getRemoteAddressFamily(),

							destination: connection.getDestination()
						};
					}
				};

				server._connections.add(connection);

				clientSocket.on("close", () => {
					server._connections.delete(connection);
					server._events.emit("close", connection);
				});

				server._events.emit("connection", connection);
			});
		},

		/**
		 * Register an event listener
		 * @param {string} event - Event name (e.g. "connection", "close", "error")
		 * @param {function} callback - Event handler
		 */
		on: (event, callback) => {
			return server._events.on(event, callback);
		},

		/**
		 * Emit error event to listeners, or fall back to console.error
		 * @param {Error} error
		 * @param {object} [connection]
		 */
		_emitError: (error, connection) => {
			if(server._events.listenerCount("error") > 0) {
				server._events.emit("error", error, connection);
			} else {
				console.error(error);
			}
		},

		/** @returns {number} Number of active connections */
		connectionCount: () => {
			return server._connections.size;
		},

		/**
		 * Stop accepting new connections and end all active ones
		 * @param {function} [callback] - Called when all connections are closed
		 * @returns {Promise} Resolves when shutdown is complete
		 */
		close: (callback) => {
			return new Promise((resolve) => {
				server.http.close(() => {
					if(callback) {
						callback();
					}

					resolve();
				});

				server._connections.forEach((connection) => {
					connection.socket.destroy();
				});

				server._connections.clear();
				server.http.closeAllConnections();
			});
		}
	};

	server._init();

	return server;
};
