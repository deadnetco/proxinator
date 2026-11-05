const assert = require("assert");
const net = require("net");
const tunnel = require("../../src/utils/tunnel");

describe("Tunnel", () => {
	const servers = [];

	afterEach(() => {
		servers.splice(0).forEach((server) => {
			server.close();
		});
	});

	/**
	 * Connected TCP socket pair
	 * @returns {Promise<{outer: net.Socket, inner: net.Socket}>} outer is the remote peer, inner the proxy side
	 */
	const socketPair = () => {
		return new Promise((resolve) => {
			const server = net.createServer((inner) => {
				resolve({ outer: outer, inner: inner });
			});
			servers.push(server);

			let outer;

			server.listen(0, "127.0.0.1", () => {
				// Half-open, like a real peer that answers after reading EOF
				outer = net.connect({ port: server.address().port, host: "127.0.0.1", allowHalfOpen: true });
				outer.on("error", () => {});
			});
		});
	};

	/**
	 * Client <-> [clientSocket | tunnel | socket] <-> target
	 * @param {Object} [options] - Tunnel options
	 * @returns {Promise<{client: net.Socket, target: net.Socket, clientSocket: net.Socket, socket: net.Socket}>}
	 */
	const createTunnel = (options) => {
		return Promise.all([socketPair(), socketPair()]).then((pairs) => {
			const ends = {
				client: pairs[0].outer,
				clientSocket: pairs[0].inner,
				socket: pairs[1].inner,
				target: pairs[1].outer
			};

			tunnel(ends.clientSocket, ends.socket, options);

			return ends;
		});
	};

	const read = (socket) => {
		return new Promise((resolve) => {
			let data = "";

			socket.on("data", (chunk) => {
				data += chunk;
			});

			socket.on("end", () => {
				resolve(data);
			});
		});
	};

	it("should pipe data both ways", () => {
		return createTunnel().then((ends) => {
			const atTarget = read(ends.target);
			const atClient = read(ends.client);

			ends.client.end("to target");
			ends.target.end("to client");

			return Promise.all([atTarget, atClient]).then((data) => {
				assert.strictEqual(data[0], "to target");
				assert.strictEqual(data[1], "to client");
			});
		});
	});

	it("should keep the reverse direction open after a half-close", () => {
		return createTunnel().then((ends) => {
			// Target replies only after the client has finished sending
			ends.target.on("end", () => {
				setTimeout(() => {
					ends.target.end("reply after FIN");
				}, 20);
			});
			ends.target.resume();

			const atClient = read(ends.client);

			ends.client.end("request");

			return atClient.then((data) => {
				assert.strictEqual(data, "reply after FIN");
			});
		});
	});

	it("should destroy both sides and report non-benign errors", () => {
		const errors = [];

		return createTunnel({
			onError: (error) => {
				errors.push(error);
			}
		}).then((ends) => {
			ends.socket.destroy(new Error("boom"));

			return new Promise((resolve) => {
				ends.clientSocket.on("close", resolve);
			}).then(() => {
				assert.strictEqual(errors.length, 1);
				assert.strictEqual(errors[0].message, "boom");
				assert.ok(ends.clientSocket.destroyed);
			});
		});
	});

	it("should not report benign teardown errors", () => {
		const errors = [];

		return createTunnel({
			onError: (error) => {
				errors.push(error);
			}
		}).then((ends) => {
			const reset = new Error("reset");
			reset.code = "ECONNRESET";

			ends.clientSocket.destroy(reset);

			return new Promise((resolve) => {
				ends.socket.on("close", resolve);
			}).then(() => {
				assert.strictEqual(errors.length, 0);
			});
		});
	});

	it("should destroy an idle tunnel after idleTimeout", () => {
		let timeouts = 0;

		return createTunnel({
			idleTimeout: 100,
			onTimeout: () => {
				timeouts++;
			}
		}).then((ends) => {
			return new Promise((resolve) => {
				// client is half-open, so the teardown shows up as end, not close
				ends.client.on("end", resolve);
				ends.client.resume();
			}).then(() => {
				assert.strictEqual(timeouts, 1);
				assert.ok(ends.clientSocket.destroyed);
				assert.ok(ends.socket.destroyed);

				ends.client.destroy();
				ends.target.destroy();
			});
		});
	});

	it("should keep a tunnel with one-way traffic alive past idleTimeout", () => {
		let timeouts = 0;

		return createTunnel({
			idleTimeout: 100,
			onTimeout: () => {
				timeouts++;
			}
		}).then((ends) => {
			ends.client.resume();

			// Target streams to the client every 30ms for 300ms
			const timer = setInterval(() => {
				ends.target.write("tick");
			}, 30);

			return new Promise((resolve) => {
				setTimeout(resolve, 300);
			}).then(() => {
				clearInterval(timer);

				assert.strictEqual(timeouts, 0);
				assert.ok(!ends.clientSocket.destroyed);
				assert.ok(!ends.socket.destroyed);

				ends.client.destroy();
				ends.target.destroy();
			});
		});
	});

	it("should not set a timeout when idleTimeout is omitted", () => {
		return createTunnel().then((ends) => {
			assert.ok(!ends.clientSocket.timeout);
			assert.ok(!ends.socket.timeout);

			ends.client.destroy();
			ends.target.destroy();
		});
	});
});
