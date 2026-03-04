/**
 * Proxy toolkit - TCP/HTTP proxy server and client components.
 * Supports forward (HTTP CONNECT) and reverse (SNI-based) proxy modes.
 */
module.exports = {
	server: require("./server"),
	client: require("./client")
};

