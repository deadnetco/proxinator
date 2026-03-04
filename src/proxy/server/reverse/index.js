/**
 * Reverse proxy server - accepts TCP connections and routes by SNI domain.
 * Wraps each connection in an object with address helpers, SNI parsing, and socket binding.
 */
const EventEmitter = require("events");

const net = require("net");

const sni = require("../../../utils/sni");

/** @type {number} Timeout waiting for TLS ClientHello in ms */
const SNI_TIMEOUT = 10000;
const normalizeAddress = require("../../../utils/ip").normalizeAddress;
const normalizeFamily = require("../../../utils/ip").normalizeFamily;

/**
 * Create a reverse proxy server
 * @param {net.Server} [tcpServerOptional] - Existing TCP server to wrap (creates new if omitted)
 * @returns {object} Server with `on("connection", handler)` and `tcp` property
 */
module.exports = (tcpServerOptional) => {
	const tcpServer = tcpServerOptional || net.createServer({
		pauseOnConnect: true
	});

	const server = {
		tcp: tcpServer,

		_events: new EventEmitter(),

		/** @type {Set} Active connections */
		_connections: new Set(),

		_init: () => {
			server.tcp.on("connection", (clientSocket) => {
				clientSocket.pause();

				const connection = {
					/** @type {Buffer} Buffered data received before binding */
					_head: Buffer.from([]),

					/** @type {net.Socket} Raw client socket */
					socket: clientSocket,

					/** @returns {number} Local port */
					getPort: () => {
						return clientSocket.localPort;
					},

					/** @returns {string} Local host (normalized from IPv4-mapped IPv6) */
					getHost: () => {
						return normalizeAddress(clientSocket.localAddress);
					},

					/** @returns {string} Local address family */
					getAddressFamily: () => {
						return normalizeFamily(clientSocket.localAddress, clientSocket.localFamily);
					},

					/** @returns {number} Remote port */
					getRemotePort: () => {
						return clientSocket.remotePort;
					},

					/** @returns {string} Remote host (normalized from IPv4-mapped IPv6) */
					getRemoteHost: () => {
						return normalizeAddress(clientSocket.remoteAddress);
					},

					/** @returns {string} Remote address family */
					getRemoteAddressFamily: () => {
						return normalizeFamily(clientSocket.remoteAddress, clientSocket.remoteFamily);
					},

					/**
					 * Wait for TLS ClientHello and extract SNI hostname.
					 * Resumes the socket, buffers data until a valid ClientHello is received.
					 * @returns {Promise<string|null>} SNI hostname or null
					 */
					waitSNI: () => {
						return new Promise((resolve, reject) => {
							const cleanup = () => {
								clearTimeout(timer);
								clientSocket.off("data", listener);
								clientSocket.off("close", onClose);
							};

							const timer = setTimeout(() => {
								cleanup();
								clientSocket.destroy();
								reject(new Error("SNI timeout after " + SNI_TIMEOUT + "ms"));
							}, SNI_TIMEOUT);

							const onClose = () => {
								cleanup();
								reject(new Error("Socket closed before SNI received"));
							};

							const listener = (data) => {
								connection._head = Buffer.concat([connection._head, data]);

								try {
									if(!sni.isClientHello(connection._head)) {
										return;
									}

									cleanup();

									const domain = sni.parseSNI(connection._head);

									resolve(domain);

									clientSocket.pause();
								} catch (e) {
									cleanup();
									server._emitError(e, connection);
									return;
								}
							};

							clientSocket.on("data", listener);
							clientSocket.on("close", onClose);

							clientSocket.resume();
						});
					},

					/**
					 * Bind client socket to a target socket, piping data both ways.
					 * Flushes any buffered head data to the target first.
					 * @param {net.Socket} socket - Target socket to pipe to/from
					 * @param {stream.Transform} [up] - Optional transform stream for server-to-client data
					 * @param {stream.Transform} [down] - Optional transform stream for client-to-server data
					 */
					bind: (socket, up, down) => {
						if(connection._head.length > 0) {
							socket.write(connection._head);
						}

						clientSocket.on("close", () => {
							socket.end();
						});

						socket.on("close", () => {
							clientSocket.end();
						});

						clientSocket.on("error", error => {
							if(error.code === "ECONNRESET") {
								socket.end();
								clientSocket.end();

								return;
							}

							server._emitError( error, connection);
						});

						socket.on("error", error => {
							server._emitError( error, connection);
						});

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
					 * Send an error to the client and close the connection.
					 * Reverse proxy has no protocol-level error response, so this just ends the socket.
					 * @param {Error} error - Error (unused, kept for API consistency with forward/socks5 servers)
					 */
					error: () => {
						clientSocket.end();
					},

					/**
					 * End the underlying socket connection
					 * @param {...*} args - Arguments passed to socket.end()
					 */
					end: (...args) => {
						return clientSocket.end(...args);
					},

					/** @returns {object} Connection details (local/remote host, port, address family) */
					details: () => {
						return {
							localPort: connection.getPort(),
							localHost: connection.getHost(),
							localAddressFamily: connection.getAddressFamily(),

							remotePort: connection.getRemotePort(),
							remoteHost: connection.getRemoteHost(),
							remoteAddressFamily: connection.getRemoteAddressFamily()
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
				server.tcp.close(() => {
					if(callback) {
						callback();
					}

					resolve();
				});

				server._connections.forEach((connection) => {
					connection.socket.destroy();
				});

				server._connections.clear();
			});
		}
	};

	server._init();

	return server;
};
