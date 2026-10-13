// Live runs against real omp, driven by test/scripted-provider.ts instead of a model, so they need no
// network and no provider account. Opt-in, under `bun run test` like the rest of the suite:
//   WEB_GUARD_LIVE=1        run these tests
//   OMP_CLI                 omp's src/cli.ts, run with bun (or OMP_BIN: an installed omp executable)
//   WEB_GUARD_LIVE_OUT      optional folder for evidence, one subfolder per run; must not exist yet
// test/sites.ts stands in for the web: 127.0.0.1 is the public site (each run's config exempts
// 127.0.0.1/32) and 127.0.0.2 the internal service. Every run gets its own HOME, TMPDIR, and project
// inside the suite's temporary root, and loads the package with one `-e`, as the README says.
// omp 18.2.8 runs the AC-8 scenarios; omp 18.4.4 and later the additionalContext scenario (AC-9).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ledgerLines, PACKAGE, removeCreated, tempDir, writeFile } from "./helpers";
import type { ScriptStep } from "./scripted-provider";
import { CANARY, MARKER, PAGES, type Sites, startSites } from "./sites";

const LIVE = process.env.WEB_GUARD_LIVE === "1";
const OMP = process.env.OMP_CLI ? ["bun", process.env.OMP_CLI] : process.env.OMP_BIN ? [process.env.OMP_BIN] : [];
const OUT = process.env.WEB_GUARD_LIVE_OUT;
const PROVIDER = path.join(import.meta.dir, "scripted-provider.ts");
const OVERLAY = path.join(PACKAGE, "examples", "overlay.yml");
const RUN_TIMEOUT_MS = 120_000;

function ompVersion(): string {
	if (!LIVE || OMP.length === 0) return "";
	const ran = Bun.spawnSync([...OMP, "--version"], { stdout: "pipe", stderr: "pipe" });
	return /(\d+\.\d+\.\d+)/.exec(ran.stdout.toString())?.[1] ?? "";
}

const VERSION = ompVersion();
const parts = VERSION.split(".").map(Number);
const NEW_OMP = parts.length === 3 && (parts[0] > 18 || (parts[0] === 18 && (parts[1] > 4 || (parts[1] === 4 && parts[2] >= 4))));

type Frame = Record<string, unknown>;
interface Message {
	role?: string;
	content?: unknown;
	isError?: boolean;
}

interface World {
	root: string;
	home: string;
	tmp: string;
	work: string;
	ledger: string;
}

interface Run {
	name: string;
	dir: string;
	world: World;
	frames: Frame[];
	requests: Array<{ request: number; systemPrompt?: unknown; messages: Message[] }>;
	notices: string[];
	stderr: string;
	exitCode: number | null;
	internalRequests: string[];
	publicRequests: string[];
}

let sites: Sites;
beforeAll(() => {
	if (LIVE) sites = startSites();
});
afterAll(() => {
	sites?.stop();
	removeCreated();
});

function newWorld(): World {
	const root = tempDir("wg-live-");
	const home = path.join(root, "home");
	const tmp = path.join(root, "tmp");
	const work = path.join(home, "work", "repo");
	const ledger = path.join(root, "ledger.jsonl");
	fs.mkdirSync(tmp, { recursive: true });
	writeFile(path.join(work, ".git", "HEAD"), "ref: refs/heads/main\n");
	writeFile(path.join(work, "README.md"), "# fixture\n");
	writeFile(path.join(home, ".config", "omp-web-guard", "config.json"), `${JSON.stringify({ ledger, allowRanges: ["127.0.0.1/32"], lookupTimeoutMs: 2000 }, null, 2)}\n`);
	return { root, home, tmp, work, ledger };
}

