/**
 * Argument normalisation shared by the proxy servers, so every server
 * factory and every connection's bind() accept the same call styles.
 */

/**
 * @param {*} value
 * @returns {boolean} true for a net/http server (anything with listen())
 */
const isServer = (value) => {
	return Boolean(value) && typeof value.listen === "function";
};

/**
 * @param {*} value
 * @returns {boolean} true for a stream (anything with pipe())
 */
const isStream = (value) => {
	return Boolean(value) && typeof value.pipe === "function";
};

module.exports = {
	/**
	 * Normalise server factory arguments.
	 * Accepts `(options)`, `(server)` or `(server, options)`.
	 * @param {net.Server|http.Server|Object} [serverOrOptions] - Existing server to wrap, or options
	 * @param {Object} [options] - Options when the first argument is a server
	 * @returns {{server: (net.Server|http.Server|undefined), options: Object}}
	 */
	server: (serverOrOptions, options) => {
		if (isServer(serverOrOptions)) {
			return {
				server: serverOrOptions,
				options: options || {}
			};
		}

		return {
			server: undefined,
			options: serverOrOptions || options || {}
		};
	},

	/**
	 * Normalise bind() arguments.
	 * Accepts `(options)` with `{ up, down, idleTimeout }`, or the positional
	 * `(up, down, options)` form.
	 * @param {Object|stream.Transform} [upOrOptions]
	 * @param {stream.Transform} [down]
	 * @param {Object} [options]
	 * @param {Object} defaults - Server-level defaults (e.g. idleTimeout)
	 * @returns {{up: (stream.Transform|undefined), down: (stream.Transform|undefined), idleTimeout: (number|undefined)}}
	 */
	bind: (upOrOptions, down, options, defaults) => {
		let given = options || {};
		let up = upOrOptions;
		let downStream = down;

		if (upOrOptions && !isStream(upOrOptions)) {
			given = upOrOptions;
			up = given.up;
			downStream = given.down;
		}

		let idleTimeout = defaults.idleTimeout;

		if (given.idleTimeout !== undefined) {
			idleTimeout = given.idleTimeout;
		}

		return {
			up: up,
			down: downStream,
			idleTimeout: idleTimeout
		};
	}
};
