// Which addresses a web read must not reach. The default tables cover loopback, private, shared
// (CGNAT), link-local with the cloud metadata addresses named, and the IANA special-purpose blocks
// that are not globally reachable. An IPv6 address that carries an IPv4 address (IPv4-mapped,
// IPv4-compatible, NAT64, 6to4) is judged by the IPv4 address it carries; any other IPv6 address
// outside 2000::/3 is reserved. allowRanges exempts the CIDRs a user lists.

export type Family = 4 | 6;

export type Category =
	| "metadata"
	| "unspecified"
	| "private"
	| "shared"
	| "loopback"
	| "link-local"
	| "reserved"
	| "documentation"
	| "benchmarking"
	| "multicast"
	| "discard"
	| "unique-local"
	| "site-local"
	| "unparseable";

export interface Cidr {
	family: Family;
	bytes: Uint8Array;
	prefix: number;
	/** Canonical text, e.g. `10.0.0.0/8`, `fd00::/8`. */
	text: string;
}

export interface RangeEntry {
	cidr: string;
	category: Category;
	note?: string;
}

/** First match wins, so a metadata address is named before the range around it. */
export const DEFAULT_BLOCKED_V4: readonly RangeEntry[] = [
	{ cidr: "169.254.169.254/32", category: "metadata", note: "cloud instance metadata" },
	{ cidr: "100.100.100.200/32", category: "metadata", note: "Alibaba Cloud metadata" },
	{ cidr: "168.63.129.16/32", category: "metadata", note: "Azure WireServer" },
	{ cidr: "0.0.0.0/8", category: "unspecified" },
	{ cidr: "10.0.0.0/8", category: "private" },
	{ cidr: "100.64.0.0/10", category: "shared", note: "carrier-grade NAT" },
	{ cidr: "127.0.0.0/8", category: "loopback" },
	{ cidr: "169.254.0.0/16", category: "link-local" },
	{ cidr: "172.16.0.0/12", category: "private" },
	{ cidr: "192.0.0.0/24", category: "reserved", note: "IETF protocol assignments" },
	{ cidr: "192.0.2.0/24", category: "documentation" },
	{ cidr: "192.88.99.0/24", category: "reserved", note: "6to4 relay anycast" },
	{ cidr: "192.168.0.0/16", category: "private" },
	{ cidr: "198.18.0.0/15", category: "benchmarking" },
	{ cidr: "198.51.100.0/24", category: "documentation" },
	{ cidr: "203.0.113.0/24", category: "documentation" },
	{ cidr: "224.0.0.0/4", category: "multicast" },
	{ cidr: "240.0.0.0/4", category: "reserved", note: "including broadcast" },
];

export const DEFAULT_BLOCKED_V6: readonly RangeEntry[] = [
	{ cidr: "fd00:ec2::254/128", category: "metadata", note: "AWS instance metadata over IPv6" },
	{ cidr: "::/128", category: "unspecified" },
	{ cidr: "::1/128", category: "loopback" },
	{ cidr: "64:ff9b:1::/48", category: "reserved", note: "local-use NAT64" },
	{ cidr: "100::/64", category: "discard" },
	{ cidr: "2001::/23", category: "reserved", note: "IETF protocol assignments, including Teredo" },
	{ cidr: "2001:db8::/32", category: "documentation" },
	{ cidr: "3fff::/20", category: "documentation" },
	{ cidr: "fc00::/7", category: "unique-local" },
	{ cidr: "fe80::/10", category: "link-local" },
	{ cidr: "fec0::/10", category: "site-local" },
	{ cidr: "ff00::/8", category: "multicast" },
];

export type EmbeddedForm = "IPv4-mapped" | "IPv4-compatible" | "NAT64" | "6to4";

export type Verdict =
	| { blocked: false; address: string; exempt?: string }
	| { blocked: true; address: string; category: Category; range: string; note?: string; embedded?: { form: EmbeddedForm; ipv4: string } };

interface Ip {
	family: Family;
	bytes: Uint8Array;
}

function parseV4(text: string): Uint8Array | null {
	const parts = text.split(".");
	if (parts.length !== 4) return null;
	const bytes = new Uint8Array(4);
	for (let i = 0; i < 4; i++) {
		if (!/^(0|[1-9]\d{0,2})$/.test(parts[i])) return null;
		const n = Number(parts[i]);
		if (n > 255) return null;
		bytes[i] = n;
	}
	return bytes;
}

