const assert = require("assert");
const http = require("http");
const net = require("net");
const createForwardServer = require("../../../src/proxy/server/forward");

describe("Forward Proxy Server", () => {
	let proxy;
	let extraServers = [];

	afterEach((done) => {
		const cleanup = extraServers.map((s) => {
			return new Promise((resolve) => {
				if (s.listening) {
					s.close(resolve);
				} else {
					resolve();
				}
			});
		});
		extraServers = [];

		Promise.all(cleanup).then(() => {
			if (proxy && proxy.http.listening) {
				proxy.http.close(done);
			} else {
				done();
			}
		});
	});

	it("should create a server with http property", () => {
		proxy = createForwardServer();
		assert.ok(proxy.http);
		assert.ok(typeof proxy.on === "function");
	});

	it("should wrap an existing http server", () => {
		const httpServer = http.createServer();
		proxy = createForwardServer(httpServer);
		assert.strictEqual(proxy.http, httpServer);
	});

	it("should emit connection on CONNECT request", (done) => {
		proxy = createForwardServer();

		proxy.on("connection", (connection) => {
			assert.ok(connection.socket);
			assert.ok(connection.request);
			assert.ok(typeof connection.getAuth === "function");
			assert.ok(typeof connection.getDestination === "function");
			assert.ok(typeof connection.bind === "function");
			assert.ok(typeof connection.error === "function");
			assert.ok(typeof connection.end === "function");
			assert.ok(typeof connection.details === "function");

			connection.end();
			done();
		});

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();
			req.on("error", () => {});
		});
	});

	it("should parse destination from CONNECT path", (done) => {
		proxy = createForwardServer();

		proxy.on("connection", (connection) => {
			const dest = connection.getDestination();
			assert.strictEqual(dest.hostname, "example.com");
			assert.strictEqual(dest.port, "443");

			connection.end();
			done();
		});

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();
			req.on("error", () => {});
		});
	});

	it("should parse Basic proxy auth", (done) => {
		proxy = createForwardServer();

		proxy.on("connection", (connection) => {
			const auth = connection.getAuth();
			assert.deepStrictEqual(auth, {
				username: "user",
				password: "pass"
			});

			connection.end();
			done();
		});

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;
			const credentials = Buffer.from("user:pass").toString("base64");

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443",
				headers: {
					"Proxy-Authorization": "Basic " + credentials
				}
			});

			req.end();
			req.on("error", () => {});
		});
	});

	it("should return undefined auth when no header", (done) => {
		proxy = createForwardServer();

		proxy.on("connection", (connection) => {
			const auth = connection.getAuth();
			assert.strictEqual(auth, undefined);

			connection.end();
			done();
		});

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();
			req.on("error", () => {});
		});
	});

	it("should bind client socket to target socket", (done) => {
		proxy = createForwardServer();
		const testData = "hello from target";

		const targetServer = net.createServer((targetSocket) => {
			// Wait for piping to be set up before sending data
			setTimeout(() => {
				targetSocket.write(testData);
			}, 50);
		});
		extraServers.push(targetServer);

		proxy.on("connection", (connection) => {
			targetServer.listen(0, () => {
				const targetPort = targetServer.address().port;
				const target = net.connect({ port: targetPort, host: "127.0.0.1" });

				target.on("connect", () => {
					connection.bind(target);
				});

				target.on("error", () => {});
			});
		});

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();

			req.on("connect", (res, socket) => {
				assert.strictEqual(res.statusCode, 200);

				socket.on("data", (data) => {
					assert.strictEqual(data.toString(), testData);
					socket.destroy();
					done();
				});
			});

			req.on("error", () => {});
		});
	});

	it("should send error response to client", (done) => {
		proxy = createForwardServer();

		proxy.on("connection", (connection) => {
			connection.error(new Error("Unauthorized"), 407);
		});

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();

			req.on("connect", (res) => {
				assert.strictEqual(res.statusCode, 407);
				done();
			});

			req.on("error", () => {});
		});
	});

	it("should bind with up transform stream", (done) => {
		const { Transform } = require("stream");
		proxy = createForwardServer();
		const testData = "hello from target";
		const prefix = "UP:";

		const targetServer = net.createServer((targetSocket) => {
			setTimeout(() => {
				targetSocket.write(testData);
			}, 50);
		});
		extraServers.push(targetServer);

		proxy.on("connection", (connection) => {
			targetServer.listen(0, () => {
				const targetPort = targetServer.address().port;
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

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();

			req.on("connect", (res, socket) => {
				assert.strictEqual(res.statusCode, 200);

				socket.on("data", (data) => {
					assert.strictEqual(data.toString(), prefix + testData);
					socket.destroy();
					done();
				});
			});

			req.on("error", () => {});
		});
	});

	it("should bind with down transform stream", (done) => {
		const { Transform } = require("stream");
		proxy = createForwardServer();
		const testData = "hello from client";
		const prefix = "DOWN:";

		const targetServer = net.createServer((targetSocket) => {
			targetSocket.on("data", (data) => {
				assert.strictEqual(data.toString(), prefix + testData);
				targetSocket.destroy();
				done();
			});
		});
		extraServers.push(targetServer);

		proxy.on("connection", (connection) => {
			targetServer.listen(0, () => {
				const targetPort = targetServer.address().port;
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

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();

			req.on("connect", (res, socket) => {
				setTimeout(() => {
					socket.write(testData);
				}, 50);
			});

			req.on("error", () => {});
		});
	});

	it("should flush head data to target when binding", (done) => {
		proxy = createForwardServer();

		const targetServer = net.createServer((targetSocket) => {
			targetSocket.on("data", (data) => {
				assert.strictEqual(data.toString(), "head-data");
				targetSocket.destroy();
				targetServer.close(() => {});
				done();
			});
		});
		extraServers.push(targetServer);

		proxy.on("connection", (connection) => {
			// Manually set head to simulate buffered data
			connection._head = Buffer.from("head-data");

			targetServer.listen(0, () => {
				const targetPort = targetServer.address().port;
				const target = net.connect({ port: targetPort, host: "127.0.0.1" });

				target.on("connect", () => {
					connection.bind(target);
				});

				target.on("error", () => {});
			});
		});

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();
			req.on("connect", () => {});
			req.on("error", () => {});
		});
	});

	it("should end target when client closes", (done) => {
		proxy = createForwardServer();

		const targetServer = net.createServer((targetSocket) => {
			targetSocket.on("close", () => {
				targetServer.close(() => {});
				done();
			});
			targetSocket.on("error", () => {});
		});
		extraServers.push(targetServer);

		proxy.on("connection", (connection) => {
			targetServer.listen(0, () => {
				const targetPort = targetServer.address().port;
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

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();
			req.on("connect", () => {});
			req.on("error", () => {});
		});
	});

	it("should end client when target closes", (done) => {
		proxy = createForwardServer();

		const targetServer = net.createServer((targetSocket) => {
			setTimeout(() => {
				targetSocket.destroy();
			}, 50);
		});
		extraServers.push(targetServer);

		proxy.on("connection", (connection) => {
			targetServer.listen(0, () => {
				const targetPort = targetServer.address().port;
				const target = net.connect({ port: targetPort, host: "127.0.0.1" });

				target.on("connect", () => {
					connection.bind(target);
				});

				target.on("error", () => {});
			});
		});

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();

			req.on("connect", (res, socket) => {
				socket.on("close", () => {
					done();
				});
				socket.on("error", () => {});
			});

			req.on("error", () => {});
		});
	});

	it("should return connection details", (done) => {
		proxy = createForwardServer();

		proxy.on("connection", (connection) => {
			const details = connection.details();
			assert.ok(details.localPort);
			assert.ok(details.localHost);
			assert.ok(details.localAddressFamily);
			assert.ok(details.remotePort);
			assert.ok(details.remoteHost);
			assert.ok(details.remoteAddressFamily);
			assert.ok(details.destination);

			connection.end();
			done();
		});

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();
			req.on("error", () => {});
		});
	});

	it("should track connection count", (done) => {
		proxy = createForwardServer();

		proxy.on("connection", (connection) => {
			assert.strictEqual(proxy.connectionCount(), 1);
			connection.end();
		});

		proxy.on("close", () => {
			assert.strictEqual(proxy.connectionCount(), 0);
			done();
		});

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();
			req.on("error", () => {});
		});
	});

	it("should gracefully close all connections", (done) => {
		proxy = createForwardServer();

		proxy.on("connection", () => {
			assert.strictEqual(proxy.connectionCount(), 1);
		});

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();
			req.on("error", () => {});

			setTimeout(() => {
				proxy.close().then(() => {
					assert.strictEqual(proxy.connectionCount(), 0);
					proxy = null;
					done();
				});
			}, 50);
		});
	});

	it("should emit error event on socket error", (done) => {
		proxy = createForwardServer();

		proxy.on("error", (error, conn) => {
			assert.strictEqual(error.message, "test error");
			assert.ok(conn);
			conn.end();
			done();
		});

		proxy.on("connection", (connection) => {
			const targetServer = net.createServer((targetSocket) => {
				targetSocket.on("error", () => {});
			});
			extraServers.push(targetServer);

			targetServer.listen(0, () => {
				const targetPort = targetServer.address().port;
				const target = net.connect({ port: targetPort, host: "127.0.0.1" });

				target.on("connect", () => {
					connection.bind(target);

					// Emit error directly on the target socket to trigger the handler
					target.emit("error", new Error("test error"));
				});
			});
		});

		proxy.http.listen(0, () => {
			const port = proxy.http.address().port;

			const req = http.request({
				host: "127.0.0.1",
				port: port,
				method: "CONNECT",
				path: "example.com:443"
			});

			req.end();
			req.on("connect", () => {});
			req.on("error", () => {});
		});
	});
});
