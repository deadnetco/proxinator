/**
 * Utility modules - DNS, SNI parsing, IP handling, load balancing and socket tunnelling.
 */
module.exports = {
	sni: require("./sni"),
	dns: require("./dns"),
	dnsCache: require("./dns-cache"),
	dnsLookup: require("./dns-lookup"),
	balancer: require("./balancer"),
	ip: require("./ip"),
	obfuscator: require("./obfuscator"),
	tunnel: require("./tunnel")
};
