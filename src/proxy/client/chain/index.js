/**
 * Proxy chain client - chains multiple proxies into a single tunnel.
 * Each proxy becomes a hop through the previous tunnel.
 * Protocol is determined from the proxy URL (http/https → forward, socks5 → socks5).
 */
const forward = require("../forward");
const reverse = require("../reverse");
const socks5 = require("../socks5");

/** @type {Object.<string, Function>} Map of protocol to client function */
const clients = {
	http: forward,
	https: forward,
	socks5: socks5
};

/**
 * Get the client function for a proxy URL based on its protocol
 * @param {URL} proxy - Proxy URL
 * @returns {Function} Client function for this protocol
 * @throws {Error} If the protocol is not supported
 */
const getClient = (proxy) => {
	const protocol = proxy.protocol.split(":")[0];
	const client = clients[protocol];

	if (!client) {
		throw new Error("Unsupported proxy protocol: " + protocol);
	}

	return client;
};

/**
 * Chain an array of proxies into a single socket
 * @param {URL[]} proxies - Array of proxy URLs to chain through (in order). Protocol determines the client used per hop (http/https → forward, socks5 → socks5).
 * @param {URL} target - Final destination URL
 * @param {Object} [options] - Optional settings
 * @param {Function} [options.lookup] - DNS lookup function. Only used for the first hop (subsequent hops go through the tunnel).
 * @param {number} [options.family] - IP address family (4 or 6). Only used for the first hop.
 * @returns {Promise<net.Socket>} Connected socket tunneled through all proxies
 */
module.exports = (proxies, target, options) => {
	const opts = options || {};

	if (proxies.length === 0) {
		return reverse(target, opts);
	}

	const hops = proxies.map((proxy, i) => {
		if (i < proxies.length - 1) {
			return { proxy: proxy, target: proxies[i + 1] };
		}

		return { proxy: proxy, target: target };
	});

	const sockets = [];

	return hops.reduce((chain, hop, i) => {
		return chain.then((socket) => {
			if (socket) {
				sockets.push(socket);
			}

			const hopOpts = {};

			if (i === 0) {
				if (opts.lookup) {
					hopOpts.lookup = opts.lookup;
				}
				if (opts.family) {
					hopOpts.family = opts.family;
				}
			} else {
				hopOpts.socket = socket;
			}

			const client = getClient(hop.proxy);

			return client(hop.proxy, hop.target, hopOpts);
		});
	}, Promise.resolve(null)).catch((error) => {
		sockets.forEach((socket) => {
			socket.destroy();
		});

		throw error;
	});
};
