/**
 * SOCKS5 proxy server - handles SOCKS5 CONNECT requests.
 * Wraps each connection with auth parsing, destination info, and socket binding.
 *
 * Protocol flow:
 * 1. Greeting: client sends version + auth methods → server responds with chosen method
 * 2. Auth (optional): username/password subnegotiation
 * 3. Request: client sends CONNECT command + address → server emits "connection"
 */
const EventEmitter = require("events");
const net = require("net");
const normalizeAddress = require("../../../utils/ip").normalizeAddress;
const normalizeFamily = require("../../../utils/ip").normalizeFamily;

/** @type {number} Timeout for SOCKS5 handshake (greeting + auth + request) in ms */
const HANDSHAKE_TIMEOUT = 30000;

/** @type {number} SOCKS5 protocol version */
const SOCKS_VERSION = 0x05;

/** @type {number} No authentication required */
const AUTH_NONE = 0x00;

/** @type {number} Username/password authentication */
const AUTH_USERPASS = 0x02;

/** @type {number} No acceptable methods */
const AUTH_NO_ACCEPTABLE = 0xFF;

/** @type {number} CONNECT command */
const CMD_CONNECT = 0x01;

/** @type {number} IPv4 address type */
const ATYP_IPV4 = 0x01;

/** @type {number} Domain name address type */
const ATYP_DOMAIN = 0x03;

/** @type {number} IPv6 address type */
const ATYP_IPV6 = 0x04;

/**
 * Build a SOCKS5 reply buffer
 * @param {number} rep - Reply code (0x00 = success, 0x01 = general failure, etc.)
 * @returns {Buffer}
 */
