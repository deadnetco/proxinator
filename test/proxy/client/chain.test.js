const assert = require("assert");
const http = require("http");
const net = require("net");
const chainClient = require("../../../src/proxy/client/chain");

describe("Chain Proxy Client", () => {
	let servers = [];

	/**
	 * Create a mock proxy that actually forwards traffic to the CONNECT target
	 * @param {Function} [cb] - Optional callback(req, clientSocket) after CONNECT response
	 */
	const createForwardingProxy = (cb) => {
		const server = http.createServer();

		server.on("connect", (req, clientSocket) => {
			const parts = req.url.split(":");
			const targetHost = parts[0];
			const targetPort = parseInt(parts[1], 10);

			const targetSocket = net.connect({ port: targetPort, host: targetHost }, () => {
				clientSocket.write(
					"HTTP/1.1 200 Connection Established\r\n" +
					"\r\n"
				);

				targetSocket.pipe(clientSocket);
				clientSocket.pipe(targetSocket);

				if (cb) {
					cb(req, clientSocket);
				}
			});

			targetSocket.on("error", () => {
				clientSocket.write(
					"HTTP/1.1 502 Bad Gateway\r\n" +
					"\r\n"
				);
				clientSocket.end();
			});
		});

		servers.push(server);

		return server;
	};

	/**
	 * Create a mock proxy that responds 200 but does not forward (for terminal hops)
	 * @param {Function} [cb] - Optional callback(req, clientSocket) after CONNECT response
	 */
	const createMockProxy = (cb) => {
		const server = http.createServer();

		server.on("connect", (req, clientSocket) => {
			clientSocket.write(
				"HTTP/1.1 200 Connection Established\r\n" +
				"\r\n"
			);

			if (cb) {
				cb(req, clientSocket);
			}
		});

		servers.push(server);

		return server;
	};

	const createTargetServer = (cb) => {
		const server = net.createServer(cb);
		servers.push(server);
		return server;
	};

	afterEach(() => {
		servers.forEach((server) => {
			if (server.closeAllConnections) {
				server.closeAllConnections();
			}
			server.close(() => {});
		});
		servers = [];
	});

	it("should fall back to reverse client when no proxies provided", (done) => {
		const testData = "direct connection";

		const target = createTargetServer((socket) => {
			socket.write(testData);
		});

		target.listen(0, () => {
			const port = target.address().port;
			const targetUrl = new URL("tcp://127.0.0.1:" + port);

			chainClient([], targetUrl).then((socket) => {
				socket.on("data", (data) => {
					assert.strictEqual(data.toString(), testData);
					socket.destroy();
					done();
				});
			});
		});
	});

	it("should tunnel through a single proxy", (done) => {
		const testData = "single hop";

		const proxy = createMockProxy((_req, clientSocket) => {
			setTimeout(() => {
				clientSocket.write(testData);
			}, 50);
		});

		proxy.listen(0, () => {
			const port = proxy.address().port;
			const proxyUrl = new URL("http://127.0.0.1:" + port);
			const targetUrl = new URL("tcp://example.com:443");

			chainClient([proxyUrl], targetUrl).then((socket) => {
				socket.on("data", (data) => {
					assert.strictEqual(data.toString(), testData);
					socket.destroy();
					done();
				});
			});
		});
	});

	it("should chain through two proxies", (done) => {
		const proxyA = createForwardingProxy();
		const proxyB = createMockProxy((_req, clientSocket) => {
			setTimeout(() => {
				clientSocket.write("chained");
			}, 50);
		});

		proxyB.listen(0, () => {
			proxyA.listen(0, () => {
				const portA = proxyA.address().port;
				const portB = proxyB.address().port;
				const proxyUrlA = new URL("http://127.0.0.1:" + portA);
				const proxyUrlB = new URL("http://127.0.0.1:" + portB);
				const targetUrl = new URL("tcp://example.com:443");

				chainClient([proxyUrlA, proxyUrlB], targetUrl).then((socket) => {
					socket.on("data", (data) => {
						assert.strictEqual(data.toString(), "chained");
						socket.destroy();
						done();
					});
				});
			});
		});
	});

	it("should destroy intermediate socket on chain failure", (done) => {
		const proxyA = createForwardingProxy();

		const proxyB = http.createServer();
		servers.push(proxyB);

		proxyB.on("connect", (_req, clientSocket) => {
			clientSocket.write(
				"HTTP/1.1 403 Forbidden\r\n" +
				"\r\n"
			);
			clientSocket.end();
		});

		proxyB.listen(0, () => {
			proxyA.listen(0, () => {
				const portA = proxyA.address().port;
				const portB = proxyB.address().port;
				const proxyUrlA = new URL("http://127.0.0.1:" + portA);
				const proxyUrlB = new URL("http://127.0.0.1:" + portB);
				const targetUrl = new URL("tcp://example.com:443");

				chainClient([proxyUrlA, proxyUrlB], targetUrl).catch((error) => {
					assert.ok(error.message.includes("403"));
					done();
				});
			});
		});
	});

	it("should reject with descriptive error for unsupported protocol", (done) => {
		const proxyUrl = new URL("ftp://127.0.0.1:1080");
		const targetUrl = new URL("tcp://example.com:443");

		chainClient([proxyUrl], targetUrl).catch((error) => {
			assert.ok(error.message.includes("Unsupported proxy protocol"));
			assert.ok(error.message.includes("ftp"));
			done();
		});
	});

	it("should send CONNECT to correct targets in chain", (done) => {
		const connectPaths = [];

		const proxyA = createForwardingProxy((req) => {
			connectPaths.push(req.url);
		});

		const proxyB = createMockProxy((req, clientSocket) => {
			connectPaths.push(req.url);
			setTimeout(() => {
				clientSocket.end();
			}, 50);
		});

		proxyB.listen(0, () => {
			proxyA.listen(0, () => {
				const portA = proxyA.address().port;
				const portB = proxyB.address().port;
				const proxyUrlA = new URL("http://127.0.0.1:" + portA);
				const proxyUrlB = new URL("http://127.0.0.1:" + portB);
				const targetUrl = new URL("tcp://example.com:443");

				chainClient([proxyUrlA, proxyUrlB], targetUrl).then((socket) => {
					socket.on("close", () => {
						// First CONNECT should target proxyB
						assert.strictEqual(connectPaths[0], "127.0.0.1:" + portB);
						// Second CONNECT should target final destination
						assert.strictEqual(connectPaths[1], "example.com:443");
						done();
					});
				});
			});
		});
	});
});