function evidenceDir(name: string): string {
	if (!OUT) return tempDir("wg-run-");
	const dir = path.join(OUT, name);
	if (fs.existsSync(dir)) throw new Error(`${dir} already exists; evidence folders are never overwritten`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function sanitize(text: string, world: World): string {
	const omp = process.env.OMP_CLI ? path.dirname(path.dirname(path.dirname(process.env.OMP_CLI))) : process.env.OMP_BIN ? path.dirname(process.env.OMP_BIN) : "";
	let out = text.split(world.root).join("<run>").split(PACKAGE).join("<package>");
	for (const bun of new Set([process.execPath, fs.realpathSync(process.execPath)])) out = out.split(bun).join("<bun>");
	if (omp) out = out.split(omp).join("<omp>");
	return out.split(`127.0.0.1:${sites.publicPort}`).join("127.0.0.1:<public-port>").split(`127.0.0.2:${sites.internalPort}`).join("127.0.0.2:<internal-port>");
}

async function waitFor(probe: () => boolean, what: string, failed: () => string | undefined): Promise<void> {
	const deadline = Date.now() + RUN_TIMEOUT_MS;
	for (;;) {
		if (probe()) return;
		const failure = failed();
		if (failure) throw new Error(`${what}: ${failure}`);
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n");
}

function lastMessages(run: Run): Message[] {
	return run.requests.at(-1)?.messages ?? [];
}

/** The tool results the scripted model received, in order. */
function toolResults(run: Run): string[] {
	return lastMessages(run)
		.filter(message => message.role === "toolResult")
		.map(message => textOf(message.content));
}

async function runOmp(world: World, name: string, options: { guard: boolean; tools: string; steps: ScriptStep[]; configs?: string[] }): Promise<Run> {
	const dir = evidenceDir(name);
	const slug = name.replaceAll("/", "-");
	const script = path.join(world.root, `${slug}.script.json`);
	const log = path.join(world.root, `${slug}.requests.jsonl`);
	fs.writeFileSync(script, JSON.stringify({ steps: options.steps }));
	const internalBefore = sites.internalRequests.length;
	const publicBefore = sites.publicRequests.length;
	const command = [
		...OMP,
		"--mode",
		"rpc",
		"--no-extensions",
		"-e",
		PROVIDER,
		...(options.guard ? ["-e", PACKAGE] : []),
		"--model",
		"scripted/scripted",
		"--approval-mode",
		"yolo",
		"--session-dir",
		path.join(world.root, "sessions", slug),
		"--no-title",
		"--no-lsp",
		"--no-rules",
		"--no-skills",
		"--tools",
		options.tools,
		...(options.configs ?? []).flatMap(file => ["--config", file]),
	];
	const proc = Bun.spawn(command, {
		cwd: world.work,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: world.home,
			USER: process.env.USER ?? "user",
			LANG: "C.UTF-8",
			TERM: "dumb",
			TMPDIR: world.tmp,
			SCRIPTED_PROVIDER_SCRIPT: script,
			SCRIPTED_PROVIDER_LOG: log,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const frames: Frame[] = [];
	const stdout = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					if (line.trim()) frames.push(JSON.parse(line) as Frame);
				} catch {}
			}
		}
	})();
	const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
	const failed = () => {
		if (proc.exitCode !== null) return `exited with ${proc.exitCode}`;
		const rejected = frames.find(frame => frame.type === "response" && frame.id === "p1" && frame.success === false);
		return rejected ? `prompt rejected: ${JSON.stringify(rejected)}` : undefined;
	};
	try {
		await waitFor(() => frames.some(frame => frame.type === "ready"), "ready", failed);
		proc.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "Summarize the omp-widgets 4.2 release notes, one source per sentence." })}\n`);
		proc.stdin.flush();
		await waitFor(() => frames.some(frame => frame.type === "agent_end" && frame.isTerminal !== false), "the end of the turn", failed);
	} finally {
		proc.stdin.end();
		const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(30_000).then(() => false)]);
		if (!exited) proc.kill();
		await stdout;
	}
	const stderr = await stderrText;
	const requestsText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
	const requests = requestsText
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Run["requests"][number]);
	const notices = frames.filter(frame => frame.type === "extension_ui_request" && frame.method === "notify").map(frame => String(frame.message ?? ""));
	const run: Run = {
		name,
		dir,
		world,
		frames,
		requests,
		notices,
		stderr,
		exitCode: proc.exitCode,
		internalRequests: sites.internalRequests.slice(internalBefore),
		publicRequests: sites.publicRequests.slice(publicBefore),
	};
	fs.writeFileSync(path.join(dir, "cmd.txt"), `${sanitize(command.join(" "), world)}\n`);
	fs.writeFileSync(path.join(dir, "events.jsonl"), sanitize(frames.map(frame => JSON.stringify(frame)).join("\n"), world));
	fs.writeFileSync(path.join(dir, "provider-requests.jsonl"), sanitize(requestsText, world));
	fs.writeFileSync(path.join(dir, "stderr.txt"), sanitize(stderr, world));
	fs.writeFileSync(path.join(dir, "ledger.jsonl"), sanitize(fs.existsSync(world.ledger) ? fs.readFileSync(world.ledger, "utf8") : "", world));
	return run;
}

function record(run: Run, checks: Record<string, unknown>): void {
	const summary = {
		run: run.name,
		omp: VERSION,
		exitCode: run.exitCode,
		requestsReceived: run.requests.length,
		notices: run.notices,
		toolResultsSeenByModel: toolResults(run),
		internalServiceRequests: run.internalRequests,
		publicSiteRequests: run.publicRequests,
		checks,
	};
	fs.writeFileSync(path.join(run.dir, "summary.json"), `${sanitize(JSON.stringify(summary, null, 2), run.world)}\n`);
}

const read = (url: string): ScriptStep => ({ toolCalls: [{ name: "read", arguments: { path: url } }] });
const turnEnded = (run: Run) => run.frames.some(frame => frame.type === "agent_end");
const NONCE = /<<untrusted-web-content-([0-9a-f]{16})>>/;
const LABEL_START = "[UNTRUSTED WEB CONTENT";

function searxngOverlay(world: World): string {
	const text = ["modelRoles:", "  web: web/searxng", "retry:", "  fallbackChains:", "    web: []", "searxng:", `  endpoint: ${sites.publicBase}`, ""].join("\n");
	return writeFile(path.join(world.root, "searxng.yml"), text);
}

async function baseline(name: string) {
	const world = newWorld();
	const run = await runOmp(world, name, { guard: false, tools: "read", steps: [read(`${sites.publicBase}${PAGES.redirect}`), read(`${sites.publicBase}${PAGES.alternate}`), { text: "done" }] });
	const results = toolResults(run);
	const checks = {
		exitCode: run.exitCode,
		redirectLeakedMarker: results[0]?.includes(MARKER) ?? false,
		alternateLeakedMarker: results[1]?.includes(MARKER) ?? false,
		internalServiceAsked: run.internalRequests.length > 0,
		turnEnded: turnEnded(run),
	};
	record(run, checks);
	expect(checks).toEqual({ exitCode: 0, redirectLeakedMarker: true, alternateLeakedMarker: true, internalServiceAsked: true, turnEnded: true });
}

describe.skipIf(!LIVE || NEW_OMP)("live on real omp 18.2.8, scripted model, local sites (AC-8)", () => {
	it("baseline: without the guards, a 302 and a markdown alternate put the internal marker in front of the model", () => baseline("baseline/1-redirect-and-alternate"), 300_000);

	it("guard: a direct read of the internal service is blocked before any request reaches it", async () => {
		const world = newWorld();
		const internal = `${sites.internalBase}/metadata`;
		const run = await runOmp(world, "guard/1-direct-internal", {
			guard: true,
			tools: "read,grep",
			steps: [read(internal), { toolCalls: [{ name: "grep", arguments: { pattern: "INTERNAL", path: internal } }] }, read(`http://[::ffff:127.0.0.2]:${sites.internalPort}/metadata`), { text: "done" }],
		});
		const results = toolResults(run);
		const preBlocks = ledgerLines(world.ledger).filter(line => line.event === "ssrf-block" && line.phase === "pre");
		const checks = {
			exitCode: run.exitCode,
			sessionNotice: run.notices.some(n => n.includes("URL guard on") && n.includes("127.0.0.1/32")),
			readBlocked: results[0]?.includes("omp-web-guard blocked read: 127.0.0.2 is a loopback address") ?? false,
			grepBlocked: results[1]?.includes("omp-web-guard blocked grep") ?? false,
			mappedBlocked: results[2]?.includes("omp-web-guard blocked read") ?? false,
			markerNeverShown: !results.some(text => text.includes(MARKER)),
			internalServiceRequests: run.internalRequests.length,
			ledgerPreBlocks: preBlocks.length,
			turnEnded: turnEnded(run),
		};
		record(run, checks);
		expect(checks).toEqual({ exitCode: 0, sessionNotice: true, readBlocked: true, grepBlocked: true, mappedBlocked: true, markerNeverShown: true, internalServiceRequests: 0, ledgerPreBlocks: 3, turnEnded: true });
	}, 300_000);

	it("guard: the 302 and the alternate are withheld, the ledger names where they ended, the same-host control passes", async () => {
		const world = newWorld();
		const run = await runOmp(world, "guard/2-redirect-and-alternate", {
			guard: true,
			tools: "read",
			steps: [read(`${sites.publicBase}${PAGES.redirect}`), read(`${sites.publicBase}${PAGES.alternate}`), read(`${sites.publicBase}${PAGES.control}`), { text: "done" }],
		});
		const results = toolResults(run);
		const fetched = ledgerLines(world.ledger).filter(line => line.event === "fetched");
		const host = `127.0.0.1:${sites.publicPort}`;
		const internal = `127.0.0.2:${sites.internalPort}`;
		const checks = {
			exitCode: run.exitCode,
			redirectWithheld: (results[0]?.includes("[WITHHELD by web-url guard") ?? false) && !results[0]?.includes(MARKER),
			alternateWithheld: (results[1]?.includes("[WITHHELD by web-url guard") ?? false) && !results[1]?.includes(MARKER),
			controlLabelled: results[2]?.includes(`[UNTRUSTED WEB CONTENT from ${host}${PAGES.control}`) ?? false,
			ledgerRedirect: fetched.some(line => line.requested === `${host}${PAGES.redirect}` && line.finalUrl === `${internal}/metadata` && line.withheld === true),
			ledgerAlternate: fetched.some(
				line => line.requested === `${host}${PAGES.alternate}` && JSON.stringify(line.via) === JSON.stringify([{ kind: "markdown alternate", source: `${internal}/metadata.md` }]) && line.withheld === true,
			),
			ledgerControl: fetched.some(line => line.requested === `${host}${PAGES.control}` && line.withheld === false),
			redirectHopReachedInternalService: run.internalRequests.length > 0,
			turnEnded: turnEnded(run),
		};
		record(run, checks);
		expect(checks).toEqual({
			exitCode: 0,
			redirectWithheld: true,
			alternateWithheld: true,
			controlLabelled: true,
			ledgerRedirect: true,
			ledgerAlternate: true,
			ledgerControl: true,
			redirectHopReachedInternalService: true,
			turnEnded: true,
		});
	}, 300_000);

	it("guard: plain bait is blocked, reworded bait is only labelled, the SearXNG snippet bait is blocked", async () => {
		const world = newWorld();
		const run = await runOmp(world, "guard/3-bait", {
			guard: true,
			tools: "read,web_search",
			configs: [searxngOverlay(world)],
			steps: [read(`${sites.publicBase}${PAGES.plain}`), read(`${sites.publicBase}${PAGES.reworded}`), { toolCalls: [{ name: "web_search", arguments: { query: "omp-widgets 4.2 release notes" } }] }, { text: "done" }],
		});
		const results = toolResults(run);
		const lines = ledgerLines(world.ledger);
		const checks = {
			exitCode: run.exitCode,
			plainBlocked: (results[0]?.startsWith("[BLOCKED by web-content guard") ?? false) && !results[0]?.includes("/collect"),
			rewordedLabelledOnly: (results[1]?.startsWith("[UNTRUSTED WEB CONTENT") ?? false) && NONCE.test(results[1] ?? "") && (results[1]?.includes(CANARY) ?? false),
			searchBlocked: (results[2]?.startsWith("[BLOCKED by web-content guard: content from web_search:") ?? false) && !results[2]?.includes("/collect"),
			ledgerBlocks: lines.filter(line => line.event === "block").length,
			ledgerLabels: lines.filter(line => line.event === "label").length,
			beaconRequested: run.publicRequests.includes("/collect"),
			turnEnded: turnEnded(run),
		};
		record(run, checks);
		expect(checks).toEqual({ exitCode: 0, plainBlocked: true, rewordedLabelledOnly: true, searchBlocked: true, ledgerBlocks: 2, ledgerLabels: 1, beaconRequested: false, turnEnded: true });
	}, 300_000);

	it("overlay: examples/overlay.yml makes bash fail without running it", async () => {
		const world = newWorld();
		const run = await runOmp(world, "guard/4-overlay", {
			guard: true,
			tools: "read,bash",
			configs: [OVERLAY],
			steps: [{ toolCalls: [{ name: "bash", arguments: { command: "echo ran > marker.txt" } }] }, { text: "done" }],
		});
		const result = lastMessages(run).find(message => message.role === "toolResult");
		const checks = {
			exitCode: run.exitCode,
			bashResultIsError: result?.isError === true,
			bashDidNotRun: !fs.existsSync(path.join(world.work, "marker.txt")),
			turnEnded: turnEnded(run),
		};
		record(run, { ...checks, bashResult: textOf(result?.content) });
		expect(checks).toEqual({ exitCode: 0, bashResultIsError: true, bashDidNotRun: true, turnEnded: true });
	}, 300_000);
});

