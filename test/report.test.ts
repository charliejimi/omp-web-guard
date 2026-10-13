import { afterAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { PACKAGE, removeCreated, tempDir, writeFile } from "./helpers";

afterAll(removeCreated);

const BIN = path.join(PACKAGE, "bin", "web-guard-report.ts");

// One research session's ledger as the two guards write it, plus one line from another session.
const LEDGER = [
	{ event: "fetch", session: "s1", call: "c1", tool: "read", url: "docs.example.com/guide", hasQuery: false },
	{ event: "fetched", session: "s1", call: "c1", tool: "read", requested: "docs.example.com/guide", finalUrl: "docs.example.com/guide", via: [], method: "native", withheld: false },
	{ event: "label", session: "s1", call: "c1", tool: "read", source: "docs.example.com/guide", chars: 900, channel: "content", nonce: true },
	{ event: "fetched", session: "s1", call: "c2", tool: "read", requested: "bait.example/page", finalUrl: "bait.example/page", via: [], method: "native", withheld: false },
	{ event: "block", session: "s1", call: "c2", tool: "read", source: "bait.example/page", pattern: "ignore-instructions", chars: 700 },
	{ event: "ssrf-block", session: "s1", call: "c3", tool: "read", phase: "pre", reason: "internal", source: "127.0.0.2:9/metadata", host: "127.0.0.2", address: "127.0.0.2", category: "loopback", range: "127.0.0.0/8" },
	{ event: "fetched", session: "s1", call: "c4", tool: "read", requested: "short.example/x", finalUrl: "landing.example/x", via: [], method: "native", withheld: false },
	{ event: "label", session: "s1", call: "c4", tool: "read", source: "landing.example/x", chars: 400, channel: "content", nonce: true },
	{ event: "fetched", session: "s1", call: "c5", tool: "read", requested: "alt.example/page", finalUrl: "alt.example/page", via: [{ kind: "markdown alternate", source: "cdn.example/page.md" }], method: "alternate-markdown", withheld: false },
	{ event: "label", session: "s1", call: "c5", tool: "read", source: "alt.example/page", chars: 300, channel: "content", nonce: true },
	{ event: "domain-block", session: "s1", call: "c6", tool: "read", phase: "pre", rule: "deny", source: "evil.example/", host: "evil.example" },
	{ event: "skip", session: "s1", call: "c7", tool: "read", source: "gone.example/old", reason: "error" },
	{ event: "label", session: "s2", call: "c8", tool: "read", source: "elsewhere.example/doc", chars: 100, channel: "content", nonce: true },
];

interface Citation {
	url: string;
	status: string;
}

function run(args: string[]): { code: number; out: string; report?: { citations?: Citation[]; sources?: Citation[] } } {
	const ran = Bun.spawnSync(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe" });
	const out = ran.stdout.toString();
	let report: { citations?: Citation[] } | undefined;
	try {
		report = JSON.parse(out);
	} catch {}
	return { code: ran.exitCode ?? -1, out: out + ran.stderr.toString(), report };
}

function files(answer: string) {
	const dir = tempDir("wg-report-");
	const ledger = writeFile(path.join(dir, "ledger.jsonl"), `${LEDGER.map(line => JSON.stringify({ ts: 1, ...line })).join("\n")}\nnot json\n`);
	return { ledger, answer: writeFile(path.join(dir, "answer.md"), answer) };
}

const statuses = (report: { citations?: Citation[] } | undefined) => Object.fromEntries((report?.citations ?? []).map(c => [c.url, c.status]));

describe("web-guard-report (AC-6)", () => {
	it("maps every cited URL to its ledger status and exits 1 when a citation was blocked or not read", () => {
		const f = files(
			[
				"The guide explains the setup ([docs](https://docs.example.com/guide)).",
				"A bait page said otherwise (https://bait.example/page).",
				"Metadata lives at http://127.0.0.2:9/metadata?x=1.",
				"The short link (https://short.example/x) and the alternate page <https://alt.example/page>.",
				"Unread: https://never.example/, denied: https://evil.example/, failed: https://gone.example/old.",
			].join("\n"),
		);
		const r = run(["--ledger", f.ledger, "--answer", f.answer, "--session", "s1", "--json"]);
		expect(r.code).toBe(1);
		expect(statuses(r.report)).toEqual({
			"https://docs.example.com/guide": "labelled",
			"https://bait.example/page": "blocked",
			"http://127.0.0.2:9/metadata?x=1": "ssrf-blocked",
			"https://short.example/x": "redirected",
			"https://alt.example/page": "via-alternate",
			"https://never.example/": "not-read",
			"https://evil.example/": "domain-blocked",
			"https://gone.example/old": "not-read",
		});
	});

	it("exits 0 when every citation was read, warning about redirects and alternates", () => {
		const f = files("See https://docs.example.com/guide/, https://short.example/x and https://alt.example/page#intro.");
		const r = run(["--ledger", f.ledger, "--answer", f.answer]);
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/redirected\s+https:\/\/short\.example\/x\s+.*landing\.example\/x/);
		expect(r.out).toMatch(/via-alternate\s+https:\/\/alt\.example\/page#intro\s+.*cdn\.example\/page\.md/);
	});

	it("counts only the given session's reads", () => {
		const f = files("From https://elsewhere.example/doc.");
		expect(statuses(run(["--ledger", f.ledger, "--answer", f.answer, "--json"]).report)).toEqual({ "https://elsewhere.example/doc": "labelled" });
		const scoped = run(["--ledger", f.ledger, "--answer", f.answer, "--session", "s1", "--json"]);
		expect({ code: scoped.code, statuses: statuses(scoped.report) }).toEqual({ code: 1, statuses: { "https://elsewhere.example/doc": "not-read" } });
	});

	it("without an answer, lists what each source got: withheld, labelled, or read somewhere else", () => {
		const f = files("");
		const r = run(["--ledger", f.ledger, "--session", "s1", "--json"]);
		expect(r.code).toBe(0);
		const bySource = Object.fromEntries((r.report?.sources ?? []).map(s => [s.url, s.status]));
		expect(bySource).toMatchObject({ "docs.example.com/guide": "labelled", "bait.example/page": "blocked", "127.0.0.2:9/metadata": "ssrf-blocked", "short.example/x": "redirected" });
	});
});
