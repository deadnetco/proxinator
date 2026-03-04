/**
 * TLS SNI (Server Name Indication) parser.
 * Parses TLS ClientHello messages to extract the target hostname.
 * Based on https://github.com/wacky6/sni-passthrough/tree/master/lib
 */
module.exports = {
	/**
	 * Check if a buffer starts with a TLS ClientHello message
	 * @param {Buffer} buf - Buffer to check
	 * @returns {boolean}
	 */
	isClientHello: (buf) => {
		return (
			buf[0] === 22 // Handshake, Record type
			&& buf[1] === 0x03 // TLSv1, TLS Major Version
			&& buf[5] === 0x01 // Client Hello
		);
	},

	/**
	 * Extract the SNI hostname from a TLS ClientHello buffer
	 * @param {Buffer} buf - Buffer containing a TLS ClientHello message
	 * @returns {string|null} Hostname or null if not found
	 */
	parseSNI: (buf) => {
		try {
			let skip = buf.readUInt8(43); // Session ID length
			skip += buf.readInt16BE(skip+44); // Cipher Suites Length
			skip += buf.readUInt8(skip+46); // Compression Methods Length

			let end = 49 + skip + buf.readInt16BE(skip+47); // Extensions Length

			// Skip past extension != Server Name
			while(buf.readInt16BE(skip+49) !== 0) {
				skip += buf.readInt16BE(skip+51);
				skip += 4;
				if (skip + 4 > end) return null;
			}

			// Skip past Server Name Type != host_name
			while(buf.readInt8(skip+55) !== 0) {
				skip += buf.readInt16BE(skip+56);
				skip += 3;
				if (skip + 3 > end) return null;
			}

			let len = buf.readInt16BE(skip+56);
			return buf.toString("utf8", skip+58, skip+58+len);

		} catch {
			return null;
		}
	}
};
