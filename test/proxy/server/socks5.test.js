const assert = require("assert");
const net = require("net");
const SocksClient = require("socks").SocksClient;
const createSocks5Server = require("../../../src/proxy/server/socks5");

describe("SOCKS5 Proxy Server", () => {
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
			if (proxy && proxy.tcp.listening) {
				proxy.close().then(done);
			} else {
				done();
			}
		});
	});

	it("should create a server with tcp property", () => {
		proxy = createSocks5Server();
		assert.ok(proxy.tcp);
		assert.ok(typeof proxy.on === "function");
	});

	it("should emit connection on SOCKS5 CONNECT", (done) => {
		proxy = createSocks5Server();

		proxy.on("connection", (connection) => {
			assert.ok(connection.socket);
			assert.ok(typeof connection.getAuth === "function");
			assert.ok(typeof connection.getDestination === "function");
			assert.ok(typeof connection.bind === "function");
			assert.ok(typeof connection.error === "function");
			assert.ok(typeof connection.end === "function");
			assert.ok(typeof connection.details === "function");

			connection.end();
			done();
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			SocksClient.createConnection({
				command: "connect",
				proxy: { host: "127.0.0.1", port: port, type: 5 },
				destination: { host: "example.com", port: 443 },
				timeout: 5000
			}).catch(() => {});
		});
	});

	it("should parse destination with domain address type", (done) => {
		proxy = createSocks5Server();

		proxy.on("connection", (connection) => {
			const dest = connection.getDestination();
			assert.strictEqual(dest.hostname, "example.com");
			assert.strictEqual(dest.port, "443");

			connection.end();
			done();
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			SocksClient.createConnection({
				command: "connect",
				proxy: { host: "127.0.0.1", port: port, type: 5 },
				destination: { host: "example.com", port: 443 },
				timeout: 5000
			}).catch(() => {});
		});
	});

	it("should parse destination with IPv4 address type", (done) => {
		proxy = createSocks5Server();

		proxy.on("connection", (connection) => {
			const dest = connection.getDestination();
			assert.strictEqual(dest.hostname, "1.2.3.4");
			assert.strictEqual(dest.port, "80");

			connection.end();
			done();
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			SocksClient.createConnection({
				command: "connect",
				proxy: { host: "127.0.0.1", port: port, type: 5 },
				destination: { host: "1.2.3.4", port: 80 },
				timeout: 5000
			}).catch(() => {});
		});
	});

	it("should parse username/password auth", (done) => {
		proxy = createSocks5Server();

		proxy.on("connection", (connection) => {
			const auth = connection.getAuth();
			assert.deepStrictEqual(auth, {
				username: "user",
				password: "pass"
			});

			connection.end();
			done();
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			SocksClient.createConnection({
				command: "connect",
				proxy: {
					host: "127.0.0.1",
					port: port,
					type: 5,
					userId: "user",
					password: "pass"
				},
				destination: { host: "example.com", port: 443 },
				timeout: 5000
			}).catch(() => {});
		});
	});

	it("should return undefined auth when no-auth", (done) => {
		proxy = createSocks5Server();

		proxy.on("connection", (connection) => {
			const auth = connection.getAuth();
			assert.strictEqual(auth, undefined);

			connection.end();
			done();
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			SocksClient.createConnection({
				command: "connect",
				proxy: { host: "127.0.0.1", port: port, type: 5 },
				destination: { host: "example.com", port: 443 },
				timeout: 5000
			}).catch(() => {});
		});
	});

	it("should bind client socket to target socket", (done) => {
		proxy = createSocks5Server();
		const testData = "hello from target";

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

				target.on("connect", () => {
					connection.bind(target);
				});

				target.on("error", () => {});
			});
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			SocksClient.createConnection({
				command: "connect",
				proxy: { host: "127.0.0.1", port: port, type: 5 },
				destination: { host: "example.com", port: 443 },
				timeout: 5000
			}).then((info) => {
				info.socket.on("data", (data) => {
					assert.strictEqual(data.toString(), testData);
					info.socket.destroy();
					done();
				});
			});
		});
	});

	it("should send error response to client", (done) => {
		proxy = createSocks5Server();

		proxy.on("connection", (connection) => {
			connection.error(new Error("Something went wrong"));
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			SocksClient.createConnection({
				command: "connect",
				proxy: { host: "127.0.0.1", port: port, type: 5 },
				destination: { host: "example.com", port: 443 },
				timeout: 5000
			}).then(() => {
				done(new Error("Should have rejected"));
			}).catch((error) => {
				assert.ok(error);
				done();
			});
		});
	});

	it("should track connection count", (done) => {
		proxy = createSocks5Server();

		proxy.on("connection", (connection) => {
			assert.strictEqual(proxy.connectionCount(), 1);
			connection.end();
		});

		proxy.on("close", () => {
			assert.strictEqual(proxy.connectionCount(), 0);
			done();
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			SocksClient.createConnection({
				command: "connect",
				proxy: { host: "127.0.0.1", port: port, type: 5 },
				destination: { host: "example.com", port: 443 },
				timeout: 5000
			}).catch(() => {});
		});
	});

	it("should gracefully close all connections", (done) => {
		proxy = createSocks5Server();

		proxy.on("connection", () => {
			assert.strictEqual(proxy.connectionCount(), 1);
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			SocksClient.createConnection({
				command: "connect",
				proxy: { host: "127.0.0.1", port: port, type: 5 },
				destination: { host: "example.com", port: 443 },
				timeout: 5000
			}).catch(() => {});

			setTimeout(() => {
				proxy.close().then(() => {
					assert.strictEqual(proxy.connectionCount(), 0);
					proxy = null;
					done();
				});
			}, 100);
		});
	});

	it("should accept connection when authenticate returns true", (done) => {
		proxy = createSocks5Server(null, {
			authenticate: (info) => {
				assert.strictEqual(info.username, "admin");
				assert.strictEqual(info.password, "secret");
				assert.ok(info.remoteAddress);
				assert.ok(info.remotePort);
				assert.ok(info.localAddress);
				assert.ok(info.localPort);

				return Promise.resolve(true);
			}
		});

		proxy.on("connection", (connection) => {
			const auth = connection.getAuth();
			assert.strictEqual(auth.username, "admin");
			assert.strictEqual(auth.password, "secret");

			connection.end();
			done();
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			SocksClient.createConnection({
				command: "connect",
				proxy: {
					host: "127.0.0.1",
					port: port,
					type: 5,
					userId: "admin",
					password: "secret"
				},
				destination: { host: "example.com", port: 443 },
				timeout: 5000
			}).catch(() => {});
		});
	});

	it("should reject connection when authenticate returns false", (done) => {
		proxy = createSocks5Server(null, {
			authenticate: () => {
				return Promise.resolve(false);
			}
		});

		proxy.on("connection", () => {
			done(new Error("Should not emit connection"));
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			SocksClient.createConnection({
				command: "connect",
				proxy: {
					host: "127.0.0.1",
					port: port,
					type: 5,
					userId: "bad",
					password: "creds"
				},
				destination: { host: "example.com", port: 443 },
				timeout: 5000
			}).catch((error) => {
				assert.ok(error);
				done();
			});
		});
	});

	it("should pass no-auth client through authenticate with no credentials", (done) => {
		proxy = createSocks5Server(null, {
			authenticate: (info) => {
				assert.strictEqual(info.username, undefined);
				assert.strictEqual(info.password, undefined);
				assert.ok(info.remoteAddress);
				assert.ok(info.remotePort);

				return Promise.resolve(true);
			}
		});

		proxy.on("connection", (connection) => {
			assert.strictEqual(connection.getAuth(), undefined);
			connection.end();
			done();
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			SocksClient.createConnection({
				command: "connect",
				proxy: { host: "127.0.0.1", port: port, type: 5 },
				destination: { host: "example.com", port: 443 },
				timeout: 5000
			}).catch(() => {});
		});
	});

	it("should reject no-auth client when authenticate returns false", (done) => {
		proxy = createSocks5Server(null, {
			authenticate: () => {
				return Promise.resolve(false);
			}
		});

		proxy.on("connection", () => {
			done(new Error("Should not emit connection"));
		});

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			const client = net.connect({ port: port, host: "127.0.0.1" });

			client.on("error", () => {});
			client.on("data", () => {});

			client.on("connect", () => {
				// Send greeting with only AUTH_NONE (0x00)
				client.write(Buffer.from([0x05, 0x01, 0x00]));
			});

			client.on("end", () => {
				client.destroy();
				done();
			});
		});
	});

	it("should return connection details", (done) => {
		proxy = createSocks5Server();

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

		proxy.tcp.listen(0, () => {
			const port = proxy.tcp.address().port;

			SocksClient.createConnection({
				command: "connect",
				proxy: { host: "127.0.0.1", port: port, type: 5 },
				destination: { host: "example.com", port: 443 },
				timeout: 5000
			}).catch(() => {});
		});
	});
});
