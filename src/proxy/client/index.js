/**
 * Proxy clients - connect to upstream targets or proxies.
 */
module.exports = {
	reverse: require("./reverse"),
	forward: require("./forward"),
	socks5: require("./socks5"),
	chain: require("./chain"),
	agent: require("./agent")
};

