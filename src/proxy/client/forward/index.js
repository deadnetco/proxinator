/**
 * Forward proxy client - connects to a target through an upstream HTTP CONNECT proxy.
 * Supports both HTTP and HTTPS proxies with Basic auth.
 */
const http = require("http");
const https = require("https");

const protocol = {
	http,
	https
};

/** @type {number} CONNECT handshake timeout in ms */
const CONNECT_TIMEOUT = 30000;

/**
 * Connect to a target through an upstream proxy
 * @param {URL} proxy - Proxy URL (supports http:// and https://, with optional username/password)
 * @param {URL} host - Target URL (uses host property for CONNECT path, e.g. tcp://example.com:443)
 * @param {Object} [options] - Optional settings
 * @param {Function} [options.lookup] - DNS lookup function (e.g. cache.lookup from cacheable-lookup). Uses system DNS when omitted.
 * @param {net.Socket} [options.socket] - Pre-existing socket to send CONNECT through (for proxy chaining). Skips lookup when provided.
 * @param {number} [options.family] - IP address family (4 or 6). Restricts DNS resolution to IPv4 or IPv6 only.
 * @returns {Promise<net.Socket>} Connected socket tunneled through the proxy
 */
module.exports = (proxy, host, options) => {
	const opts = options || {};

	return new Promise((resolve, reject) => {
		const protocolName = proxy.protocol.split(":")[0];

		const requestOptions = {
			port: proxy.port,
			host: proxy.hostname,
			method: "CONNECT",
			path: host.host,
			headers: {
				host: host.host,
				connection: "keep-alive",
				"keep-alive": "timeout=3600"
			}
		};

		if (opts.socket) {
			requestOptions.createConnection = () => opts.socket;
		} else if (opts.lookup) {
			requestOptions.lookup = opts.lookup;
		}

		if (opts.family) {
			requestOptions.family = opts.family;
		}

		if(protocolName === "https") {
			requestOptions.agent = new https.Agent({
				servername: proxy.hostname
			});
		}

		if(proxy.username) {
			requestOptions.headers["Proxy-Authorization"] = `Basic ${Buffer.from(
				decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)
			).toString("base64")}`;
		}

		const req = protocol[protocolName].request(requestOptions);

		req.setTimeout(CONNECT_TIMEOUT, () => {
			req.destroy(new Error(`CONNECT timeout after ${CONNECT_TIMEOUT}ms (${proxy.toString()}) (${host})`));
		});

		req.end();

		req.on("connect", (res, socket) => {
			if(res.statusCode !== 200) {
				socket.destroy();

				const error = new Error(`Proxy server returned ${res.statusCode} (${res.statusMessage}) (${proxy.toString()}) (${host})`);
				error.response = res;

				return reject(error);
			}
			resolve(socket);
		});

		req.on("error", (error) => {
			reject(error);
		});
	});
};
