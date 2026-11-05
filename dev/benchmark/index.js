/**
 * Proxinator benchmark - compares forward, socks5 and reverse proxies against
 * a direct connection, all on localhost.
 *
 * Three processes: this driver (clients), proxies (child) and targets (child),
 * so the proxy under test does not share an event loop with either end.
 *
 * Every tunnel starts with a real TLS ClientHello (so the reverse proxy can
 * route it by SNI), and every mode sends the same bytes.
 *
 * Usage: yarn benchmark
 * Tunables (env): BENCH_MODES, BENCH_CONNECTIONS, BENCH_CONCURRENCY, BENCH_PINGS, BENCH_MB, BENCH_STREAMS
 */
const fork = require("child_process").fork;
const net = require("net");
const path = require("path");
const tls = require("tls");
const wrapper = require("queue-promised").wrapper;
const client = require("../../src/proxy/client");
const sni = require("../../src/utils/sni");
const pump = require("./pump");

/** @type {string[]} Modes to run, "direct" is the baseline */
const MODES = (process.env.BENCH_MODES || "direct,forward,socks5,reverse").split(",");

/** @type {number} Connections opened in the connection-rate test */
const CONNECTIONS = parseInt(process.env.BENCH_CONNECTIONS || "2000", 10);

/** @type {number} Connections in flight at once */
const CONCURRENCY = parseInt(process.env.BENCH_CONCURRENCY || "50", 10);

/** @type {number} Sequential ping-pongs in the latency test */
const PINGS = parseInt(process.env.BENCH_PINGS || "2000", 10);

/** @type {number} Ping payload size in bytes */
const PING_SIZE = 64;

/** @type {number} MiB moved per direction in throughput tests */
const TRANSFER_MB = parseInt(process.env.BENCH_MB || "512", 10);

/** @type {number} Parallel streams in throughput tests */
const STREAMS = parseInt(process.env.BENCH_STREAMS || "4", 10);

/** @type {number} Bytes per stream */
const STREAM_BYTES = Math.floor(TRANSFER_MB * 1024 * 1024 / STREAMS);

/** @type {string[]} Target servers, also the SNI labels the reverse proxy routes on */
const TARGETS = ["echo", "bulk", "sink"];

const now = () => {
	return Number(process.hrtime.bigint()) / 1e6;
};

/**
 * Fork a helper process and wait for the ports it reports
 * @param {string} name - Directory under dev/benchmark
 * @param {string[]} args - Process arguments
 * @returns {Promise<{child: ChildProcess, ports: object}>}
 */
const spawn = (name, args) => {
	return new Promise((resolve, reject) => {
		const child = fork(path.join(__dirname, name), args, { stdio: "inherit" });

		child.once("message", (ports) => {
			resolve({ child, ports });
		});

		child.once("exit", (code) => {
			reject(new Error(name + " exited with code " + code));
		});
	});
};

/**
 * Capture the ClientHello Node sends for a hostname
 * @param {string} hostname - SNI hostname
 * @returns {Promise<Buffer>}
 */
const captureClientHello = (hostname) => {
	return new Promise((resolve) => {
		const server = net.createServer((socket) => {
			let head = Buffer.alloc(0);

			socket.on("data", (data) => {
				head = Buffer.concat([head, data]);

				if (sni.isComplete(head)) {
					socket.destroy();
					server.close();
					resolve(head);
				}
			});
		});

		server.listen(0, "127.0.0.1", () => {
			tls.connect({
				port: server.address().port,
				host: "127.0.0.1",
				servername: hostname,
				rejectUnauthorized: false
			}).on("error", () => {});
		});
	});
};

/**
 * Build the tunnel openers for every mode
 * @param {object} targets - Target ports by name
 * @param {object} proxies - Proxy ports by name
 * @returns {object} mode -> (targetName) => Promise<net.Socket>
 */
const createOpeners = (targets, proxies) => {
	const targetUrl = (name) => {
		return new URL("tcp://127.0.0.1:" + targets[name]);
	};

	return {
		direct: (name) => {
			return client.reverse(targetUrl(name));
		},

		forward: (name) => {
			return client.forward(new URL("http://127.0.0.1:" + proxies.forward), targetUrl(name));
		},

		socks5: (name) => {
			return client.socks5(new URL("socks5://127.0.0.1:" + proxies.socks5), targetUrl(name));
		},

		reverse: () => {
			return client.reverse(new URL("tcp://127.0.0.1:" + proxies.reverse));
		}
	};
};

/**
 * Resolve once `length` more bytes have been read from the socket
 * @param {net.Socket} socket
 * @param {number} length
 * @returns {Promise<void>}
 */
const receive = (socket, length) => {
	return new Promise((resolve, reject) => {
		let received = 0;

		const cleanup = () => {
			socket.off("data", onData);
			socket.off("close", onClose);
		};

		const onData = (data) => {
			received += data.length;

			if (received >= length) {
				cleanup();
				resolve();
			}
		};

		const onClose = () => {
			cleanup();
			reject(new Error("Socket closed after " + received + "/" + length + " bytes"));
		};

		socket.on("data", onData);
		socket.on("close", onClose);
	});
};

/**
 * Open a tunnel to a target and send the ClientHello that starts every session
 * @param {Function} open - Mode opener
 * @param {string} name - Target name
 * @param {object} hellos - ClientHello by target name
 * @returns {Promise<net.Socket>}
 */
const openTunnel = (open, name, hellos) => {
	return open(name).then((socket) => {
		socket.setNoDelay(true);
		socket.on("error", () => {});
		socket.write(hellos[name]);

		return socket;
	});
};

