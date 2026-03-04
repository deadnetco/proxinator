const assert = require("assert");
const http = require("http");
const net = require("net");
const createAgent = require("../../../src/proxy/client/agent");

describe("Proxy Agent", () => {
	let servers = [];

	/**
	 * Create a mock HTTP CONNECT proxy that actually forwards traffic
	 * @returns {http.Server}
	 */
	const createForwardingProxy = () => {
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

	afterEach(() => {
		servers.forEach((server) => {
			if (server.closeAllConnections) {
				server.closeAllConnections();
			}
			server.close(() => {});
		});
		servers = [];
	});

	it("should tunnel HTTP request through proxy chain", (done) => {
		const targetServer = http.createServer((req, res) => {
			res.writeHead(200);
			res.end("hello from target");
		});
		servers.push(targetServer);

		const proxy = createForwardingProxy();

		targetServer.listen(0, () => {
			proxy.listen(0, () => {
				const proxyUrl = new URL("http://127.0.0.1:" + proxy.address().port);
				const agent = createAgent([proxyUrl]);

				const req = http.request({
					host: "127.0.0.1",
					port: targetServer.address().port,
					path: "/test",
					agent: agent
				}, (res) => {
					let body = "";
					res.on("data", (chunk) => {
						body += chunk;
					});
					res.on("end", () => {
						assert.strictEqual(res.statusCode, 200);
						assert.strictEqual(body, "hello from target");
						agent.destroy();
						done();
					});
				});

				req.on("error", done);
				req.end();
			});
		});
	});

	it("should work with empty proxy chain (direct connection)", (done) => {
		const targetServer = http.createServer((req, res) => {
			res.writeHead(200);
			res.end("direct");
		});
		servers.push(targetServer);

		targetServer.listen(0, () => {
			const agent = createAgent([]);

			const req = http.request({
				host: "127.0.0.1",
				port: targetServer.address().port,
				path: "/",
				agent: agent
			}, (res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => {
					assert.strictEqual(body, "direct");
					agent.destroy();
					done();
				});
			});

			req.on("error", done);
			req.end();
		});
	});

	it("should transform connect target via options.connect", (done) => {
		const targetServer = http.createServer((req, res) => {
			res.writeHead(200);
			res.end("connected");
		});
		servers.push(targetServer);

		const proxy = createForwardingProxy();
		let connectTarget = null;

		targetServer.listen(0, () => {
			proxy.listen(0, () => {
				const proxyUrl = new URL("http://127.0.0.1:" + proxy.address().port);
				const targetPort = targetServer.address().port;

				const agent = createAgent([proxyUrl], {
					connect: (host, port) => {
						connectTarget = { host, port };
						// Transform to a different hostname but same port
						return Promise.resolve(new URL("tcp://127.0.0.1:" + port));
					}
				});

				const req = http.request({
					host: "127.0.0.1",
					port: targetPort,
					path: "/test",
					agent: agent
				}, (res) => {
					let body = "";
					res.on("data", (chunk) => {
						body += chunk;
					});
					res.on("end", () => {
						assert.strictEqual(res.statusCode, 200);
						assert.strictEqual(body, "connected");
						assert.strictEqual(connectTarget.host, "127.0.0.1");
						assert.strictEqual(connectTarget.port, targetPort);
						agent.destroy();
						done();
					});
				});

				req.on("error", done);
				req.end();
			});
		});
	});

	it("should pass family option through to chain", (done) => {
		const targetServer = http.createServer((req, res) => {
			res.writeHead(200);
			res.end("family test");
		});
		servers.push(targetServer);

		const proxy = createForwardingProxy();

		targetServer.listen(0, "127.0.0.1", () => {
			proxy.listen(0, "127.0.0.1", () => {
				const proxyUrl = new URL("http://127.0.0.1:" + proxy.address().port);
				const agent = createAgent([proxyUrl], { family: 4 });

				const req = http.request({
					host: "127.0.0.1",
					port: targetServer.address().port,
					path: "/test",
					agent: agent
				}, (res) => {
					let body = "";
					res.on("data", (chunk) => {
						body += chunk;
					});
					res.on("end", () => {
						assert.strictEqual(res.statusCode, 200);
						assert.strictEqual(body, "family test");
						agent.destroy();
						done();
					});
				});

				req.on("error", done);
				req.end();
			});
		});
	});

	it("should tunnel through multiple proxies", (done) => {
		const targetServer = http.createServer((req, res) => {
			res.writeHead(200);
			res.end("multi-hop");
		});
		servers.push(targetServer);

		const proxyA = createForwardingProxy();
		const proxyB = createForwardingProxy();

		targetServer.listen(0, () => {
			proxyA.listen(0, () => {
				proxyB.listen(0, () => {
					const chain = [
						new URL("http://127.0.0.1:" + proxyA.address().port),
						new URL("http://127.0.0.1:" + proxyB.address().port)
					];
					const agent = createAgent(chain);

					const req = http.request({
						host: "127.0.0.1",
						port: targetServer.address().port,
						path: "/",
						agent: agent
					}, (res) => {
						let body = "";
						res.on("data", (chunk) => {
							body += chunk;
						});
						res.on("end", () => {
							assert.strictEqual(body, "multi-hop");
							agent.destroy();
							done();
						});
					});

					req.on("error", done);
					req.end();
				});
			});
		});
	});
});
