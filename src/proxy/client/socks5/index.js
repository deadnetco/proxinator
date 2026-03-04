/**
 * SOCKS5 proxy client - connects to a target through an upstream SOCKS5 proxy.
 * Wraps the `socks` package SocksClient.
 */
const SocksClient = require("socks").SocksClient;

/** @type {number} SOCKS handshake timeout in ms */
const CONNECT_TIMEOUT = 30000;

/**
 * Connect to a target through an upstream SOCKS5 proxy
 * @param {URL} proxy - SOCKS proxy URL (supports socks5://, with optional username:password)
 * @param {URL} target - Target URL (uses hostname and port, e.g. tcp://example.com:443)
 * @param {Object} [options] - Optional settings
 * @param {Function} [options.lookup] - DNS lookup function. Ignored for SOCKS5 (proxy resolves hostnames).
 * @param {net.Socket} [options.socket] - Pre-existing socket to send SOCKS handshake through (for proxy chaining).
 * @returns {Promise<net.Socket>} Connected socket tunneled through the proxy
 */
module.exports = (proxy, target, options) => {
	const opts = options || {};

	const socksOpts = {
		command: "connect",
		proxy: {
			host: proxy.hostname,
			port: parseInt(proxy.port, 10) || 1080,
			type: 5
		},
		destination: {
			host: target.hostname,
			port: parseInt(target.port, 10) || 80
		},
		timeout: CONNECT_TIMEOUT
	};

	if (proxy.username) {
		socksOpts.proxy.userId = decodeURIComponent(proxy.username);
		socksOpts.proxy.password = decodeURIComponent(proxy.password);
	}

	if (opts.socket) {
		socksOpts.existing_socket = opts.socket;
	}

	return SocksClient.createConnection(socksOpts).then((info) => {
		return info.socket;
	});
};
