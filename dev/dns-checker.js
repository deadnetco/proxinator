const dns = require("dns");
const servers = require("../data/dns-servers.json");
const fs = require("fs");

const TEST_DOMAIN = "example.com";
const EXPECTED_IP = "93.184.215.14";

const valid = servers
	.filter(el => el.reliability > 0.98);

Promise.allSettled(valid.map(server => {
	const resolver = new dns.promises.Resolver({ timeout: 700, tries: 1 });
	resolver.setServers([server.ip_address]);
	return resolver.resolve(TEST_DOMAIN, "A");
})).then(results => {
	console.log(results);
	const working = valid.filter((_, key) => results[key] && results[key].status === "fulfilled" && results[key].value[0] === EXPECTED_IP);

	console.log(working);

	fs.writeFileSync("./data/valid-dns-servers.json", JSON.stringify(working));
});
