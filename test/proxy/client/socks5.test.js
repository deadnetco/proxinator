const assert = require("assert");
const net = require("net");
const socks5Client = require("../../../src/proxy/client/socks5");

/**
 * Create a minimal SOCKS5 server for testing.
 * Supports no-auth and username/password auth.
 * @param {Object} [opts] - Options
 * @param {Object} [opts.auth] - Required credentials { username, password }
 * @returns {{ server: net.Server, connections: Array }}
 */
const createSocks5Server = (opts) => {
	const options = opts || {};
	const connections = [];

	const server = net.createServer((socket) => {
		socket.on("error", () => {});

		socket.once("data", (greeting) => {
			const nmethods = greeting[1];
			const methods = [];

			for (let i = 0; i < nmethods; i++) {
				methods.push(greeting[2 + i]);
			}

			if (options.auth) {
				// Require username/password auth (method 0x02)
				socket.write(Buffer.from([0x05, 0x02]));

				socket.once("data", (authData) => {
					const ulen = authData[1];
					const username = authData.slice(2, 2 + ulen).toString();
					const plen = authData[2 + ulen];
					const password = authData.slice(3 + ulen, 3 + ulen + plen).toString();

					if (username === options.auth.username && password === options.auth.password) {
						socket.write(Buffer.from([0x01, 0x00])); // success
						handleRequest(socket, connections);
					} else {
						socket.write(Buffer.from([0x01, 0x01])); // failure
						// Delay end so socks library processes the auth failure cleanly
						setTimeout(() => {
							socket.end();
						}, 50);
					}
				});
			} else {
				// No auth (method 0x00)
				socket.write(Buffer.from([0x05, 0x00]));
				handleRequest(socket, connections);
			}
		});
	});

	return { server, connections };
};

/**
 * Handle SOCKS5 CONNECT request
 * @param {net.Socket} socket - Client socket
 * @param {Array} connections - Track connection details
 */
const handleRequest = (socket, connections) => {
	socket.once("data", (request) => {
		const cmd = request[1];
		const addrType = request[3];
		let host;
		let portOffset;

		if (addrType === 0x01) {
			// IPv4
			host = request[4] + "." + request[5] + "." + request[6] + "." + request[7];
			portOffset = 8;
		} else if (addrType === 0x03) {
			// Domain
			const domainLen = request[4];
			host = request.slice(5, 5 + domainLen).toString();
			portOffset = 5 + domainLen;
		}

		const port = request.readUInt16BE(portOffset);

		connections.push({ cmd, host, port });

		if (cmd === 0x01) {
			// CONNECT - connect to target
			const target = net.connect({ port: port, host: host }, () => {
				// Reply with success (bind to 0.0.0.0:0)
				const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
				socket.write(reply);

				target.pipe(socket);
				socket.pipe(target);
			});

			target.on("error", () => {
				// Reply with host unreachable
				const reply = Buffer.from([0x05, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
				socket.write(reply);
				socket.end();
			});
		}
	});
};

describe("SOCKS5 Proxy Client", () => {
	let servers = [];

	afterEach(() => {
		servers.forEach((server) => {
			if (server.closeAllConnections) {
				server.closeAllConnections();
			}
			server.close(() => {});
		});
		servers = [];
	});

	it("should tunnel through a SOCKS5 proxy", (done) => {
		const testData = "hello through socks5";

		const target = net.createServer((socket) => {
			socket.write(testData);
		});
		servers.push(target);

		const socks = createSocks5Server();
		servers.push(socks.server);

		target.listen(0, () => {
			socks.server.listen(0, () => {
				const socksPort = socks.server.address().port;
				const targetPort = target.address().port;
				const proxyUrl = new URL("socks5://127.0.0.1:" + socksPort);
				const targetUrl = new URL("tcp://127.0.0.1:" + targetPort);

				socks5Client(proxyUrl, targetUrl).then((socket) => {
					socket.on("data", (data) => {
						assert.strictEqual(data.toString(), testData);
						socket.destroy();
						done();
					});
				});
			});
		});
	});

	it("should send auth when credentials provided", (done) => {
		const testData = "authenticated";

		const target = net.createServer((socket) => {
			socket.write(testData);
		});
		servers.push(target);

		const socks = createSocks5Server({ auth: { username: "user", password: "pass" } });
		servers.push(socks.server);

		target.listen(0, () => {
			socks.server.listen(0, () => {
				const socksPort = socks.server.address().port;
				const targetPort = target.address().port;
				const proxyUrl = new URL("socks5://user:pass@127.0.0.1:" + socksPort);
				const targetUrl = new URL("tcp://127.0.0.1:" + targetPort);

				socks5Client(proxyUrl, targetUrl).then((socket) => {
					socket.on("data", (data) => {
						assert.strictEqual(data.toString(), testData);
						socket.destroy();
						done();
					});
				});
			});
		});
	});

	it("should send SOCKS handshake over pre-existing socket", (done) => {
		const testData = "through existing socket";

		const target = net.createServer((socket) => {
			socket.write(testData);
		});
		servers.push(target);

		const socks = createSocks5Server();
		servers.push(socks.server);

		target.listen(0, () => {
			socks.server.listen(0, () => {
				const socksPort = socks.server.address().port;
				const targetPort = target.address().port;
				const proxyUrl = new URL("socks5://127.0.0.1:" + socksPort);
				const targetUrl = new URL("tcp://127.0.0.1:" + targetPort);

				const existingSocket = net.connect({ port: socksPort, host: "127.0.0.1" });
				existingSocket.on("error", () => {});

				existingSocket.once("connect", () => {
					socks5Client(proxyUrl, targetUrl, { socket: existingSocket }).then((socket) => {
						socket.on("data", (data) => {
							assert.strictEqual(data.toString(), testData);
							socket.destroy();
							done();
						});
					}).catch(done);
				});
			});
		});
	});

	it("should resolve hostname through proxy (domain address type)", (done) => {
		const socks = createSocks5Server();
		servers.push(socks.server);

		const target = net.createServer((socket) => {
			socket.write("resolved");
		});
		servers.push(target);

		target.listen(0, () => {
			socks.server.listen(0, () => {
				const socksPort = socks.server.address().port;
				const targetPort = target.address().port;
				const proxyUrl = new URL("socks5://127.0.0.1:" + socksPort);
				const targetUrl = new URL("tcp://localhost:" + targetPort);

				socks5Client(proxyUrl, targetUrl).then((socket) => {
					socket.on("data", (data) => {
						assert.strictEqual(data.toString(), "resolved");
						assert.strictEqual(socks.connections[0].host, "localhost");
						socket.destroy();
						done();
					});
				});
			});
		});
	});

	it("should reject on auth failure", (done) => {
		const socks = createSocks5Server({ auth: { username: "user", password: "pass" } });
		servers.push(socks.server);

		socks.server.listen(0, () => {
			const socksPort = socks.server.address().port;
			const proxyUrl = new URL("socks5://wrong:creds@127.0.0.1:" + socksPort);
			const targetUrl = new URL("tcp://example.com:443");

			socks5Client(proxyUrl, targetUrl).then(() => {
				done(new Error("Should have rejected"));
			}).catch((error) => {
				assert.ok(error);
				done();
			});
		});
	});
});
