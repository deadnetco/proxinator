/**
 * DNS lookup factory — chains resolver + cache into a single lookup function.
 * Convenience wrapper that creates a RandomResolver and CacheableLookup in one step.
 * @module utils/dns-lookup
 */
const createResolver = require("../dns");
const createCache = require("../dns-cache");

/**
 * Create a cached DNS lookup function with optional random resolver.
 * @param {string[]} [servers] - DNS server IPs. Uses built-in list when omitted. Pass empty array for system DNS.
 * @returns {Function} Lookup function compatible with net.connect/http.request
 */
module.exports = (servers) => {
	if (Array.isArray(servers) && servers.length === 0) {
		return createCache().lookup;
	}

	const resolver = createResolver(servers);
	const cache = createCache(resolver);

	return cache.lookup;
};
