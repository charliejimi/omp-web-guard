// omp-web-guard, URL guard: keeps web reads away from internal addresses.
//   tool_call (read, grep, ast_grep, ast_edit): every URL in the path fields is checked before the
//     tool runs, first against the optional domain policy, then every address its host resolves
//     to. One internal address blocks the call unless allowRanges exempts it; a lookup that fails
//     or times out blocks too. A read that names a URL among other paths is blocked, because omp
//     reads those parts without the extension hooks, so neither guard would see the result.
//   tool_result (read of a URL): omp follows redirects and markdown or feed alternates by itself,
//     so the final URL and every URL in the result's notes are checked the same way; one internal
//     or denied address withholds the whole result, and the artifact omp saved it to stays blocked.
//     Every URL read is recorded with where it ended.
// It sees the URL before the call and the final URL after it, not each hop: a redirect hop still
// reaches the internal service before the result is withheld, and DNS may answer differently when
// omp connects. The network layer closes those; see examples/egress.nft.
import * as dns from "node:dns/promises";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type GuardOptions, type GuardSettings, guardSettings, shown } from "./config";
import { openLedger } from "./ledger";
import { classifyAddress, parseIp, type Verdict } from "./net";
import { artifactIds, artifactIdsInInput, hostOf, interpretations, isWholeUrlPath, sourceOf, sourceOfToken, urlsInInput, type Via, viaOf } from "./urls";

export type Resolver = (host: string) => Promise<string[]>;

export interface UrlGuardOptions extends GuardOptions {
	/** Resolves a host name to its addresses. Defaults to the system resolver, the one omp's fetch uses. */
	resolve?: Resolver;
}

export const PRECHECK_TOOLS: readonly string[] = ["read", "grep", "ast_grep", "ast_edit"];
export const MAX_URLS_PER_CALL = 20;

const systemResolve: Resolver = async host => (await dns.lookup(host, { all: true, verbatim: true })).map(answer => answer.address);

type Blocked = Extract<Verdict, { blocked: true }>;

type Problem =
	| { kind: "internal"; url: URL; host: string; verdict: Blocked }
	| { kind: "domain"; url: URL; host: string; rule: "deny" | "allow" }
	| { kind: "lookup-failed"; url: URL; host: string; code: string }
	| { kind: "lookup-timeout"; url: URL; host: string }
	| { kind: "unparseable"; token: string };

type Found = { index: number; problem: Problem };

type Answer = { addresses: string[] } | { failed: "timeout" } | { failed: "error"; code: string };

const ARTICLE: Record<string, string> = { unspecified: "an", "unique-local": "a", unparseable: "an" };

function describeAddress(host: string, verdict: Blocked): string {
	const carried = verdict.embedded ? ` (it carries ${verdict.embedded.ipv4}, ${verdict.embedded.form})` : "";
	const kind = verdict.category === "metadata" ? "a cloud metadata" : `${ARTICLE[verdict.category] ?? "a"} ${verdict.category}`;
	const what = `${kind} address (${verdict.range}${verdict.note ? `, ${verdict.note}` : ""})`;
	return parseIp(host) ? `${host}${carried} is ${what}` : `${host} resolves to ${verdict.address}${carried}, ${what}`;
}

function describe(problem: Problem, timeoutMs: number): string {
	switch (problem.kind) {
		case "internal":
			return describeAddress(problem.host, problem.verdict);
		case "domain":
			return problem.rule === "deny" ? `${problem.host} is on the domainPolicy deny list` : `${problem.host} is not on the domainPolicy allow list`;
		case "lookup-failed":
			return `${problem.host} could not be resolved (${problem.code}), so the guard cannot check its address`;
		case "lookup-timeout":
			return `${problem.host} did not resolve within ${timeoutMs} ms, so the guard cannot check its address`;
		case "unparseable":
			return `"${sourceOfToken(problem.token)}" looks like a URL but cannot be parsed, so the guard cannot check its address`;
	}
}

function domainRule(host: string, s: GuardSettings): "deny" | "allow" | undefined {
	const covers = (domain: string) => host === domain || host.endsWith(`.${domain}`);
	if (s.domainDeny.some(covers)) return "deny";
	if (s.domainAllow.length > 0 && !s.domainAllow.some(covers)) return "allow";
	return undefined;
}

