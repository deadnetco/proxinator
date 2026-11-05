/**
 * TLS SNI (Server Name Indication) parser.
 * Parses TLS ClientHello messages to extract the target hostname.
 *
 * A ClientHello is not guaranteed to arrive in one TCP segment: modern
 * browsers send post-quantum key shares that push it past a single MSS, and
 * TLS itself may fragment the handshake across several records. Callers
 * buffer incoming data and use `isComplete` to know when to call `parseSNI`.
 */

/** @type {number} TLS record header size (content type, version, uint16 length) */
const RECORD_HEADER_SIZE = 5;

/** @type {number} Handshake message header size (msg type, uint24 length) */
const HANDSHAKE_HEADER_SIZE = 4;

/** @type {number} TLS record content type: handshake */
const CONTENT_TYPE_HANDSHAKE = 22;

/** @type {number} Handshake message type: ClientHello */
const HANDSHAKE_CLIENT_HELLO = 1;

/** @type {number} Extension type: server_name */
const EXTENSION_SERVER_NAME = 0;

/** @type {number} ServerName name type: host_name */
const NAME_TYPE_HOST_NAME = 0;

/**
 * Reassemble the first handshake message from consecutive TLS records.
 * @param {Buffer} buf - Raw bytes received from the client so far
 * @returns {{complete: boolean, message: Buffer|null}} `complete: false` means more data is needed
 * @throws {Error} When the data cannot be a TLS handshake
 */
const readHandshake = (buf) => {
	const fragments = [];
	let offset = 0;
	let collected = 0;
	let total = null;

	while (total === null || collected < total) {
		if (offset + RECORD_HEADER_SIZE > buf.length) {
			return { complete: false, message: null };
		}

		if (buf[offset] !== CONTENT_TYPE_HANDSHAKE) {
			throw new Error("Not a TLS handshake record");
		}

		const length = buf.readUInt16BE(offset + 3);

		// Zero-length handshake fragments are forbidden by RFC 8446 5.1
		if (length === 0) {
			throw new Error("Empty TLS handshake record");
		}

		if (offset + RECORD_HEADER_SIZE + length > buf.length) {
			return { complete: false, message: null };
		}

		fragments.push(buf.subarray(offset + RECORD_HEADER_SIZE, offset + RECORD_HEADER_SIZE + length));
		collected += length;
		offset += RECORD_HEADER_SIZE + length;

		if (total === null && collected >= HANDSHAKE_HEADER_SIZE) {
			total = HANDSHAKE_HEADER_SIZE + Buffer.concat(fragments).readUIntBE(1, 3);
		}
	}

	return {
		complete: true,
		message: Buffer.concat(fragments).subarray(0, total)
	};
};

/**
 * Find the host_name entry in a server_name extension body
 * @param {Buffer} data - server_name extension data
 * @returns {string|null}
 */
const parseServerNameList = (data) => {
	const end = Math.min(2 + data.readUInt16BE(0), data.length);
	let offset = 2;

	while (offset + 3 <= end) {
		const nameType = data[offset];
		const length = data.readUInt16BE(offset + 1);
		const start = offset + 3;

		if (start + length > end) {
			return null;
		}

		if (nameType === NAME_TYPE_HOST_NAME) {
			return data.toString("utf8", start, start + length);
		}

		offset = start + length;
	}

	return null;
};

/**
 * Walk a ClientHello handshake message to its server_name extension
 * @param {Buffer} message - Complete handshake message (including 4-byte header)
 * @returns {string|null}
 */
const parseClientHello = (message) => {
	if (message[0] !== HANDSHAKE_CLIENT_HELLO) {
		return null;
	}

	let offset = HANDSHAKE_HEADER_SIZE + 2 + 32; // client_version + random
	offset += 1 + message.readUInt8(offset); // session_id
	offset += 2 + message.readUInt16BE(offset); // cipher_suites
	offset += 1 + message.readUInt8(offset); // compression_methods

	// Extensions are optional in pre-TLS 1.3 hellos
	if (offset + 2 > message.length) {
		return null;
	}

	const extensionsEnd = Math.min(offset + 2 + message.readUInt16BE(offset), message.length);
	offset += 2;

	while (offset + 4 <= extensionsEnd) {
		const type = message.readUInt16BE(offset);
		const length = message.readUInt16BE(offset + 2);
		const start = offset + 4;

		if (type === EXTENSION_SERVER_NAME) {
			return parseServerNameList(message.subarray(start, Math.min(start + length, extensionsEnd)));
		}

		offset = start + length;
	}

	return null;
};

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
	 * Check whether enough data has been buffered to parse the ClientHello.
	 * Returns true once the whole handshake message is present, and also for
	 * malformed data - waiting for more bytes would not help it parse.
	 * @param {Buffer} buf - Bytes received from the client so far
	 * @returns {boolean} false only when more data is needed
	 */
	isComplete: (buf) => {
		try {
			return readHandshake(buf).complete;
		} catch {
			return true;
		}
	},

	/**
	 * Extract the SNI hostname from a TLS ClientHello buffer
	 * @param {Buffer} buf - Buffer containing a TLS ClientHello message (may span several TLS records)
	 * @returns {string|null} Hostname or null if not found, incomplete or malformed
	 */
	parseSNI: (buf) => {
		try {
			const handshake = readHandshake(buf);

			if (!handshake.complete) {
				return null;
			}

			return parseClientHello(handshake.message);
		} catch {
			return null;
		}
	}
};
