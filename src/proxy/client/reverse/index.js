/**
 * Direct TCP connection client.
 * Connects to a target host:port without going through a proxy.
 *
 * NOTE: The socket is returned before the "connect" event fires.
 * This is fine because pipe() buffers data until the socket connects.
 */
const net = require("net");

/** @type {number} TCP connect timeout in ms */
const CONNECT_TIMEOUT = 30000;

/**
 * Connect directly to a target
 * @param {URL} url - Target URL (uses hostname and port)
 * @param {Object} [options] - Optional settings
 * @param {Function} [options.lookup] - DNS lookup function (e.g. from cacheable-lookup). Uses system DNS when omitted.
 * @param {net.Socket} [options.socket] - Pre-existing socket to return directly (for proxy chaining). Skips connection when provided.
 * @param {number} [options.family] - IP address family (4 or 6). Restricts DNS resolution to IPv4 or IPv6 only.
 * @returns {Promise<net.Socket>} Connected socket
 */
module.exports = (url, options) => {
	const opts = options || {};

	if (opts.socket) {
		return Promise.resolve(opts.socket);
	}

	const connectOptions = {
		port: url.port || 80,
		host: url.hostname,
		timeout: CONNECT_TIMEOUT
	};

	if (opts.lookup) {
		connectOptions.lookup = opts.lookup;
	}

	if (opts.family) {
		connectOptions.family = opts.family;
	}

	const socket = net.connect(connectOptions);

	socket.on("timeout", () => {
		socket.destroy(new Error(`Connect timeout after ${CONNECT_TIMEOUT}ms (${url})`));
	});

	socket.on("connect", () => {
		socket.setTimeout(0);
	});

	return Promise.resolve(socket);
};
