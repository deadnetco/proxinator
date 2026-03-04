/**
 * Proxy servers - accept incoming connections and emit connection events.
 */
module.exports = {
	reverse: require("./reverse"),
	forward: require("./forward"),
	socks5: require("./socks5")
};
