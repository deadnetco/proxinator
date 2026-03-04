/**
 * Utility modules - DNS, SNI parsing, IP handling, and load balancing.
 */
module.exports = {
	sni: require("./sni"),
	dns: require("./dns"),
	dnsCache: require("./dns-cache"),
	dnsLookup: require("./dns-lookup"),
	balancer: require("./balancer"),
	ip: require("./ip"),
	obfuscator: require("./obfuscator")
};
