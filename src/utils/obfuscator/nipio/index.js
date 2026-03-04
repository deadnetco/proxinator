/**
 * nip.io backend — converts IPv4 addresses and hostnames to nip.io format.
 * nip.io maps <anything>.<IPv4>.nip.io back to the IPv4 address.
 * Only supports IPv4 — use sslip.io for IPv6.
 * @module utils/obfuscator/nipio
 */
const net = require("net");
const dns = require("dns");
const ipToHex = require("../../ip").ipToHex;

/** @type {string} nip.io domain suffix */
const SUFFIX = ".nip.io";

/**
 * Convert an IPv4 address to a hex nip.io hostname
 * @param {string} ip - IPv4 address
 * @returns {string} nip.io hostname (e.g. "0a000001.nip.io")
 */
const fromIP = (ip) => {
	return ipToHex(ip) + SUFFIX;
};

/**
 * Resolve a hostname to an IPv4 address and return as nip.io hostname
 * @param {string} hostname - Domain name to resolve
 * @param {Function} [lookup] - DNS lookup function (e.g. cache.lookup). Uses system DNS when omitted.
 * @returns {Promise<string>} nip.io hostname (e.g. "0a000001.nip.io")
 */
const fromHostname = (hostname, lookup) => {
	const lookupFn = lookup || dns.lookup;

	return new Promise((resolve, reject) => {
		lookupFn(hostname, { family: 4 }, (err, address) => {
			if (err) {
				return reject(err);
			}

			resolve(fromIP(address));
		});
	});
};

/**
 * Convert any input (IPv4 or hostname) to a nip.io hostname.
 * Detects whether input is an IPv4 address or hostname and handles accordingly.
 * IPv6 addresses are rejected — nip.io only supports IPv4.
 * @param {string} host - IPv4 address or hostname
 * @param {Function} [lookup] - DNS lookup function (e.g. cache.lookup). Uses system DNS when omitted.
 * @returns {Promise<string>} nip.io hostname
 */
const convert = (host, lookup) => {
	if(net.isIP(host) === 4) {
		return Promise.resolve(fromIP(host));
	}

	if(net.isIP(host) === 6) {
		return Promise.reject(new Error("nip.io only supports IPv4"));
	}

	return fromHostname(host, lookup);
};

module.exports = {
	fromIP,
	fromHostname,
	convert
};
