import { describe, expect, it } from "bun:test";
import { classifyAddress, DEFAULT_BLOCKED_V4, DEFAULT_BLOCKED_V6, parseCidr } from "../src/net";

type Expect = "allowed" | { category: string; range: string };

// One address inside each default range, and its nearest neighbour outside it. A neighbour of a
// nested range (a metadata address inside link-local) is still blocked, under the outer range.
const PAIRS: Array<{ range: string; inside: string; insideCategory: string; neighbour: string; neighbourVerdict: Expect }> = [
	{ range: "169.254.169.254/32", inside: "169.254.169.254", insideCategory: "metadata", neighbour: "169.254.169.253", neighbourVerdict: { category: "link-local", range: "169.254.0.0/16" } },
	{ range: "100.100.100.200/32", inside: "100.100.100.200", insideCategory: "metadata", neighbour: "100.100.100.201", neighbourVerdict: { category: "shared", range: "100.64.0.0/10" } },
	{ range: "168.63.129.16/32", inside: "168.63.129.16", insideCategory: "metadata", neighbour: "168.63.129.17", neighbourVerdict: "allowed" },
	{ range: "0.0.0.0/8", inside: "0.0.0.0", insideCategory: "unspecified", neighbour: "1.0.0.0", neighbourVerdict: "allowed" },
	{ range: "10.0.0.0/8", inside: "10.255.255.255", insideCategory: "private", neighbour: "11.0.0.0", neighbourVerdict: "allowed" },
	{ range: "100.64.0.0/10", inside: "100.127.255.255", insideCategory: "shared", neighbour: "100.128.0.0", neighbourVerdict: "allowed" },
	{ range: "127.0.0.0/8", inside: "127.255.255.254", insideCategory: "loopback", neighbour: "128.0.0.0", neighbourVerdict: "allowed" },
	{ range: "169.254.0.0/16", inside: "169.254.0.1", insideCategory: "link-local", neighbour: "169.255.0.0", neighbourVerdict: "allowed" },
	{ range: "172.16.0.0/12", inside: "172.31.255.255", insideCategory: "private", neighbour: "172.32.0.0", neighbourVerdict: "allowed" },
	{ range: "192.0.0.0/24", inside: "192.0.0.8", insideCategory: "reserved", neighbour: "192.0.1.0", neighbourVerdict: "allowed" },
	{ range: "192.0.2.0/24", inside: "192.0.2.1", insideCategory: "documentation", neighbour: "192.0.3.0", neighbourVerdict: "allowed" },
	{ range: "192.88.99.0/24", inside: "192.88.99.1", insideCategory: "reserved", neighbour: "192.88.100.0", neighbourVerdict: "allowed" },
	{ range: "192.168.0.0/16", inside: "192.168.255.255", insideCategory: "private", neighbour: "192.169.0.0", neighbourVerdict: "allowed" },
	{ range: "198.18.0.0/15", inside: "198.19.255.255", insideCategory: "benchmarking", neighbour: "198.20.0.0", neighbourVerdict: "allowed" },
	{ range: "198.51.100.0/24", inside: "198.51.100.7", insideCategory: "documentation", neighbour: "198.51.101.0", neighbourVerdict: "allowed" },
	{ range: "203.0.113.0/24", inside: "203.0.113.9", insideCategory: "documentation", neighbour: "203.0.114.0", neighbourVerdict: "allowed" },
	{ range: "224.0.0.0/4", inside: "239.255.255.255", insideCategory: "multicast", neighbour: "223.255.255.255", neighbourVerdict: "allowed" },
	{ range: "240.0.0.0/4", inside: "255.255.255.255", insideCategory: "reserved", neighbour: "239.255.255.255", neighbourVerdict: { category: "multicast", range: "224.0.0.0/4" } },
	{ range: "fd00:ec2::254/128", inside: "fd00:ec2::254", insideCategory: "metadata", neighbour: "fd00:ec2::253", neighbourVerdict: { category: "unique-local", range: "fc00::/7" } },
	{ range: "::/128", inside: "::", insideCategory: "unspecified", neighbour: "::1:0:0", neighbourVerdict: { category: "reserved", range: "outside 2000::/3" } },
	{ range: "::1/128", inside: "::1", insideCategory: "loopback", neighbour: "::2", neighbourVerdict: { category: "unspecified", range: "0.0.0.0/8" } },
	{ range: "64:ff9b:1::/48", inside: "64:ff9b:1::1", insideCategory: "reserved", neighbour: "64:ff9b:2::", neighbourVerdict: { category: "reserved", range: "outside 2000::/3" } },
	{ range: "100::/64", inside: "100::1", insideCategory: "discard", neighbour: "100:0:0:1::", neighbourVerdict: { category: "reserved", range: "outside 2000::/3" } },
	{ range: "2001::/23", inside: "2001:1ff:ffff::1", insideCategory: "reserved", neighbour: "2001:200::", neighbourVerdict: "allowed" },
	{ range: "2001:db8::/32", inside: "2001:db8::1", insideCategory: "documentation", neighbour: "2001:db9::", neighbourVerdict: "allowed" },
	{ range: "3fff::/20", inside: "3fff:fff::1", insideCategory: "documentation", neighbour: "3fff:1000::", neighbourVerdict: "allowed" },
	{ range: "fc00::/7", inside: "fd12:3456::1", insideCategory: "unique-local", neighbour: "fe00::", neighbourVerdict: { category: "reserved", range: "outside 2000::/3" } },
	{ range: "fe80::/10", inside: "febf:ffff::1", insideCategory: "link-local", neighbour: "fe7f:ffff::", neighbourVerdict: { category: "reserved", range: "outside 2000::/3" } },
	{ range: "fec0::/10", inside: "fec0::1", insideCategory: "site-local", neighbour: "fe80::", neighbourVerdict: { category: "link-local", range: "fe80::/10" } },
	{ range: "ff00::/8", inside: "ff02::1", insideCategory: "multicast", neighbour: "feff:ffff::", neighbourVerdict: { category: "site-local", range: "fec0::/10" } },
];

