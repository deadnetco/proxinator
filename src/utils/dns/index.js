/**
 * DNS resolver factory with random server selection and rate limiting.
 * Creates a fresh Resolver per query, picking 4 random servers from the list.
 * Returns a new RandomResolver instance on each call.
 * @module utils/dns
 */
const dns = require("dns");
const ipaddr = require("ipaddr.js");
const wrapper = require("queue-promised").wrapper;

/** @type {string[]} ipaddr.js range names considered bogus for DNS responses */
const DEFAULT_BOGUS_RANGES = [
	"unspecified", "loopback", "private", "linkLocal",
	"carrierGradeNat", "multicast", "broadcast", "uniqueLocal"
];

/** @type {string[]} Resolve methods that return IP addresses and should be filtered */
const IP_METHODS = ["resolve4", "resolve6"];

/**
 * Check if an IP address falls within any of the bogus ranges.
 * @param {string} ip - IP address string
 * @param {string[]} bogusRanges - Array of ipaddr.js range name strings
 * @returns {boolean} True if the IP is in a bogus range
 */
function isBogusIP(ip, bogusRanges) {
	try {
		const parsed = ipaddr.parse(ip);
		return bogusRanges.indexOf(parsed.range()) !== -1;
	} catch (err) { // eslint-disable-line no-unused-vars
		return false;
	}
}

/**
 * Check if any IP in a result array is bogus.
 * @param {string[]} results - Array of IP address strings
 * @param {string[]} bogusRanges - Array of ipaddr.js range name strings
 * @returns {boolean} True if any result IP is bogus
 */
function hasBogusIPs(results, bogusRanges) {
	return results.some((ip) => isBogusIP(ip, bogusRanges));
}

/**
 * Determine if a resolve method + args should be filtered for bogus IPs.
 * @param {string} method - Resolver method name
 * @param {Array} args - Arguments passed to the method
 * @returns {boolean} True if results should be checked for bogus IPs
 */
function shouldFilterResolve(method, args) {
	if (IP_METHODS.indexOf(method) !== -1) {
		return true;
	}

	if (method === "resolve") {
		const rrtype = args[1];
		return !rrtype || rrtype === "A" || rrtype === "AAAA";
	}

	return false;
}

/** @type {string[]} DNS resolver methods to wrap with rate limiting */
const RESOLVE_METHODS = [
	"resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa",
	"resolveCname", "resolveMx", "resolveNaptr", "resolveNs",
	"resolvePtr", "resolveSoa", "resolveSrv", "resolveTlsa",
	"resolveTxt", "reverse"
];

/**
 * Pick 4 random server addresses from a list
 * @param {string[]} servers - Array of DNS server IP addresses
 * @returns {string[]} Array of 4 random DNS server IP addresses
 */
function pickRandomServers(servers) {
	return Array(4)
		.fill()
		.map(() => Math.floor(Math.random() * servers.length))
		.map((i) => servers[i]);
}

/**
 * DNS resolver that routes each query through random servers.
 * All standard resolve methods are overridden with rate-limited versions.
 * @extends dns.promises.Resolver
 */
class RandomResolver extends dns.promises.Resolver {
	constructor() {
		super({ timeout: 700, tries: 1 });
	}
}

/**
 * Create a RandomResolver with rate-limited methods using the given server list.
 * @param {string[]} [servers] - Array of DNS server IP addresses. Defaults to built-in valid-dns-servers.json
 * @param {Object} [options] - Configuration options
 * @param {string[]} [options.bogusRanges] - ipaddr.js range name strings to treat as bogus (default: DEFAULT_BOGUS_RANGES). Pass [] to disable
 * @param {number} [options.maxBogusRetries] - Number of retries on bogus results (default: 3, so up to 4 total attempts)
 * @returns {RandomResolver} Resolver instance with rate-limited random server selection
 */
module.exports = (servers, options) => {
	const opts = options || {};
	const bogusRanges = Array.isArray(opts.bogusRanges) ? opts.bogusRanges : DEFAULT_BOGUS_RANGES;
	const maxBogusRetries = typeof opts.maxBogusRetries === "number" ? opts.maxBogusRetries : 3;

	const serverList = servers || require("../../../data/valid-dns-servers.json")
		.map((entry) => entry.ip_address);

	const rateLimitedCall = wrapper((method, args) => {
		const temp = new dns.promises.Resolver({ timeout: 700, tries: 1 });
		temp.setServers(pickRandomServers(serverList));
		return temp[method](...args);
	}, 100);

	/**
	 * Retry a resolve call if results contain bogus IPs.
	 * @param {string} method - Resolver method name
	 * @param {Array} args - Arguments for the method
	 * @param {number} retriesLeft - Remaining retries
	 * @returns {Promise} Resolves with DNS results
	 */
	function retryOnBogus(method, args, retriesLeft) {
		return rateLimitedCall(method, args)
			.then((results) => {
				if (retriesLeft <= 0 || !hasBogusIPs(results, bogusRanges)) {
					return results;
				}

				return retryOnBogus(method, args, retriesLeft - 1);
			});
	}

	const resolver = new RandomResolver();

	RESOLVE_METHODS.forEach((method) => {
		resolver[method] = function (...args) {
			if (bogusRanges.length > 0 && shouldFilterResolve(method, args)) {
				return retryOnBogus(method, args, maxBogusRetries);
			}

			return rateLimitedCall(method, args);
		};
	});

	return resolver;
};

module.exports.isBogusIP = isBogusIP;
module.exports.hasBogusIPs = hasBogusIPs;
module.exports.shouldFilterResolve = shouldFilterResolve;
module.exports.DEFAULT_BOGUS_RANGES = DEFAULT_BOGUS_RANGES;
