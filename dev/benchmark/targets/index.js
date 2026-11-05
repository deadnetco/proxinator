/**
 * Benchmark target servers, run as a forked child process.
 *
 * - echo: echoes everything back (connection setup and round-trip latency)
 * - bulk: on the first received chunk, sends `downloadBytes` and closes (download)
 * - sink: swallows bytes, replies "ok" after `uploadBytes` (upload)
 *
 * Usage: fork("targets", [downloadBytes, uploadBytes]); replies { echo, bulk, sink } ports over IPC.
 */
const net = require("net");
const pump = require("../pump");

const downloadBytes = parseInt(process.argv[2], 10);
const uploadBytes = parseInt(process.argv[3], 10);

const ignoreErrors = (socket) => {
	socket.on("error", () => {});
};

const echo = net.createServer((socket) => {
	ignoreErrors(socket);
	socket.setNoDelay(true);
	socket.pipe(socket);
});

const bulk = net.createServer((socket) => {
	ignoreErrors(socket);

	socket.once("data", () => {
		socket.resume();

		pump(socket, downloadBytes, () => {
			socket.end();
		});
	});
});

const sink = net.createServer((socket) => {
	ignoreErrors(socket);

	let received = 0;

	const onData = (data) => {
		received += data.length;

		if (received >= uploadBytes) {
			socket.off("data", onData);
			socket.end("ok");
		}
	};

	socket.on("data", onData);
});

const listen = (server) => {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve(server.address().port);
		});
	});
};

Promise.all([listen(echo), listen(bulk), listen(sink)]).then((ports) => {
	process.send({
		echo: ports[0],
		bulk: ports[1],
		sink: ports[2]
	});
});