describe.skipIf(!LIVE || !NEW_OMP)("live on omp 18.4.4 or later, scripted model, local sites (AC-9)", () => {
	it("baseline: without the guards, a 302 and a markdown alternate still put the internal marker in front of the model", () => baseline("v18-baseline/1-redirect-and-alternate"), 300_000);

	it("guard: the label reaches the model outside the tool result, the result keeps the original inside the boundary, the 302 is withheld", async () => {
		const world = newWorld();
		const run = await runOmp(world, "v18-guard/1-label-channel", {
			guard: true,
			tools: "read",
			steps: [read(`${sites.publicBase}${PAGES.clean}`), read(`${sites.publicBase}${PAGES.redirect}`), { text: "done" }],
		});
		const results = toolResults(run);
		const nonce = NONCE.exec(results[0] ?? "")?.[1] ?? "none";
		const label = `[UNTRUSTED WEB CONTENT from 127.0.0.1:${sites.publicPort}${PAGES.clean}`;
		const outside = lastMessages(run).filter(message => message.role !== "toolResult");
		const carrier = outside.find(message => textOf(message.content).includes(label));
		const checks = {
			exitCode: run.exitCode,
			noticeSaysAdditionalContext: run.notices.some(n => n.includes("outside the tool result (additionalContext)")),
			resultKeepsOriginalInBoundary: results[0]?.includes(`<<untrusted-web-content-${nonce}>>`) === true && results[0].includes("exponential backoff"),
			resultHasNoLabel: !(results[0] ?? "").includes(LABEL_START),
			labelOutsideToolResult: carrier !== undefined,
			labelNamesTheNonce: carrier !== undefined && textOf(carrier.content).includes(`<<untrusted-web-content-${nonce}>>`),
			redirectWithheld: (results[1]?.includes("[WITHHELD by web-url guard") ?? false) && !results[1]?.includes(MARKER),
			turnEnded: turnEnded(run),
		};
		record(run, { ...checks, labelCarrierRole: carrier?.role ?? null });
		expect(checks).toEqual({
			exitCode: 0,
			noticeSaysAdditionalContext: true,
			resultKeepsOriginalInBoundary: true,
			resultHasNoLabel: true,
			labelOutsideToolResult: true,
			labelNamesTheNonce: true,
			redirectWithheld: true,
			turnEnded: true,
		});
	}, 300_000);
});