function parseV6(text: string): Uint8Array | null {
	let s = text;
	let tail: Uint8Array | null = null;
	const lastColon = s.lastIndexOf(":");
	if (lastColon < 0) return null;
	if (s.slice(lastColon + 1).includes(".")) {
		tail = parseV4(s.slice(lastColon + 1));
		if (!tail) return null;
		s = `${s.slice(0, lastColon + 1)}0:0`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
	if (rest !== null && head.length + rest.length > 7) return null;
	const groups = rest === null ? head : [...head, ...new Array<string>(8 - head.length - rest.length).fill("0"), ...rest];
	if (groups.length !== 8) return null;
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 8; i++) {
		if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
		const n = Number.parseInt(groups[i], 16);
		bytes[2 * i] = n >> 8;
		bytes[2 * i + 1] = n & 0xff;
	}
	if (tail) bytes.set(tail, 12);
	return bytes;
}

/** Parses a canonical IPv4 or IPv6 address (brackets allowed); null for anything else. */
export function parseIp(text: string): Ip | null {
	const bare = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
	if (bare.includes(":")) {
		const bytes = parseV6(bare);
		return bytes ? { family: 6, bytes } : null;
	}
	const bytes = parseV4(bare);
	return bytes ? { family: 4, bytes } : null;
}

export function formatIp(ip: Ip): string {
	if (ip.family === 4) return Array.from(ip.bytes).join(".");
	const groups = Array.from({ length: 8 }, (_, i) => (ip.bytes[2 * i] << 8) | ip.bytes[2 * i + 1]);
	let best = { start: -1, length: 0 };
	for (let i = 0; i < 8; ) {
		if (groups[i] !== 0) {
			i++;
			continue;
		}
		let j = i;
		while (j < 8 && groups[j] === 0) j++;
		if (j - i > best.length && j - i >= 2) best = { start: i, length: j - i };
		i = j;
	}
	const hex = groups.map(g => g.toString(16));
	if (best.start < 0) return hex.join(":");
	return `${hex.slice(0, best.start).join(":")}::${hex.slice(best.start + best.length).join(":")}`;
}

function bitsMatch(bytes: Uint8Array, network: Uint8Array, prefix: number): boolean {
	const full = prefix >> 3;
	for (let i = 0; i < full; i++) if (bytes[i] !== network[i]) return false;
	const rest = prefix & 7;
	if (rest === 0) return true;
	const mask = (0xff << (8 - rest)) & 0xff;
	return (bytes[full] & mask) === (network[full] & mask);
}

function inCidr(ip: Ip, cidr: Cidr): boolean {
	return ip.family === cidr.family && bitsMatch(ip.bytes, cidr.bytes, cidr.prefix);
}

/** Parses `address/prefix` or a bare address (one host). Rejects /0 and host bits outside the prefix. */
export function parseCidr(text: string): Cidr {
	const trimmed = text.trim();
	const slash = trimmed.indexOf("/");
	const ip = parseIp(slash < 0 ? trimmed : trimmed.slice(0, slash));
	if (!ip) throw new Error(`"${text}" is not an IP address or CIDR`);
	const max = ip.family === 4 ? 32 : 128;
	let prefix = max;
	if (slash >= 0) {
		const digits = trimmed.slice(slash + 1);
		if (!/^\d{1,3}$/.test(digits) || Number(digits) > max) throw new Error(`"${text}" has an invalid prefix length`);
		prefix = Number(digits);
	}
	if (prefix === 0) throw new Error(`"${text}" covers every address; list only the ranges you need`);
	const network = new Uint8Array(ip.bytes.length);
	for (let bit = 0; bit < prefix; bit++) network[bit >> 3] |= ip.bytes[bit >> 3] & (0x80 >> (bit & 7));
	if (!network.every((byte, i) => byte === ip.bytes[i])) {
		throw new Error(`"${text}" has bits set after the prefix; did you mean "${formatIp({ family: ip.family, bytes: network })}/${prefix}"?`);
	}
	return { family: ip.family, bytes: ip.bytes, prefix, text: `${formatIp(ip)}/${prefix}` };
}

const V4_TABLE = DEFAULT_BLOCKED_V4.map(entry => ({ ...entry, parsed: parseCidr(entry.cidr) }));
const V6_TABLE = DEFAULT_BLOCKED_V6.map(entry => ({ ...entry, parsed: parseCidr(entry.cidr) }));
const MAPPED = parseCidr("::ffff:0:0/96");
const COMPATIBLE = parseCidr("::/96");
const NAT64 = parseCidr("64:ff9b::/96");
const SIX_TO_FOUR = parseCidr("2002::/16");
const GLOBAL_UNICAST = parseCidr("2000::/3");

