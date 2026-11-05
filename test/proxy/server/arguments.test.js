const assert = require("assert");
const net = require("net");
const http = require("http");
const PassThrough = require("stream").PassThrough;
const args = require("../../../src/proxy/server/arguments");
const createForwardServer = require("../../../src/proxy/server/forward");
const createReverseServer = require("../../../src/proxy/server/reverse");
const createSocks5Server = require("../../../src/proxy/server/socks5");

describe("Server arguments", () => {
	describe("server()", () => {
		it("should accept options only", () => {
			const result = args.server({ idleTimeout: 10 });

			assert.strictEqual(result.server, undefined);
			assert.deepStrictEqual(result.options, { idleTimeout: 10 });
		});

		it("should accept a server only", () => {
			const tcp = net.createServer();
			const result = args.server(tcp);

			assert.strictEqual(result.server, tcp);
			assert.deepStrictEqual(result.options, {});
		});

		it("should accept a server and options", () => {
			const tcp = net.createServer();
			const result = args.server(tcp, { idleTimeout: 10 });

			assert.strictEqual(result.server, tcp);
			assert.deepStrictEqual(result.options, { idleTimeout: 10 });
		});

		it("should accept nothing", () => {
			assert.deepStrictEqual(args.server(), { server: undefined, options: {} });
		});
	});

	describe("bind()", () => {
		const up = new PassThrough();
		const down = new PassThrough();

		it("should accept an options object", () => {
			assert.deepStrictEqual(args.bind({ up: up, down: down, idleTimeout: 5 }, undefined, undefined, {}), {
				up: up,
				down: down,
				idleTimeout: 5
			});
		});

		it("should accept the positional form", () => {
			assert.deepStrictEqual(args.bind(up, down, { idleTimeout: 5 }, {}), {
				up: up,
				down: down,
				idleTimeout: 5
			});
		});

		it("should accept positional with undefined up", () => {
			assert.deepStrictEqual(args.bind(undefined, undefined, { idleTimeout: 5 }, {}), {
				up: undefined,
				down: undefined,
				idleTimeout: 5
			});
		});

		it("should fall back to the server default idleTimeout", () => {
			assert.strictEqual(args.bind(undefined, undefined, undefined, { idleTimeout: 7 }).idleTimeout, 7);
			assert.strictEqual(args.bind({ up: up }, undefined, undefined, { idleTimeout: 7 }).idleTimeout, 7);
		});

		it("should let bind's idleTimeout override the server default, including 0", () => {
			assert.strictEqual(args.bind({ idleTimeout: 3 }, undefined, undefined, { idleTimeout: 7 }).idleTimeout, 3);
			assert.strictEqual(args.bind({ idleTimeout: 0 }, undefined, undefined, { idleTimeout: 7 }).idleTimeout, 0);
		});
	});

	describe("servers", () => {
		const closers = [];

		afterEach(() => {
			return Promise.all(closers.splice(0).map((close) => {
				return close();
			}));
		});

		const listen = (server) => {
			return new Promise((resolve) => {
				server.listen(0, "127.0.0.1", () => {
					closers.push(() => {
						return new Promise((done) => {
							server.close(() => {
								done();
							});
						});
					});
					resolve(server.address().port);
				});
			});
		};

		it("should apply a factory-level idleTimeout to every bind()", () => {
			const proxy = createForwardServer({ idleTimeout: 100 });
			const target = net.createServer((socket) => {
				socket.on("error", () => {});
			});
			let timedOut = false;

			proxy.on("timeout", () => {
				timedOut = true;
			});

			proxy.on("connection", (connection) => {
				const socket = net.connect({ port: target.address().port, host: "127.0.0.1" });
				socket.on("error", () => {});
				socket.on("connect", () => {
					connection.bind(socket);
				});
			});

			return Promise.all([listen(proxy.http), listen(target)]).then((ports) => {
				return new Promise((resolve, reject) => {
					const req = http.request({
						host: "127.0.0.1",
						port: ports[0],
						method: "CONNECT",
						path: "127.0.0.1:" + ports[1]
					});

					req.on("connect", (res, socket) => {
						socket.on("error", () => {});
						socket.on("close", () => {
							resolve();
						});
					});

					req.on("error", reject);
					req.end();
				});
			}).then(() => {
				assert.ok(timedOut, "server should emit timeout");
			});
		});

		it("should pipe through transforms given as bind({ up })", () => {
			const proxy = createReverseServer();
			const target = net.createServer((socket) => {
				socket.end("from target");
			});
			let upBytes = 0;

			proxy.on("connection", (connection) => {
				const up = new PassThrough();

				up.on("data", (data) => {
					upBytes += data.length;
				});

				const socket = net.connect({ port: target.address().port, host: "127.0.0.1" });
				socket.on("error", () => {});
				socket.on("connect", () => {
					connection.bind(socket, { up: up });
				});
			});

			return Promise.all([listen(proxy.tcp), listen(target)]).then((ports) => {
				return new Promise((resolve, reject) => {
					const client = net.connect({ port: ports[0], host: "127.0.0.1" });
					let received = "";

					client.on("data", (data) => {
						received += data;
					});
					client.on("end", () => {
						resolve(received);
					});
					client.on("error", reject);
				});
			}).then((received) => {
				assert.strictEqual(received, "from target");
				assert.strictEqual(upBytes, "from target".length);
			});
		});

		it("should accept SOCKS5 options as the only argument", () => {
			const proxy = createSocks5Server({
				authenticate: () => {
					return false;
				}
			});

			return listen(proxy.tcp).then((port) => {
				return new Promise((resolve) => {
					const client = net.connect({ port: port, host: "127.0.0.1" }, () => {
						// Greeting offering username/password auth, then credentials "a"/"b"
						client.write(Buffer.from([0x05, 0x01, 0x02]));
						client.once("data", () => {
							client.write(Buffer.from([0x01, 0x01, 0x61, 0x01, 0x62]));
							client.once("data", (reply) => {
								resolve(reply);
							});
						});
					});
					client.on("error", () => {});
				});
			}).then((reply) => {
				assert.strictEqual(reply[1], 0x01, "authenticate option should reject the credentials");
			});
		});
	});
});