function verdictOf(address: string, allow: string[] = []): Expect {
	const v = classifyAddress(address, allow.map(parseCidr));
	return v.blocked ? { category: v.category, range: v.range } : "allowed";
}

describe("default ranges (AC-1)", () => {
	it("has a case for every default range", () => {
		const covered = PAIRS.map(pair => pair.range).sort();
		const table = [...DEFAULT_BLOCKED_V4, ...DEFAULT_BLOCKED_V6].map(entry => entry.cidr).sort();
		expect(covered).toEqual(table);
	});

	for (const pair of PAIRS) {
		it(`${pair.range}: ${pair.inside} is blocked, ${pair.neighbour} is not in it`, () => {
			expect(verdictOf(pair.inside)).toEqual({ category: pair.insideCategory, range: pair.range });
			expect(verdictOf(pair.neighbour)).toEqual(pair.neighbourVerdict);
		});
	}

	it("allows ordinary public addresses of both families", () => {
		for (const address of ["8.8.8.8", "93.184.215.14", "2606:4700::1111", "2a00:1450:4001::200e"]) expect(verdictOf(address)).toBe("allowed");
	});
});

describe("IPv4 inside IPv6 (AC-1)", () => {
	it("classifies IPv4-mapped, NAT64, and 6to4 addresses by the IPv4 address they carry", () => {
		expect(verdictOf("::ffff:127.0.0.1")).toEqual({ category: "loopback", range: "127.0.0.0/8" });
		expect(verdictOf("::ffff:7f00:1")).toEqual({ category: "loopback", range: "127.0.0.0/8" });
		expect(verdictOf("::ffff:169.254.169.254")).toEqual({ category: "metadata", range: "169.254.169.254/32" });
		expect(verdictOf("64:ff9b::10.0.0.1")).toEqual({ category: "private", range: "10.0.0.0/8" });
		expect(verdictOf("2002:c0a8:101::1")).toEqual({ category: "private", range: "192.168.0.0/16" });
		expect(verdictOf("::ffff:8.8.8.8")).toBe("allowed");
		expect(verdictOf("64:ff9b::8.8.8.8")).toBe("allowed");
		expect(verdictOf("2002:808:808::1")).toBe("allowed");
	});

	it("blocks every IPv4-compatible address, naming the internal IPv4 when there is one", () => {
		expect(verdictOf("::127.0.0.1")).toEqual({ category: "loopback", range: "127.0.0.0/8" });
		expect(verdictOf("::8.8.8.8")).toEqual({ category: "reserved", range: "::/96" });
	});

	it("names the form and the IPv4 address it carries", () => {
		const v = classifyAddress("::ffff:a00:5");
		expect(v.blocked && v.embedded).toEqual({ form: "IPv4-mapped", ipv4: "10.0.0.5" });
	});
});

describe("allowRanges (AC-1)", () => {
	it("exempts exactly the listed CIDRs, also when an IPv6 address carries an exempt IPv4", () => {
		expect(verdictOf("127.0.0.1", ["127.0.0.1/32"])).toBe("allowed");
		expect(verdictOf("::ffff:127.0.0.1", ["127.0.0.1/32"])).toBe("allowed");
		expect(verdictOf("127.0.0.2", ["127.0.0.1/32"])).toEqual({ category: "loopback", range: "127.0.0.0/8" });
		expect(verdictOf("fd00::1", ["fd00::/8"])).toBe("allowed");
		expect(verdictOf("fc00::1", ["fd00::/8"])).toEqual({ category: "unique-local", range: "fc00::/7" });
	});

	it("reports which exception let an address through", () => {
		const v = classifyAddress("10.1.2.3", [parseCidr("10.1.0.0/16")]);
		expect(v).toEqual({ blocked: false, address: "10.1.2.3", exempt: "10.1.0.0/16" });
	});

	it("rejects /0, host bits, bad prefixes, and malformed addresses", () => {
		for (const bad of ["0.0.0.0/0", "::/0", "10.0.0.5/8", "10.0.0.0/33", "fd00::/129", "1.2.3/24", "garbage", "10.0.0.0/8/8", "256.0.0.0/8"]) {
			expect(() => parseCidr(bad)).toThrow();
		}
		expect(parseCidr("10.0.0.7").text).toBe("10.0.0.7/32");
		expect(parseCidr("FD00::1").text).toBe("fd00::1/128");
	});
});

describe("addresses that are not addresses", () => {
	it("blocks a value that does not parse as an IP address instead of passing it", () => {
		expect(verdictOf("not-an-ip")).toEqual({ category: "unparseable", range: "not an IP address" });
		expect(verdictOf("1.2.3.04")).toEqual({ category: "unparseable", range: "not an IP address" });
	});
});