const percentile = (values, p) => {
	const sorted = values.slice().sort((a, b) => {
		return a - b;
	});

	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

/**
 * Connection rate: open tunnel, get the hello echoed back, close
 * @returns {Promise<{rate: number, p50: number, p99: number}>}
 */
const benchConnections = (open, hellos) => {
	const timings = [];

	const once = wrapper(() => {
		const start = now();

		return openTunnel(open, "echo", hellos).then((socket) => {
			return receive(socket, hellos.echo.length).then(() => {
				timings.push(now() - start);
				socket.destroy();
			});
		});
	}, CONCURRENCY);

	const start = now();

	return Promise.all(Array.from({ length: CONNECTIONS }, () => {
		return once();
	})).then(() => {
		return {
			rate: CONNECTIONS / ((now() - start) / 1000),
			p50: percentile(timings, 0.5),
			p99: percentile(timings, 0.99)
		};
	});
};

/**
 * Round-trip latency: sequential ping-pongs over one established tunnel
 * @returns {Promise<{p50: number, p99: number}>}
 */
const benchLatency = (open, hellos) => {
	const ping = Buffer.alloc(PING_SIZE, 0x70);
	const timings = [];

	return openTunnel(open, "echo", hellos).then((socket) => {
		return receive(socket, hellos.echo.length).then(() => {
			return Array.from({ length: PINGS }).reduce((chain) => {
				return chain.then(() => {
					const start = now();
					const pong = receive(socket, PING_SIZE);

					socket.write(ping);

					return pong.then(() => {
						timings.push(now() - start);
					});
				});
			}, Promise.resolve());
		}).then(() => {
			socket.destroy();

			return {
				p50: percentile(timings, 0.5),
				p99: percentile(timings, 0.99)
			};
		});
	});
};

/**
 * Download: STREAMS tunnels each receive STREAM_BYTES from the bulk target
 * @returns {Promise<number>} MiB/s
 */
const benchDownload = (open, hellos) => {
	const start = now();

	return Promise.all(Array.from({ length: STREAMS }, () => {
		return openTunnel(open, "bulk", hellos).then((socket) => {
			return receive(socket, STREAM_BYTES).then(() => {
				socket.destroy();
			});
		});
	})).then(() => {
		return (STREAM_BYTES * STREAMS / 1024 / 1024) / ((now() - start) / 1000);
	});
};

/**
 * Upload: STREAMS tunnels each send STREAM_BYTES (hello included) to the sink
 * @returns {Promise<number>} MiB/s
 */
const benchUpload = (open, hellos) => {
	const start = now();

	return Promise.all(Array.from({ length: STREAMS }, () => {
		return openTunnel(open, "sink", hellos).then((socket) => {
			const ack = receive(socket, 2);

			pump(socket, STREAM_BYTES - hellos.sink.length);

			return ack.then(() => {
				socket.destroy();
			});
		});
	})).then(() => {
		return (STREAM_BYTES * STREAMS / 1024 / 1024) / ((now() - start) / 1000);
	});
};

/**
 * Run every test for one mode, sequentially
 * @returns {Promise<object>} Result row
 */
const benchMode = (mode, open, hellos) => {
	const row = { mode };

	console.error("Running " + mode + "...");

	return benchConnections(open, hellos)
		.then((connections) => {
			row.connections = connections;

			return benchLatency(open, hellos);
		})
		.then((latency) => {
			row.latency = latency;

			return benchDownload(open, hellos);
		})
		.then((download) => {
			row.download = download;

			return benchUpload(open, hellos);
		})
		.then((upload) => {
			row.upload = upload;

			return row;
		});
};

const relative = (value, baseline) => {
	if (!baseline) {
		return "";
	}

	return " (" + Math.round(value / baseline * 100) + "%)";
};

const report = (rows) => {
	const baseline = rows.find((row) => {
		return row.mode === "direct";
	}) || {};

	const fixed = (value, digits) => {
		return value.toFixed(digits);
	};

	console.log("\nNode " + process.version + ", " + CONNECTIONS + " connections @" + CONCURRENCY + ", " +
		PINGS + " pings, " + TRANSFER_MB + " MiB over " + STREAMS + " streams\n");

	console.table(rows.reduce((table, row) => {
		table[row.mode] = {
			"conn/s": fixed(row.connections.rate, 0) + relative(row.connections.rate, baseline.connections && baseline.connections.rate),
			"connect p50 ms": fixed(row.connections.p50, 2),
			"connect p99 ms": fixed(row.connections.p99, 2),
			"rtt p50 µs": fixed(row.latency.p50 * 1000, 0),
			"rtt p99 µs": fixed(row.latency.p99 * 1000, 0),
			"down MiB/s": fixed(row.download, 0) + relative(row.download, baseline.download),
			"up MiB/s": fixed(row.upload, 0) + relative(row.upload, baseline.upload)
		};

		return table;
	}, {}));
};

const children = [];

Promise.all([
	spawn("targets", [String(STREAM_BYTES), String(STREAM_BYTES)]),
	Promise.all(TARGETS.map((name) => {
		return captureClientHello(name + ".bench");
	}))
])
	.then((started) => {
		const targets = started[0];
		const hellos = TARGETS.reduce((map, name, index) => {
			map[name] = started[1][index];
			return map;
		}, {});

		children.push(targets.child);

		return spawn("proxies", [JSON.stringify(targets.ports)]).then((proxies) => {
			children.push(proxies.child);

			const openers = createOpeners(targets.ports, proxies.ports);
			const rows = [];

			return MODES.reduce((chain, mode) => {
				return chain.then(() => {
					return benchMode(mode, openers[mode], hellos).then((row) => {
						rows.push(row);
					});
				});
			}, Promise.resolve()).then(() => {
				return rows;
			});
		});
	})
	.then(report)
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.then(() => {
		children.forEach((child) => {
			child.removeAllListeners("exit");
			child.kill();
		});

		process.exit();
	});
