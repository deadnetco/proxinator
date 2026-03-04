/**
 * DNS cache factory using cacheable-lookup.
 * When called with a resolver, uses that resolver for lookups.
 * When called without arguments, uses system DNS.
 * @module utils/dns-cache
 */
const CacheableLookup = require("cacheable-lookup");

/**
 * Create a CacheableLookup instance.
 * @param {dns.promises.Resolver} [resolver] - Optional DNS resolver. Uses system DNS when omitted.
 * @returns {CacheableLookup} Cacheable lookup instance with .lookup method
 */
module.exports = (resolver) => {
	if (resolver) {
		return new CacheableLookup({ resolver });
	}

	return new CacheableLookup();
};
