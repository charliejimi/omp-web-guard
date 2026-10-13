import { afterAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { asked } from "./fake-dns";
import { closeRegistry, ledgerLines, loadExtensions, removeCreated, tempDir, textOf, urlReadResult, writeEntry } from "./helpers";

afterAll(() => {
	closeRegistry();
	removeCreated();
});

async function urlGuard(options: Record<string, unknown> = {}) {
	const dir = tempDir("wg-url-");
	const ledger = path.join(dir, "ledger.jsonl");
	const loaded = await loadExtensions([writeEntry(dir, "url", { ledger, lookupTimeoutMs: 300, ...options })], dir);
	return { ...loaded, lines: () => ledgerLines(ledger) };
}

describe("pre-check (AC-2)", () => {
	it("blocks a read of an internal address and records host and path, never the query", async () => {
		const g = await urlGuard();
		const r = await g.toolCall("read", { path: "http://127.0.0.2:8080/metadata?token=SECRET-1" }, "c-1");
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("127.0.0.2");
		expect(r?.reason).toContain("loopback");
		expect(r?.reason).not.toContain("SECRET-1");
		expect(g.lines()).toEqual([
			expect.objectContaining({
				event: "ssrf-block",
				phase: "pre",
				call: "c-1",
				tool: "read",
				reason: "internal",
				source: "127.0.0.2:8080/metadata",
				hasQuery: true,
				host: "127.0.0.2",
				address: "127.0.0.2",
				category: "loopback",
				range: "127.0.0.0/8",
			}),
		]);
		expect(JSON.stringify(g.lines())).not.toContain("SECRET-1");
	});

	it("blocks localhost and names that resolve to an internal address, even one answer among public ones", async () => {
		const g = await urlGuard();
		const cases: Array<[string, string]> = [
			["http://localhost/x", "loopback"],
			["HTTPS://LOCALHOST./x", "loopback"],
			["http://app.localhost:3000/", "loopback"],
			["http://internal.test/", "private"],
			["www.internal.test/docs", "private"],
			["http://mixed.test/", "loopback"],
			["http://v6internal.test/", "unique-local"],
			["http://metadata.test/latest/meta-data/", "metadata"],
		];
		for (const [target, category] of cases) {
			const r = await g.toolCall("read", { path: target });
			expect({ target, block: r?.block, named: r?.reason?.includes(category) }).toEqual({ target, block: true, named: true });
		}
	});

	it("blocks numeric spellings of internal IPv4 hosts and IPv4 carried inside IPv6", async () => {
		const g = await urlGuard();
		for (const target of ["http://2130706433/", "http://0x7f.1/", "http://127.1/", "http://0/", "http:/127.0.0.1/collapsed", "http://%31%32%37.0.0.1/", "http://[::ffff:169.254.169.254]/latest"]) {
			const r = await g.toolCall("read", { path: target });
			expect({ target, block: r?.block }).toEqual({ target, block: true });
		}
	});

	it("checks every URL of grep, ast_grep, and ast_edit paths, not only the first", async () => {
		const g = await urlGuard();
		const calls: Array<[string, Record<string, unknown>]> = [
			["grep", { pattern: "x", path: "src; http://169.254.169.254/latest" }],
			["grep", { pattern: "x", path: '["src", "http://10.1.2.3/a"]' }],
			["ast_grep", { pat: "x", path: "lib, http://metadata.test/" }],
			["ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ["src/a.ts", "http://10.1.2.3/x.ts"] }],
		];
		for (const [tool, input] of calls) {
			const r = await g.toolCall(tool, input);
			expect({ tool, block: r?.block }).toEqual({ tool, block: true });
		}
	});

	it("blocks a read that names a URL among other paths, because omp reads those parts outside the extension hooks", async () => {
		const g = await urlGuard();
		const r = await g.toolCall("read", { path: "README.md; https://public.test/notes" });
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("one URL per call");
		expect(g.lines().at(-1)).toMatchObject({ event: "ssrf-block", reason: "delimited-read", source: "public.test/notes" });
	});

	it("passes public URLs, selectors, local paths, and tools it does not inspect, and looks up only URL hosts", async () => {
		const g = await urlGuard();
		asked.length = 0;
		const passing: Array<[string, Record<string, unknown>]> = [
			["read", { path: "https://public.test/page?q=1" }],
			["read", { path: "www.public.test/a" }],
			["read", { path: "https://public.test/a, https://other.test/b" }],
			["read", { path: "https://public.test:raw" }],
			["read", { path: "http://[2606:4700::1111]:1-20" }],
			["read", { path: "docs/www.notes.md" }],
			["read", { path: "README.md" }],
			["grep", { pattern: "x", path: "src" }],
			["bash", { command: "curl http://127.0.0.1/" }],
		];
		for (const [tool, input] of passing) expect({ tool, input, r: await g.toolCall(tool, input) }).toEqual({ tool, input, r: undefined });
		expect([...new Set(asked)].sort()).toEqual(["other.test", "public.test", "www.public.test"]);
		expect(g.lines()).toEqual([]);
	});

	it("fails closed when a name does not resolve or the lookup times out", async () => {
		const g = await urlGuard();
		const started = Date.now();
		const missing = await g.toolCall("read", { path: "http://nxdomain.test/" });
		const slow = await g.toolCall("read", { path: "http://slow.test/" });
		expect(missing?.block && missing.reason?.includes("could not be resolved")).toBe(true);
		expect(slow?.block && slow.reason?.includes("did not resolve within 300 ms")).toBe(true);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(g.lines().map(line => line.reason)).toEqual(["lookup-failed", "lookup-timeout"]);
	});

	it("blocks a URL-shaped path that does not parse, and more than 20 URLs in one call", async () => {
		const g = await urlGuard();
		expect((await g.toolCall("read", { path: "http://[::1" }))?.reason).toContain("cannot be parsed");
		const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://public.test/p${i}`).join("; ");
		expect(await g.toolCall("grep", { pattern: "x", path: urls(20) })).toBeUndefined();
		expect((await g.toolCall("grep", { pattern: "x", path: urls(21) }))?.reason).toContain("at most 20");
	});
});

describe("domain policy (AC-2)", () => {
	it("deny blocks a listed domain and its subdomains even when the address is public", async () => {
		const g = await urlGuard({ domainPolicy: { deny: ["evil.example"] } });
		const r = await g.toolCall("read", { path: "https://sub.evil.example/x?k=v" });
		expect(r?.block && r.reason?.includes("deny list")).toBe(true);
		expect(g.lines()).toEqual([expect.objectContaining({ event: "domain-block", phase: "pre", rule: "deny", host: "sub.evil.example", source: "sub.evil.example/x" })]);
		expect(await g.toolCall("read", { path: "https://public.test/" })).toBeUndefined();
	});

	it("allow passes only listed domains and their subdomains", async () => {
		const g = await urlGuard({ domainPolicy: { allow: ["example.com"] } });
		expect(await g.toolCall("read", { path: "https://example.com/a" })).toBeUndefined();
		expect(await g.toolCall("read", { path: "https://docs.example.com/b" })).toBeUndefined();
		for (const target of ["https://notexample.com/", "https://public.test/"]) {
			const r = await g.toolCall("read", { path: target });
			expect({ target, notAllowed: r?.block === true && r.reason?.includes("allow list") }).toEqual({ target, notAllowed: true });
		}
	});
});

describe("allowRanges and configuration (AC-2)", () => {
	it("exempts exactly the listed range and says so at session start", async () => {
		const g = await urlGuard({ allowRanges: ["127.0.0.1/32"] });
		expect(g.notices.some(n => n.message.includes("127.0.0.1/32"))).toBe(true);
		expect(await g.toolCall("read", { path: "http://127.0.0.1:9/" })).toBeUndefined();
		expect(await g.toolCall("read", { path: "http://[::ffff:127.0.0.1]:9/" })).toBeUndefined();
		expect((await g.toolCall("read", { path: "http://127.0.0.2:9/" }))?.block).toBe(true);
	});

	it("blocks every URL read when the config is invalid, and says why at session start", async () => {
		const g = await urlGuard({ allowRanges: ["0.0.0.0/0"] });
		expect(g.notices).toEqual([expect.objectContaining({ type: "error" })]);
		expect(g.notices[0]?.message).toContain("0.0.0.0/0");
		expect((await g.toolCall("read", { path: "https://public.test/" }))?.reason).toContain("config");
		expect(await g.toolCall("read", { path: "README.md" })).toBeUndefined();
	});
});

describe("post-check (AC-3)", () => {
	it("withholds a read that a redirect took to an internal address, and records where it ended", async () => {
		const g = await urlGuard({ allowRanges: ["127.0.0.1/32"] });
		const r = await g.toolResult(
			urlReadResult("http://127.0.0.1:9/pub/redirect", "INTERNAL-MARKER", {
				finalUrl: "http://127.0.0.2:9/metadata",
				method: "md-suffix",
				notes: ["Found .md suffix version"],
				toolCallId: "c-redirect",
			}),
		);
		expect(r?.isError).toBe(true);
		expect(textOf(r?.content)).not.toContain("INTERNAL-MARKER");
		expect(textOf(r?.content)).toContain("127.0.0.2:9/metadata");
		expect(g.lines()).toEqual([
			expect.objectContaining({ event: "ssrf-block", phase: "post", call: "c-redirect", source: "127.0.0.2:9/metadata", category: "loopback", requested: "127.0.0.1:9/pub/redirect" }),
			expect.objectContaining({ event: "fetched", call: "c-redirect", requested: "127.0.0.1:9/pub/redirect", finalUrl: "127.0.0.2:9/metadata", via: [], method: "md-suffix", withheld: true }),
		]);
	});

	it("withholds a read that used a markdown alternate on an internal address, and names the alternate", async () => {
		const g = await urlGuard({ allowRanges: ["127.0.0.1/32"] });
		const r = await g.toolResult(
			urlReadResult("http://127.0.0.1:9/pub/alternate", "INTERNAL-MARKER", { method: "alternate-markdown", notes: ["Used markdown alternate: http://127.0.0.2:9/metadata.md"] }),
		);
		expect(r?.isError).toBe(true);
		expect(textOf(r?.content)).not.toContain("INTERNAL-MARKER");
		expect(g.lines().at(-1)).toMatchObject({
			event: "fetched",
			finalUrl: "127.0.0.1:9/pub/alternate",
			via: [{ kind: "markdown alternate", source: "127.0.0.2:9/metadata.md" }],
			withheld: true,
		});
	});

	it("passes a same-host alternate and records it", async () => {
		const g = await urlGuard({ allowRanges: ["127.0.0.1/32"] });
		const r = await g.toolResult(urlReadResult("http://127.0.0.1:9/pub/control", "page", { method: "alternate-markdown", notes: ["Used markdown alternate: http://127.0.0.1:9/pub/control.md"] }));
		expect(r).toBeUndefined();
		expect(g.lines()).toEqual([expect.objectContaining({ event: "fetched", via: [{ kind: "markdown alternate", source: "127.0.0.1:9/pub/control.md" }], withheld: false })]);
	});

	it("withholds a result whose final URL leaves the domain allow list", async () => {
		const g = await urlGuard({ domainPolicy: { allow: ["public.test"] } });
		const r = await g.toolResult(urlReadResult("https://public.test/a", "OTHER-SITE", { finalUrl: "https://other.test/landing" }));
		expect(r?.isError).toBe(true);
		expect(textOf(r?.content)).not.toContain("OTHER-SITE");
		expect(g.lines()[0]).toMatchObject({ event: "domain-block", phase: "post", rule: "allow", host: "other.test" });
	});

	it("resolves the final URL and every alternate at once, so slow names cannot add up past omp's handler timeout", async () => {
		const g = await urlGuard({ lookupTimeoutMs: 1_000 });
		const started = Date.now();
		const r = await g.toolResult(
			urlReadResult("https://public.test/a", "page", {
				finalUrl: "http://lag-one.test/x",
				notes: ["Used markdown alternate: http://lag-two.test/y.md", "Used feed alternate: http://lag-three.test/feed"],
			}),
		);
		expect(r).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1_800);
		expect(g.lines()).toEqual([expect.objectContaining({ event: "fetched", finalUrl: "lag-one.test/x", withheld: false })]);
	});

	it("withholds the result instead of passing it when its details cannot be read", async () => {
		const g = await urlGuard();
		const details = {
			kind: "url",
			url: "https://public.test/a",
			get finalUrl(): string {
				throw new Error("boom");
			},
			notes: [],
		};
		const r = await g.toolResult({ toolName: "read", input: { path: "https://public.test/a" }, content: [{ type: "text", text: "PAGE-TEXT" }], details });
		expect(r?.isError).toBe(true);
		expect(textOf(r?.content)).not.toContain("PAGE-TEXT");
		expect(g.lines().at(-1)).toMatchObject({ event: "ssrf-block", phase: "post", reason: "guard-error" });
	});

	it("leaves local reads and results of other tools alone", async () => {
		const g = await urlGuard();
		expect(await g.toolResult({ toolName: "read", input: { path: "README.md" }, content: [{ type: "text", text: "x" }], details: { resolvedPath: "/x/README.md" } })).toBeUndefined();
		expect(await g.toolResult({ toolName: "grep", input: { pattern: "x", path: "https://public.test/" }, content: [{ type: "text", text: "x" }] })).toBeUndefined();
		expect(g.lines()).toEqual([]);
	});
});

describe("artifacts of withheld results", () => {
	it("blocks a later read of the artifact that holds a withheld result", async () => {
		const g = await urlGuard({ allowRanges: ["127.0.0.1/32"] });
		await g.toolResult(
			urlReadResult("http://127.0.0.1:9/pub/redirect", "INTERNAL-MARKER\n\n[Showing lines 1-300 of 900. Read artifact://7 for full output]", { finalUrl: "http://127.0.0.2:9/metadata" }),
		);
		const r = await g.toolCall("read", { path: "artifact://7" });
		expect(r?.block && r.reason?.includes("artifact://7")).toBe(true);
		expect((await g.toolCall("grep", { pattern: "x", path: "artifact://7:1-50" }))?.block).toBe(true);
		expect(await g.toolCall("read", { path: "artifact://8" })).toBeUndefined();
		expect(g.lines().at(-1)).toMatchObject({ event: "ssrf-block", phase: "pre", reason: "withheld-artifact", source: "artifact://7" });
	});
});
