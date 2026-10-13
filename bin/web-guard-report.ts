#!/usr/bin/env bun
// web-guard-report: checks a research answer's citations against the omp-web-guard ledger. Every
// cited URL gets the status its read left there:
//   labelled        read; the content guard only labelled it
//   blocked         the content guard withheld it (an injection pattern)
//   ssrf-blocked    the URL guard blocked or withheld it (internal address, failed lookup, ...)
//   domain-blocked  the domain policy blocked or withheld it
//   redirected      read, but the content came from another host (warning)
//   via-alternate   read, but the content came from an alternate URL (warning)
//   read            fetched, with no content-guard line (warning)
//   not-read        nothing in the ledger, or only a failed read
// Exits 1 when a citation is blocked or not read, 0 otherwise, 2 on a usage error. Without --answer
// it lists every source in the ledger with its status.
//
// Usage: web-guard-report [--ledger <file>] [--session <id>] [--answer <file>|-] [--json]
import { guardSettings } from "../src/config";
import { type LedgerEntry, readLedger } from "../src/ledger";

export type Status = "labelled" | "blocked" | "ssrf-blocked" | "domain-blocked" | "redirected" | "via-alternate" | "read" | "not-read";

const FAILING: ReadonlySet<Status> = new Set(["blocked", "ssrf-blocked", "domain-blocked", "not-read"]);
const WARNING: ReadonlySet<Status> = new Set(["redirected", "via-alternate", "read"]);

export interface Row {
	url: string;
	status: Status;
	detail?: string;
}

/** The comparison key of a ledger source: host in lower case, no trailing slash, no artifact suffix. */
function key(source: string): string {
	const bare = source.replace(/ \(artifact:\/\/\d+\)$/, "");
	const slash = bare.indexOf("/");
	const host = (slash < 0 ? bare : bare.slice(0, slash)).toLowerCase();
	const rest = slash < 0 ? "" : bare.slice(slash).replace(/\/+$/, "");
	return `${host}${rest}`;
}

function hostPart(source: string): string {
	return key(source).split("/")[0];
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function viaList(entry: LedgerEntry): Array<{ kind: string; source: string }> {
	return Array.isArray(entry.via) ? (entry.via as Array<{ kind?: unknown; source?: unknown }>).filter(v => typeof v?.source === "string").map(v => ({ kind: String(v.kind ?? "alternate"), source: String(v.source) })) : [];
}

/** Every source an entry names, as written. */
function sourcesOf(entry: LedgerEntry): string[] {
	const out: string[] = [];
	for (const field of ["url", "source", "requested", "finalUrl"]) {
		const value = str(entry[field]);
		if (value) out.push(value);
	}
	for (const v of viaList(entry)) out.push(v.source);
	return out;
}

function statusFor(k: string, entries: readonly LedgerEntry[]): { status: Status; detail?: string } {
	const matched = entries.filter(entry => sourcesOf(entry).some(source => key(source) === k));
	const calls = new Set(matched.map(entry => str(entry.call)).filter((call): call is string => call !== undefined));
	const related = entries.filter(entry => matched.includes(entry) || (str(entry.call) !== undefined && calls.has(str(entry.call) as string)));
	const first = (event: string) => related.find(entry => entry.event === event);
	const block = first("block");
	if (block) return { status: "blocked", detail: `pattern ${str(block.pattern) ?? "?"}` };
	const ssrf = first("ssrf-block");
	if (ssrf) return { status: "ssrf-blocked", detail: [str(ssrf.reason), str(ssrf.category), str(ssrf.range), str(ssrf.source)].filter(Boolean).join(", ") };
	const domain = first("domain-block");
	if (domain) return { status: "domain-blocked", detail: `${str(domain.rule) === "deny" ? "on the deny list" : "not on the allow list"}: ${str(domain.host) ?? "?"}` };
	const fetched = related.filter(entry => entry.event === "fetched" && entry.withheld !== true);
	const redirect = fetched.find(entry => key(str(entry.requested) ?? "") === k && hostPart(str(entry.finalUrl) ?? "") !== hostPart(str(entry.requested) ?? ""));
	if (redirect) return { status: "redirected", detail: `content came from ${str(redirect.finalUrl)}` };
	const alternate = fetched.find(entry => viaList(entry).length > 0);
	if (alternate) return { status: "via-alternate", detail: `content came from ${viaList(alternate).map(v => `${v.source} (${v.kind})`).join(", ")}` };
	if (first("label")) return { status: "labelled" };
	if (fetched.length > 0 || first("fetch")) return { status: "read", detail: "no content-guard line for this read" };
	if (first("skip")) return { status: "not-read", detail: `the read failed (${str(first("skip")?.reason) ?? "?"})` };
	return { status: "not-read" };
}

/** The http(s) URLs an answer cites, in order, without trailing punctuation. */
export function citedUrls(answer: string): string[] {
	const out: string[] = [];
	for (const m of answer.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
		const url = m[0].replace(/[.,;:!?)\]}'"]+$/, "");
		if (!out.includes(url)) out.push(url);
	}
	return out;
}

