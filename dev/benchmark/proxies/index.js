/**
 * Proxinator servers under benchmark, run as a forked child process so the
 * proxy gets its own event loop.
 *
 * - forward / socks5: connect to whatever destination the client requests
 * - reverse: routes by SNI, "<target>.bench" -> that target's port
 *
 * Usage: fork("proxies", [JSON.stringify({ echo, bulk, sink })]); replies { forward, socks5, reverse } ports over IPC.
 */
const server = require("../../../src/proxy/server");
const reverseClient = require("../../../src/proxy/client").reverse;

/** @type {string} SNI suffix routed by the reverse proxy */
const SNI_SUFFIX = ".bench";

const targets = JSON.parse(process.argv[2]);

/**
 * Connect a proxied connection to its destination
 * @param {object} connection - Server connection wrapper
 * @param {URL} destination - Target URL
 */
const relay = (connection, destination) => {
	return reverseClient(destination).then((socket) => {
		connection.bind(socket);
	});
};

const forward = server.forward();
const socks5 = server.socks5();
const reverse = server.reverse();

[forward, socks5, reverse].forEach((proxy) => {
	proxy.on("error", () => {});
});

forward.on("connection", (connection) => {
	relay(connection, connection.getDestination());
});

socks5.on("connection", (connection) => {
	relay(connection, connection.getDestination());
});

reverse.on("connection", (connection) => {
	connection.waitSNI().then((hostname) => {
		const port = targets[String(hostname).replace(SNI_SUFFIX, "")];

		if (!port) {
			return connection.end();
		}

		return relay(connection, new URL("tcp://127.0.0.1:" + port));
	}).catch(() => {
		connection.end();
	});
});

const listen = (netServer) => {
	return new Promise((resolve) => {
		netServer.listen(0, "127.0.0.1", () => {
			resolve(netServer.address().port);
		});
	});
};

Promise.all([listen(forward.http), listen(socks5.tcp), listen(reverse.tcp)]).then((ports) => {
	process.send({
		forward: ports[0],
		socks5: ports[1],
		reverse: ports[2]
	});
});