async function lookup(host: string, resolve: Resolver, timeoutMs: number): Promise<Answer> {
	if (parseIp(host)) return { addresses: [host] };
	if (host === "localhost" || host.endsWith(".localhost")) return { addresses: ["127.0.0.1", "::1"] };
	const { promise, resolve: settle } = Promise.withResolvers<Answer>();
	const timer = setTimeout(() => settle({ failed: "timeout" }), timeoutMs);
	try {
		resolve(host).then(
			addresses => settle(addresses.length > 0 ? { addresses } : { failed: "error", code: "no addresses" }),
			(err: unknown) => settle({ failed: "error", code: String((err as { code?: unknown })?.code ?? (err as Error)?.message ?? "error") }),
		);
		return await promise;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The first reason not to fetch one of `tokens` (with that token's index), or undefined when every
 * reading of every token is public. All lookups run at once, so the whole check takes at most one
 * lookupTimeoutMs, well inside omp's 30 s handler timeout, after which omp would pass the result.
 */
async function check(tokens: readonly string[], s: GuardSettings, resolve: Resolver): Promise<Found | undefined> {
	const targets = tokens.map((token, index) => ({ token, index, urls: interpretations(token) }));
	const unparseable = targets.find(target => target.urls.length === 0);
	if (unparseable) return { index: unparseable.index, problem: { kind: "unparseable", token: unparseable.token } };
	for (const target of targets) {
		for (const url of target.urls) {
			const rule = domainRule(hostOf(url), s);
			if (rule) return { index: target.index, problem: { kind: "domain", url, host: hostOf(url), rule } };
		}
	}
	const hosts = [...new Set(targets.flatMap(target => target.urls.map(hostOf)))];
	const answers = new Map(await Promise.all(hosts.map(async host => [host, await lookup(host, resolve, s.lookupTimeoutMs)] as const)));
	for (const target of targets) {
		for (const url of target.urls) {
			const host = hostOf(url);
			const answer = answers.get(host);
			if (!answer || "failed" in answer) {
				const problem: Problem = answer?.failed === "timeout" ? { kind: "lookup-timeout", url, host } : { kind: "lookup-failed", url, host, code: answer && "code" in answer ? answer.code : "error" };
				return { index: target.index, problem };
			}
			for (const address of answer.addresses) {
				const verdict = classifyAddress(address, s.allowRanges);
				if (verdict.blocked) return { index: target.index, problem: { kind: "internal", url, host, verdict } };
			}
		}
	}
	return undefined;
}

function problemFields(problem: Problem): Record<string, unknown> {
	if (problem.kind === "unparseable") return { reason: "unparseable", source: sourceOfToken(problem.token), hasQuery: problem.token.includes("?") };
	const base = { source: sourceOf(problem.url), hasQuery: problem.url.search !== "", host: problem.host };
	switch (problem.kind) {
		case "internal":
			return { reason: "internal", ...base, address: problem.verdict.address, category: problem.verdict.category, range: problem.verdict.range, ...(problem.verdict.embedded ? { embedded: problem.verdict.embedded } : {}) };
		case "domain":
			return { ...base, rule: problem.rule };
		case "lookup-failed":
			return { reason: "lookup-failed", ...base, code: problem.code };
		case "lookup-timeout":
			return { reason: "lookup-timeout", ...base };
	}
}

function sessionOf(ctx: unknown): string {
	try {
		const id = (ctx as { sessionManager?: { getSessionId?: () => unknown } })?.sessionManager?.getSessionId?.();
		return typeof id === "string" ? id : "unknown";
	} catch {
		return "unknown";
	}
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("\n");
}

interface ResultPatch {
	content?: (TextContent | ImageContent)[];
	isError?: boolean;
}

function withheld(text: string): ResultPatch {
	return { content: [{ type: "text", text: `[WITHHELD by web-url guard: ${text} The result was not shown; do not try to reach that address another way.]` }], isError: true };
}

export function createWebUrlGuard(options: UrlGuardOptions = {}) {
	return function webUrlGuard(pi: ExtensionAPI): void {
		const { resolve = systemResolve, ...rest } = options;
		const { settings, error } = guardSettings(rest);
		const ledger = openLedger(settings.ledger);
		const withheldArtifacts = new Map<string, Set<string>>();
		const blockReason = (tool: string, text: string) => `omp-web-guard blocked ${tool}: ${text}`;
		const policyNote = () =>
			`Web reads may reach only public addresses${settings.allowRanges.length > 0 ? ` and ${settings.allowRanges.map(r => r.text).join(", ")}` : ""}.`;

		pi.on("session_start", (_event, ctx) => {
			if (error) {
				ctx.ui.notify(`omp-web-guard: the config could not be used (${error}); every URL read is blocked until it is fixed.`, "error");
				return;
			}
			const exceptions = settings.allowRanges.length > 0 ? ` except ${settings.allowRanges.map(r => r.text).join(", ")}` : "";
			const policy = [
				settings.domainAllow.length > 0 ? `allow only ${settings.domainAllow.join(", ")}` : "",
				settings.domainDeny.length > 0 ? `deny ${settings.domainDeny.join(", ")}` : "",
			].filter(Boolean);
			ctx.ui.notify(
				`omp-web-guard: URL guard on for read, grep, ast_grep, and ast_edit. Internal addresses are blocked${exceptions}; domain policy: ${policy.length > 0 ? policy.join("; ") : "none"}; lookups time out after ${settings.lookupTimeoutMs} ms; ledger ${shown(settings.ledger)}.`,
				"info",
			);
		});

		pi.on("tool_call", async (event, ctx) => {
			const tool = event.toolName;
			if (!PRECHECK_TOOLS.includes(tool)) return undefined;
			const input = event.input;
			const tokens = urlsInInput(input);
			const session = sessionOf(ctx);
			const call = event.toolCallId;
			const block = (fields: Record<string, unknown>, text: string, eventName = "ssrf-block") => {
				ledger.append({ event: eventName, session, call, tool, phase: "pre", ...fields });
				return { block: true, reason: blockReason(tool, text) };
			};
			const tainted = artifactIdsInInput(input).find(id => withheldArtifacts.get(session)?.has(id));
			if (tainted) {
				return block({ reason: "withheld-artifact", source: `artifact://${tainted}` }, `artifact://${tainted} holds a web result that was withheld because it reached a blocked address.`);
			}
			if (tokens.length === 0) return undefined;
			if (error) return block({ reason: "config-error", source: sourceOfToken(tokens[0]) }, `the config could not be used (${error}); URL reads are blocked until it is fixed.`);
			const readPath = (input as { path?: unknown }).path;
			if (tool === "read" && typeof readPath === "string" && !isWholeUrlPath(readPath)) {
				return block(
					{ reason: "delimited-read", source: sourceOfToken(tokens[0]) },
					"the path names a URL among other paths, and omp reads those parts without the extension hooks, so the guard could not check where the URL ends up. Read one URL per call.",
				);
			}
			if (tokens.length > MAX_URLS_PER_CALL) {
				return block({ reason: "too-many-urls", source: sourceOfToken(tokens[0]), count: tokens.length }, `the call names ${tokens.length} URLs; the guard checks at most ${MAX_URLS_PER_CALL} per call. Split the work into several calls.`);
			}
			let found: Found | undefined;
			try {
				found = await check(tokens, settings, resolve);
			} catch (err) {
				return block({ reason: "guard-error", source: sourceOfToken(tokens[0]), error: String((err as Error)?.message ?? err) }, "the guard failed while checking the URL, so the call is blocked.");
			}
			if (!found) return undefined;
			const { problem } = found;
			const fields = problemFields(problem);
			return block(fields, `${describe(problem, settings.lookupTimeoutMs)}. ${problem.kind === "internal" ? policyNote() : ""}`.trim(), problem.kind === "domain" ? "domain-block" : "ssrf-block");
		});

		pi.on("tool_result", async (event, ctx): Promise<ResultPatch | undefined> => {
			if (event.toolName !== "read") return undefined;
			const session = sessionOf(ctx);
			const call = event.toolCallId;
			try {
				const details = event.details as { kind?: unknown; url?: unknown; finalUrl?: unknown; method?: unknown; notes?: unknown } | undefined;
				if (!details || details.kind !== "url") return undefined;
				const requested = String(details.url ?? (event.input as { path?: unknown }).path ?? "");
				const finalUrl = String(details.finalUrl ?? requested);
				const via: Via[] = viaOf(details.notes);
				const fetched = {
					event: "fetched",
					session,
					call,
					tool: "read",
					requested: sourceOfToken(requested),
					finalUrl: sourceOfToken(finalUrl),
					via: via.map(v => ({ kind: v.kind, source: sourceOfToken(v.url) })),
					method: typeof details.method === "string" ? details.method : undefined,
				};
				const taint = () => {
					const ids = artifactIds(textOf(event.content));
					if (ids.length === 0) return;
					const set = withheldArtifacts.get(session) ?? new Set<string>();
					for (const id of ids) set.add(id);
					withheldArtifacts.set(session, set);
				};
				if (error) {
					ledger.append({ event: "ssrf-block", session, call, tool: "read", phase: "post", reason: "config-error", source: fetched.finalUrl, requested: fetched.requested });
					ledger.append({ ...fetched, withheld: true });
					taint();
					return withheld(`the guard's config could not be used (${error}), so the read of ${fetched.requested} was not checked.`);
				}
				const steps = [{ token: finalUrl, how: "ended at" }, ...via.map(v => ({ token: v.url, how: `used a ${v.kind} at` })), { token: requested, how: "was for" }];
				const found = await check(steps.map(step => step.token), settings, resolve);
				if (!found) {
					ledger.append({ ...fetched, withheld: false });
					return undefined;
				}
				const { problem, index } = found;
				ledger.append({ event: problem.kind === "domain" ? "domain-block" : "ssrf-block", session, call, tool: "read", phase: "post", ...problemFields(problem), requested: fetched.requested });
				ledger.append({ ...fetched, withheld: true });
				taint();
				const where = problem.kind === "unparseable" ? sourceOfToken(problem.token) : sourceOf(problem.url);
				return withheld(`the read of ${fetched.requested} ${steps[index].how} ${where}; ${describe(problem, settings.lookupTimeoutMs)}.`);
			} catch (err) {
				ledger.append({ event: "ssrf-block", session, call, tool: "read", phase: "post", reason: "guard-error", error: String((err as Error)?.message ?? err) });
				return withheld("the guard could not check where this read ended.");
			}
		});
	};
}

export default createWebUrlGuard();