function citationKey(url: string): string | null {
	try {
		const u = new URL(url);
		return key(`${u.host}${u.pathname}`);
	} catch {
		return null;
	}
}

export function reconcile(answer: string, entries: readonly LedgerEntry[]): Row[] {
	return citedUrls(answer).map(url => {
		const k = citationKey(url);
		return { url, ...(k === null ? { status: "not-read" as const, detail: "not a valid URL" } : statusFor(k, entries)) };
	});
}

export function summarize(entries: readonly LedgerEntry[]): Row[] {
	const seen = new Map<string, string>();
	for (const entry of entries) {
		for (const source of sourcesOf(entry)) {
			const k = key(source);
			if (!seen.has(k)) seen.set(k, source);
		}
	}
	return [...seen].map(([k, source]) => ({ url: source, ...statusFor(k, entries) }));
}

function table(rows: readonly Row[]): string {
	const width = Math.min(60, Math.max(3, ...rows.map(row => row.url.length)));
	const lines = [`${"STATUS".padEnd(15)} ${"URL".padEnd(width)} DETAIL`];
	for (const row of rows) lines.push(`${row.status.padEnd(15)} ${row.url.padEnd(width)} ${row.detail ?? ""}`.trimEnd());
	return lines.join("\n");
}

function usage(message: string): never {
	process.stderr.write(`web-guard-report: ${message}\nUsage: web-guard-report [--ledger <file>] [--session <id>] [--answer <file>|-] [--json]\n`);
	process.exit(2);
}

async function main(argv: string[]): Promise<number> {
	let ledger: string | undefined;
	let session: string | undefined;
	let answerPath: string | undefined;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => argv[++i] ?? usage(`${arg} needs a value`);
		if (arg === "--ledger") ledger = value();
		else if (arg === "--session") session = value();
		else if (arg === "--answer") answerPath = value();
		else if (arg === "--json") json = true;
		else if (arg === "--help" || arg === "-h") usage("reconciles cited URLs with the omp-web-guard ledger");
		else usage(`unknown argument ${arg}`);
	}
	if (!ledger) {
		const { settings, error } = guardSettings({});
		if (error) process.stderr.write(`web-guard-report: the config could not be used (${error}); reading ${settings.ledger}\n`);
		ledger = settings.ledger;
	}
	let entries: LedgerEntry[];
	try {
		entries = readLedger(ledger);
	} catch (err) {
		usage(`cannot read the ledger ${ledger} (${(err as Error).message})`);
	}
	if (session !== undefined) entries = entries.filter(entry => entry.session === session);

	if (answerPath === undefined) {
		const sources = summarize(entries);
		process.stdout.write(json ? `${JSON.stringify({ ledger, session: session ?? null, sources }, null, 2)}\n` : `${table(sources)}\n`);
		return 0;
	}
	let answer: string;
	try {
		answer = answerPath === "-" ? await Bun.stdin.text() : await Bun.file(answerPath).text();
	} catch (err) {
		usage(`cannot read the answer ${answerPath} (${(err as Error).message})`);
	}
	const citations = reconcile(answer, entries);
	const failing = citations.filter(row => FAILING.has(row.status)).length;
	const warnings = citations.filter(row => WARNING.has(row.status)).length;
	if (json) process.stdout.write(`${JSON.stringify({ ledger, session: session ?? null, citations, failing, warnings }, null, 2)}\n`);
	else process.stdout.write(`${table(citations)}\n\n${citations.length} citations: ${failing} failing, ${warnings} warnings.\n`);
	return failing > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
