/**
 * IP address utilities — parsing, masking, CIDR generation, and detection.
 * @module utils/ip
 */
const net = require("net");
const ipUtil = require("ipaddr.js");

/**
 * Convert an IPv4 address to its hex representation
 * @param {string} ip - Dotted IPv4 address (e.g. "192.168.1.1")
 * @returns {string} Hex string (e.g. "c0a80101")
 */
const ipToHex = (ip) => ip.split(".").map(x => parseInt(x).toString(16).padStart(2, "0")).join("");

/**
 * Check if a URL's hostname is an IP address
 * @param {string|URL} url - URL string or URL instance
 * @returns {number} 4 for IPv4, 6 for IPv6, 0 for hostname
 */
const isIP = (url) => {
	const urlInstance = url instanceof URL ? url : new URL(url);
	const hostname = urlInstance.hostname.replace(/^\[|]$/g, "");
	return net.isIP(hostname);
};

/**
 * Create an IP address wrapper with masking and CIDR generation
 * @param {string} realIp - IP address string (IPv4 or IPv6)
 * @returns {object} IP wrapper with kind(), toString(), mask(), and nets() methods
 */
const createIP = (realIp) => {
	const ip = {
		_kind: undefined,
		_buffer: undefined,
		_parsed: undefined,

		_init: (realIp) => {
			const parsed = ipUtil.parse(realIp);

			const kind = parsed.kind();
			const buffer = parsed.toByteArray();

			ip._kind = kind;
			ip._buffer = Buffer.from(buffer);
			ip._parsed = parsed;
		},

		/** @returns {string} "ipv4" or "ipv6" */
		kind: () => ip._kind,

		/** @returns {string} Normalized IP address string */
		toString: () => {
			return ip._parsed.toString();
		},

		/**
		 * Apply a CIDR mask to the IP address
		 * @param {number} initialMaskSize - Number of bits in the mask (e.g. 24 for /24)
		 * @returns {string} Masked IP address string
		 */
		mask: (initialMaskSize) => {
			let maskSize = initialMaskSize;
			const buffer = Buffer.from(ip._buffer.toString("hex"), "hex");

			const mask = Array(buffer.length)
				.fill(0)
				.map(() => {
					const mask = Math.min(maskSize, 8);
					maskSize = maskSize - mask;

					return parseInt(Array(mask).fill("1").join("").padEnd(8, "0"), 2);
				});

			buffer.forEach((_, key) => {
				buffer[key] &= mask[key];
			});

			return ipUtil.fromByteArray(Array.from(buffer)).toString();
		},

		/**
		 * Generate all possible CIDR notations for this IP
		 * @returns {string[]} Array of CIDR strings (e.g. ["10.0.0.0/1", ..., "10.0.0.1/32"])
		 */
		nets: () => {
			const mask = ip._buffer.length * 8;

			return Array(mask).fill(true).map((_, key) => {
				return ip.mask(key + 1) + "/" + (key + 1);
			});
		}
	};

	ip._init(realIp);

	return ip;
};

/**
 * Normalize an IPv4-mapped IPv6 address to plain IPv4
 * @param {string} address - Socket address (e.g. "::ffff:127.0.0.1" or "127.0.0.1")
 * @returns {string} Normalized address
 */
const normalizeAddress = (address) => {
	if (!address) {
		return address;
	}

	if(address.indexOf("::ffff:") === 0) {
		return address.replace("::ffff:", "");
	}

	return address;
};

/**
 * Get the real address family, accounting for IPv4-mapped IPv6 addresses
 * @param {string} address - Socket address
 * @param {string} family - Original address family from socket
 * @returns {string} "IPv4" if address is IPv4-mapped, otherwise the original family
 */
const normalizeFamily = (address, family) => {
	if (!address) {
		return family;
	}

	if(address.indexOf("::ffff:") === 0) {
		return "IPv4";
	}

	return family;
};

module.exports = createIP;
module.exports.ipToHex = ipToHex;
module.exports.isIP = isIP;
module.exports.normalizeAddress = normalizeAddress;
module.exports.normalizeFamily = normalizeFamily;