type Blocked = Extract<Verdict, { blocked: true }>;

function classifyV4(ip: Ip, address: string): Blocked | undefined {
	const hit = V4_TABLE.find(entry => inCidr(ip, entry.parsed));
	return hit ? { blocked: true, address, category: hit.category, range: hit.cidr, ...(hit.note ? { note: hit.note } : {}) } : undefined;
}

function embeddedV4(ip: Ip): { form: EmbeddedForm; v4: Ip } | undefined {
	if (inCidr(ip, MAPPED)) return { form: "IPv4-mapped", v4: { family: 4, bytes: ip.bytes.slice(12) } };
	if (inCidr(ip, NAT64)) return { form: "NAT64", v4: { family: 4, bytes: ip.bytes.slice(12) } };
	if (inCidr(ip, SIX_TO_FOUR)) return { form: "6to4", v4: { family: 4, bytes: ip.bytes.slice(2, 6) } };
	if (inCidr(ip, COMPATIBLE)) return { form: "IPv4-compatible", v4: { family: 4, bytes: ip.bytes.slice(12) } };
	return undefined;
}

function classifyIp(ip: Ip, address: string): Blocked | undefined {
	if (ip.family === 4) return classifyV4(ip, address);
	const hit = V6_TABLE.find(entry => inCidr(ip, entry.parsed));
	if (hit) return { blocked: true, address, category: hit.category, range: hit.cidr, ...(hit.note ? { note: hit.note } : {}) };
	const inner = embeddedV4(ip);
	if (inner) {
		const embedded = { form: inner.form, ipv4: formatIp(inner.v4) };
		const v4 = classifyV4(inner.v4, address);
		if (v4) return { ...v4, embedded };
		return inner.form === "IPv4-compatible" ? { blocked: true, address, category: "reserved", range: "::/96", note: "deprecated IPv4-compatible form", embedded } : undefined;
	}
	if (!inCidr(ip, GLOBAL_UNICAST)) return { blocked: true, address, category: "reserved", range: "outside 2000::/3" };
	return undefined;
}

/** Whether a web read may reach `address`; `allow` exempts the address or the IPv4 address it carries. */
export function classifyAddress(address: string, allow: readonly Cidr[] = []): Verdict {
	const ip = parseIp(address);
	if (!ip) return { blocked: true, address, category: "unparseable", range: "not an IP address" };
	const blocked = classifyIp(ip, address);
	if (!blocked) return { blocked: false, address };
	const inner = blocked.embedded ? parseIp(blocked.embedded.ipv4) : null;
	const exempt = allow.find(range => inCidr(ip, range) || (inner !== null && inCidr(inner, range)));
	return exempt ? { blocked: false, address, exempt: exempt.text } : blocked;
}

function covered(cidr: Cidr, all: readonly Cidr[]): boolean {
	return all.some(other => other !== cidr && other.family === cidr.family && other.prefix < cidr.prefix && bitsMatch(cidr.bytes, other.bytes, other.prefix));
}

function placeV4(v4: Cidr, base: Cidr, offset: number): string {
	const bytes = base.bytes.slice();
	bytes.set(v4.bytes, offset);
	return `${formatIp({ family: 6, bytes })}/${offset * 8 + v4.prefix}`;
}

/**
 * The prefixes a network-layer egress policy needs to drop the same destinations: the IPv4 table
 * and the IPv6 table without ranges another entry covers, plus the NAT64 and 6to4 forms of every
 * IPv4 range (the IPv6 destinations that reach those IPv4 addresses on the wire).
 */
export function egressPrefixes(): { v4: string[]; v6: string[] } {
	const v4 = V4_TABLE.map(entry => entry.parsed);
	const v6 = V6_TABLE.map(entry => entry.parsed);
	const v4Kept = v4.filter(cidr => !covered(cidr, v4));
	return {
		v4: v4Kept.map(cidr => cidr.text),
		v6: [...v6.filter(cidr => !covered(cidr, v6)).map(cidr => cidr.text), ...v4Kept.map(cidr => placeV4(cidr, NAT64, 12)), ...v4Kept.map(cidr => placeV4(cidr, SIX_TO_FOUR, 2))],
	};
}
