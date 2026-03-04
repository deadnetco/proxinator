/**
 * HTTP/HTTPS agent that tunnels requests through a proxy chain via CONNECT.
 * Works as a drop-in for http.request/https.request options.agent.
 */
const http = require("http");
const chain = require("../chain");

/**
 * Create an agent that tunnels connections through a proxy chain
 * @param {URL[]} proxies - Array of proxy URLs to chain through
 * @param {Object} [options] - Optional settings
 * @param {Function} [options.lookup] - DNS lookup function for the first hop
 * @param {number} [options.family] - IP address family (4 or 6). Restricts DNS resolution to IPv4 or IPv6 only.
 * @param {Function} [options.connect] - Transform tunnel target: (host, port) => Promise<URL>. Use to obfuscate CONNECT destination (e.g. nip.io) while TLS SNI uses the real hostname.
 * @returns {http.Agent} Agent with createConnection routed through the proxy chain
 */
module.exports = (proxies, options) => {
	const opts = options || {};

	const agent = new http.Agent({ keepAlive: false });

	agent.createConnection = (connectOptions, callback) => {
		const host = connectOptions.host;
		const port = connectOptions.port;

		const hostPart = host.indexOf(":") !== -1 ? "[" + host + "]" : host;

		const targetPromise = opts.connect
			? opts.connect(host, port)
			: Promise.resolve(new URL("tcp://" + hostPart + ":" + port));

		targetPromise
			.then((target) => {
				return chain(proxies, target, { lookup: opts.lookup, family: opts.family });
			})
			.then((socket) => {
				callback(null, socket);
			})
			.catch(callback);
	};

	return agent;
};
