/**
 * DNS resolver factory with random server selection and rate limiting.
 * Creates a fresh Resolver per query, picking 4 random servers from the list.
 * Returns a new RandomResolver instance on each call.
 * @module utils/dns
 */
const dns = require("dns");
const wrapper = require("queue-promised").wrapper;

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
 * @returns {RandomResolver} Resolver instance with rate-limited random server selection
 */
module.exports = (servers) => {
	const serverList = servers || require("../../../data/valid-dns-servers.json")
		.map((entry) => entry.ip_address);

	const rateLimitedCall = wrapper((method, args) => {
		const temp = new dns.promises.Resolver({ timeout: 700, tries: 1 });
		temp.setServers(pickRandomServers(serverList));
		return temp[method](...args);
	}, 100);

	const resolver = new RandomResolver();

	RESOLVE_METHODS.forEach((method) => {
		resolver[method] = function (...args) {
			return rateLimitedCall(method, args);
		};
	});

	return resolver;
};