const buildReply = (rep) => {
	// VER, REP, RSV, ATYP(IPv4), BND.ADDR(0.0.0.0), BND.PORT(0)
	return Buffer.from([SOCKS_VERSION, rep, 0x00, ATYP_IPV4, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
};

/** @type {number} Minimum SOCKS5 request size: VER + CMD + RSV + ATYP + IPv4(4) + PORT(2) */
const MIN_REQUEST_SIZE = 10;

/** @type {number} Minimum auth subnegotiation size: VER + ULEN + (1 char) + PLEN + (1 char) */
const MIN_AUTH_SIZE = 5;

/**
 * Parse destination address from SOCKS5 request buffer
 * @param {Buffer} data - Request buffer (full SOCKS5 request)
 * @returns {{ host: string, port: number, atyp: number }|null} Parsed address or null if malformed
 */
const parseAddress = (data) => {
	if (data.length < MIN_REQUEST_SIZE) {
		return null;
	}

	const atyp = data[3];
	let host;
	let portOffset;

	if (atyp === ATYP_IPV4) {
		host = data[4] + "." + data[5] + "." + data[6] + "." + data[7];
		portOffset = 8;
	} else if (atyp === ATYP_DOMAIN) {
		const domainLen = data[4];

		if (data.length < 5 + domainLen + 2) {
			return null;
		}

		host = data.slice(5, 5 + domainLen).toString();
		portOffset = 5 + domainLen;
	} else if (atyp === ATYP_IPV6) {
		if (data.length < 22) {
			return null;
		}

		const parts = [];
		for (let i = 0; i < 8; i++) {
			parts.push(data.readUInt16BE(4 + i * 2).toString(16));
		}
		host = parts.join(":");
		portOffset = 20;
	} else {
		return null;
	}

	const port = data.readUInt16BE(portOffset);

	return { host, port, atyp };
};

/**
 * Parse username/password from SOCKS5 auth subnegotiation buffer
 * @param {Buffer} data - Auth subnegotiation buffer
 * @returns {{ username: string, password: string }|null} Parsed credentials or null if malformed
 */
const parseAuth = (data) => {
	if (data.length < MIN_AUTH_SIZE) {
		return null;
	}

	const ulen = data[1];

	if (data.length < 3 + ulen) {
		return null;
	}

	const username = data.slice(2, 2 + ulen).toString();
	const plen = data[2 + ulen];

	if (data.length < 3 + ulen + plen) {
		return null;
	}

	const password = data.slice(3 + ulen, 3 + ulen + plen).toString();

	return { username, password };
};

/**
 * Create a SOCKS5 proxy server
 * @param {net.Server} [tcpServerOptional] - Existing TCP server to wrap (creates new if omitted)
 * @param {Object} [options] - Optional settings
 * @param {Function} [options.authenticate] - Auth validator: ({username, password, remoteAddress, remotePort, localAddress, localPort}) => Promise<boolean>|boolean. Called for every connection. Credentials are undefined when client uses no-auth. When omitted, accepts all connections.
 * @returns {object} Server with `on("connection", handler)` and `tcp` property
 */
module.exports = (tcpServerOptional, options) => {
	const opts = options || {};
	const tcpServer = tcpServerOptional || net.createServer({
		pauseOnConnect: true
	});

	const server = {
		tcp: tcpServer,

		_events: new EventEmitter(),

		/** @type {Set} Active connections */
		_connections: new Set(),

		/** @type {Set} Sockets still in handshake phase (not yet promoted to _connections) */
		_handshaking: new Set(),

		_init: () => {
			server.tcp.on("connection", (clientSocket) => {
				clientSocket.pause();

				server._handshaking.add(clientSocket);

				clientSocket.on("error", (error) => {
					server._emitError(error);
				});

				const handshakeTimer = setTimeout(() => {
					clientSocket.destroy(new Error("SOCKS5 handshake timeout after " + HANDSHAKE_TIMEOUT + "ms"));
				}, HANDSHAKE_TIMEOUT);

				clientSocket.on("close", () => {
					clearTimeout(handshakeTimer);
					server._handshaking.delete(clientSocket);
				});

				let auth;

				/**
				 * Handle SOCKS5 CONNECT request after auth is complete
				 */
				const handleRequest = () => {
					clientSocket.once("data", (requestData) => {
						const cmd = requestData[1];

						if (cmd !== CMD_CONNECT) {
							clientSocket.write(buildReply(0x07)); // Command not supported
							clientSocket.end();
							return;
						}

						const address = parseAddress(requestData);

						if (!address) {
							clientSocket.write(buildReply(0x01)); // General failure
							clientSocket.end();
							return;
						}

						const connection = {
							/** @type {net.Socket} Raw client socket */
							socket: clientSocket,

							/**
							 * Get parsed auth credentials
							 * @returns {{username: string, password: string}|undefined}
							 */
							getAuth: () => {
								return auth;
							},

							/** @returns {URL} Destination URL parsed from SOCKS5 address */
							getDestination: () => {
								if (address.atyp === ATYP_IPV6) {
									return new URL("tcp://[" + address.host + "]:" + address.port);
								}

								return new URL("tcp://" + address.host + ":" + address.port);
							},

							/**
							 * Send SOCKS5 success reply and pipe data both ways
							 * @param {net.Socket} socket - Target socket to pipe to/from
							 * @param {stream.Transform} [up] - Optional transform stream for server-to-client data
							 * @param {stream.Transform} [down] - Optional transform stream for client-to-server data
							 */
							bind: (socket, up, down) => {
								clientSocket.write(buildReply(0x00));

								clientSocket.on("close", () => {
									socket.end();
								});

								socket.on("close", () => {
									clientSocket.end();
								});

								clientSocket.on("error", (error) => {
									if (error.code === "ECONNRESET") {
										socket.end();
										clientSocket.end();

										return;
									}

									server._emitError(error, connection);
								});

								socket.on("error", (error) => {
									server._emitError(error, connection);
								});

								if (up) {
									socket.pipe(up);
									up.pipe(clientSocket);
								} else {
									socket.pipe(clientSocket);
								}

								if (down) {
									clientSocket.pipe(down);
									down.pipe(socket);
								} else {
									clientSocket.pipe(socket);
								}

								clientSocket.resume();
								socket.resume();
							},

							/**
							 * Send SOCKS5 failure reply and end the connection
							 * @param {Error} error - Error (unused, kept for API consistency with forward server)
							 */
							error: () => {
								clientSocket.write(buildReply(0x01)); // General failure
								clientSocket.end();
							},

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
							 * End the underlying socket connection
							 * @param {...*} args - Arguments passed to socket.end()
							 */
							end: (...args) => {
								return clientSocket.end(...args);
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

						clearTimeout(handshakeTimer);
						server._handshaking.delete(clientSocket);

						server._connections.add(connection);

						clientSocket.on("close", () => {
							server._connections.delete(connection);
							server._events.emit("close", connection);
						});

						server._events.emit("connection", connection);
					});

					clientSocket.resume();
				};

				/**
				 * Handle SOCKS5 greeting (version + auth methods)
				 */
				clientSocket.once("data", (greeting) => {
					if (greeting[0] !== SOCKS_VERSION) {
						clientSocket.end();
						return;
					}

					const nmethods = greeting[1];
					const methods = [];

					for (let i = 0; i < nmethods; i++) {
						methods.push(greeting[2 + i]);
					}

					const socketInfo = {
						remoteAddress: normalizeAddress(clientSocket.remoteAddress),
						remotePort: clientSocket.remotePort,
						localAddress: normalizeAddress(clientSocket.localAddress),
						localPort: clientSocket.localPort
					};

					if (methods.indexOf(AUTH_USERPASS) !== -1) {
						// Offer username/password auth
						clientSocket.write(Buffer.from([SOCKS_VERSION, AUTH_USERPASS]));

						clientSocket.once("data", (authData) => {
							const credentials = parseAuth(authData);

							if (!credentials) {
								clientSocket.write(Buffer.from([0x01, 0x01])); // Auth failure
								clientSocket.end();
								return;
							}

							const authInfo = Object.assign({}, credentials, socketInfo);

							const check = opts.authenticate
								? opts.authenticate(authInfo)
								: Promise.resolve(true);

							Promise.resolve(check).then((valid) => {
								if (!valid) {
									clientSocket.write(Buffer.from([0x01, 0x01])); // Auth failure
									clientSocket.end();
									return;
								}

								auth = credentials;

								// Auth success
								clientSocket.write(Buffer.from([0x01, 0x00]));

								handleRequest();
							}).catch((error) => {
								server._emitError(error);
								clientSocket.end();
							});
						});
					} else if (methods.indexOf(AUTH_NONE) !== -1) {
						// No auth
						clientSocket.write(Buffer.from([SOCKS_VERSION, AUTH_NONE]));

						if (opts.authenticate) {
							const authInfo = Object.assign({}, socketInfo);

							Promise.resolve(opts.authenticate(authInfo)).then((valid) => {
								if (!valid) {
									clientSocket.end();
									return;
								}

								handleRequest();
							}).catch((error) => {
								server._emitError(error);
								clientSocket.end();
							});
						} else {
							handleRequest();
						}
					} else {
						// No acceptable methods
						clientSocket.write(Buffer.from([SOCKS_VERSION, AUTH_NO_ACCEPTABLE]));
						clientSocket.end();
					}
				});

				clientSocket.resume();
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
			if (server._events.listenerCount("error") > 0) {
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
					if (callback) {
						callback();
					}

					resolve();
				});

				server._handshaking.forEach((socket) => {
					socket.destroy();
				});

				server._handshaking.clear();

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
