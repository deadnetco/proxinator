const assert = require("assert");
const net = require("net");
const tls = require("tls");
const createReverseServer = require("../../../src/proxy/server/reverse");

describe("Reverse Proxy Server", () => {
	let proxy;

	afterEach((done) => {
		if (proxy && proxy.tcp.listening) {
			proxy.tcp.close(done);
		} else {
			done();
		}
	});

	it("should create a server with tcp property", () => {
		proxy = createReverseServer();
		assert.ok(proxy.tcp);
		assert.ok(typeof proxy.on === "function");
	});

	it("should wrap an existing tcp server", () => {
		const tcpServer = net.createServer({ pauseOnConnect: true });
		proxy = createReverseServer(tcpServer);
		assert.strictEqual(proxy.tcp, tcpServer);
	});

	it("should emit connection on TCP connect", (done) => {
		proxy = createReverseServer();

		proxy.on("connection", (connection) => {
			assert.ok(connection.socket);
			assert.ok(typeof connection.getPort === "function");
			assert.ok(typeof connection.getHost === "function");
			assert.ok(typeof connection.getRemotePort === "function");
			assert.ok(typeof connection.getRemoteHost === "function");
			assert.ok(typeof connection.waitSNI === "function");
			assert.ok(typeof connection.bind === "function");
			assert.ok(typeof connection.error === "function");
			assert.ok(typeof connection.end === "function");
			assert.ok(typeof connection.details === "function");

			connection.socket.destroy();
			done();
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;
			const client = net.connect({ port: port, host: "127.0.0.1" });
			client.on("error", () => {});
		});
	});

	it("should bind client socket to target socket", (done) => {
		proxy = createReverseServer();
		const testData = "hello from target";

		proxy.on("connection", (connection) => {
			const targetServer = net.createServer((targetSocket) => {
				targetSocket.write(testData);
			});

			targetServer.listen(0, () => {
				const targetPort = targetServer.address().port;
				const target = net.connect({ port: targetPort, host: "127.0.0.1" });

				target.on("connect", () => {
					connection.bind(target);
				});

				target.on("error", () => {});
			});
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;
			const client = net.connect({ port: port, host: "127.0.0.1" });

			client.on("data", (data) => {
				assert.strictEqual(data.toString(), testData);
				client.destroy();
				done();
			});

			client.on("error", () => {});
		});
	});

	it("should reject waitSNI when SNI parsing throws", function (done) {
		this.timeout(3000);

		const sni = require("../../../src/utils/sni");
		const originalParseSNI = sni.parseSNI;
		sni.parseSNI = () => {
			throw new Error("parse boom");
		};

		proxy = createReverseServer();

		// Absorb the _emitError fallback so it doesn't leak to stderr
		proxy.on("error", () => {});

		proxy.on("connection", (connection) => {
			const hangTimer = setTimeout(() => {
				sni.parseSNI = originalParseSNI;
				connection.socket.destroy();
				done(new Error("waitSNI promise never settled"));
			}, 1500);

			connection.waitSNI().then((hostname) => {
				clearTimeout(hangTimer);
				sni.parseSNI = originalParseSNI;
				connection.socket.destroy();
				done(new Error("waitSNI resolved unexpectedly with " + hostname));
			}).catch((error) => {
				clearTimeout(hangTimer);
				sni.parseSNI = originalParseSNI;
				connection.socket.destroy();
				try {
					assert.strictEqual(error.message, "parse boom");
					done();
				} catch (assertionError) {
					done(assertionError);
				}
			});
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			// Minimal buffer that passes isClientHello: byte 0 = 22, byte 1 = 0x03, byte 5 = 0x01
			const fakeClientHello = Buffer.alloc(16);
			fakeClientHello[0] = 22;
			fakeClientHello[1] = 0x03;
			fakeClientHello[5] = 0x01;

			const client = net.connect({ port: port, host: "127.0.0.1" }, () => {
				client.write(fakeClientHello);
			});
			client.on("error", () => {});
		});
	});

	it("should extract SNI hostname via waitSNI", (done) => {
		proxy = createReverseServer();

		proxy.on("connection", (connection) => {
			connection.waitSNI().then((hostname) => {
				assert.strictEqual(hostname, "test.example.com");
				connection.socket.destroy();
				done();
			});
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;
			const socket = tls.connect({
				port: port,
				host: "127.0.0.1",
				servername: "test.example.com",
				rejectUnauthorized: false
			});
			socket.on("error", () => {});
		});
	});

	it("should flush buffered head data when binding", (done) => {
		proxy = createReverseServer();
		const testData = "raw head data";
		let extraServer;

		proxy.on("connection", (connection) => {
			// Manually set head data to simulate buffered data
			connection._head = Buffer.from(testData);

			extraServer = net.createServer((targetSocket) => {
				targetSocket.on("data", (data) => {
					assert.strictEqual(data.toString(), testData);
					targetSocket.destroy();
					connection.socket.destroy();
					extraServer.close(() => {});
					done();
				});
			});

			extraServer.listen(0, () => {
				const targetPort = extraServer.address().port;
				const target = net.connect({ port: targetPort, host: "127.0.0.1" });

				target.on("connect", () => {
					connection.bind(target);
				});

				target.on("error", () => {});
			});
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;
			const client = net.connect({ port: port, host: "127.0.0.1" });
			client.on("error", () => {});
		});
	});

	it("should end target when client closes", (done) => {
		proxy = createReverseServer();
		let extraServer;

		proxy.on("connection", (connection) => {
			extraServer = net.createServer((targetSocket) => {
				targetSocket.on("close", () => {
					extraServer.close(() => {});
					done();
				});
				targetSocket.on("error", () => {});
			});

			extraServer.listen(0, () => {
				const targetPort = extraServer.address().port;
				const target = net.connect({ port: targetPort, host: "127.0.0.1" });

				target.on("connect", () => {
					connection.bind(target);

					setTimeout(() => {
						connection.socket.destroy();
					}, 50);
				});

				target.on("error", () => {});
			});
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;
			const client = net.connect({ port: port, host: "127.0.0.1" });
			client.on("error", () => {});
		});
	});

	it("should end client when target closes", (done) => {
		proxy = createReverseServer();
		let extraServer;

		proxy.on("connection", (connection) => {
			extraServer = net.createServer((targetSocket) => {
				setTimeout(() => {
					targetSocket.destroy();
				}, 50);
			});

			extraServer.listen(0, () => {
				const targetPort = extraServer.address().port;
				const target = net.connect({ port: targetPort, host: "127.0.0.1" });

				target.on("connect", () => {
					connection.bind(target);
				});

				target.on("error", () => {});
			});
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;
			const client = net.connect({ port: port, host: "127.0.0.1" });
			client.on("close", () => {
				extraServer.close(() => {});
				done();
			});
			client.on("error", () => {});
		});
	});

	it("should end connection via end()", (done) => {
		proxy = createReverseServer();

		proxy.on("connection", (connection) => {
			connection.socket.resume();
			connection.end();
		});

		proxy.on("close", () => {
			assert.strictEqual(proxy.connectionCount(), 0);
			done();
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;
			const client = net.connect({ port: port, host: "127.0.0.1" });
			client.on("error", () => {});
		});
	});

	it("should end connection via error()", (done) => {
		proxy = createReverseServer();

		proxy.on("connection", (connection) => {
			connection.socket.resume();
			connection.error(new Error("test error"));
		});

		proxy.on("close", () => {
			assert.strictEqual(proxy.connectionCount(), 0);
			done();
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;
			const client = net.connect({ port: port, host: "127.0.0.1" });
			client.on("error", () => {});
		});
	});

	it("should bind with up transform stream", (done) => {
		const { Transform } = require("stream");
		proxy = createReverseServer();
		const testData = "hello from target";
		const prefix = "UP:";
		let extraServer;

		proxy.on("connection", (connection) => {
			extraServer = net.createServer((targetSocket) => {
				setTimeout(() => {
					targetSocket.write(testData);
				}, 50);
			});

			extraServer.listen(0, () => {
				const targetPort = extraServer.address().port;
				const target = net.connect({ port: targetPort, host: "127.0.0.1" });

				const upTransform = new Transform({
					transform(chunk, encoding, callback) {
						callback(null, Buffer.concat([Buffer.from(prefix), chunk]));
					}
				});

				target.on("connect", () => {
					connection.bind(target, upTransform);
				});

				target.on("error", () => {});
			});
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;
			const client = net.connect({ port: port, host: "127.0.0.1" });

			client.on("data", (data) => {
				assert.strictEqual(data.toString(), prefix + testData);
				client.destroy();
				extraServer.close(() => {});
				done();
			});

			client.on("error", () => {});
		});
	});

	it("should bind with down transform stream", (done) => {
		const { Transform } = require("stream");
		proxy = createReverseServer();
		const testData = "hello from client";
		const prefix = "DOWN:";
		let extraServer;

		proxy.on("connection", (connection) => {
			extraServer = net.createServer((targetSocket) => {
				targetSocket.on("data", (data) => {
					assert.strictEqual(data.toString(), prefix + testData);
					targetSocket.destroy();
					extraServer.close(() => {});
					done();
				});
			});

			extraServer.listen(0, () => {
				const targetPort = extraServer.address().port;
				const target = net.connect({ port: targetPort, host: "127.0.0.1" });

				const downTransform = new Transform({
					transform(chunk, encoding, callback) {
						callback(null, Buffer.concat([Buffer.from(prefix), chunk]));
					}
				});

				target.on("connect", () => {
					connection.bind(target, null, downTransform);
				});

				target.on("error", () => {});
			});
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;
			const client = net.connect({ port: port, host: "127.0.0.1" });

			client.on("connect", () => {
				setTimeout(() => {
					client.write(testData);
				}, 50);
			});

			client.on("error", () => {});
		});
	});

	it("should return connection details", (done) => {
		proxy = createReverseServer();

		proxy.on("connection", (connection) => {
			const details = connection.details();
			assert.ok(details.localPort);
			assert.ok(details.localHost);
			assert.ok(details.localAddressFamily);
			assert.ok(details.remotePort);
			assert.ok(details.remoteHost);
			assert.ok(details.remoteAddressFamily);

			connection.socket.destroy();
			done();
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;
			const client = net.connect({ port: port, host: "127.0.0.1" });
			client.on("error", () => {});
		});
	});

	it("should gracefully close all connections", (done) => {
		proxy = createReverseServer();

		proxy.on("connection", () => {
			assert.strictEqual(proxy.connectionCount(), 1);
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;
			const client = net.connect({ port: port, host: "127.0.0.1" });
			client.on("error", () => {});

			setTimeout(() => {
				proxy.close().then(() => {
					assert.strictEqual(proxy.connectionCount(), 0);
					proxy = null;
					done();
				});
			}, 50);
		});
	});

	it("should track connection count", (done) => {
		proxy = createReverseServer();

		proxy.on("connection", (connection) => {
			assert.strictEqual(proxy.connectionCount(), 1);
			connection.socket.destroy();
		});

		proxy.on("close", () => {
			assert.strictEqual(proxy.connectionCount(), 0);
			done();
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;
			const client = net.connect({ port: port, host: "127.0.0.1" });
			client.on("error", () => {});
		});
	});
});
