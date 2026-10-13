import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

export const PACKAGE = path.resolve(import.meta.dir, "..");

/** The temporary root test/run.ts created; test/setup.ts already checked HOME and TMPDIR are inside it. */
export const TEST_ROOT = fs.realpathSync(process.env.WG_TEST_ROOT ?? "/nonexistent-test-root");

/** Deletes `target` only when its real path is strictly inside the suite's temporary root. */
export function safeRemove(target: string): void {
	let real: string;
	try {
		real = fs.realpathSync(target);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	const rel = path.relative(TEST_ROOT, real);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to delete ${target}: outside the test root`);
	fs.rmSync(real, { recursive: true, force: true });
}

const created: string[] = [];

/** A new directory under the suite's TMPDIR. */
export function tempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	created.push(dir);
	return dir;
}

export function removeCreated(): void {
	for (const dir of created.splice(0)) safeRemove(dir);
}

export function writeFile(file: string, text: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

export type LedgerLine = Record<string, unknown> & { event: string };

export function ledgerLines(file: string): LedgerLine[] {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as LedgerLine);
}

let entries = 0;

/**
 * An extension entry that loads one guard with explicit options and no config file. The URL guard
 * gets the fake resolver from test/fake-dns.ts, so no test asks a real DNS server.
 */
export function writeEntry(dir: string, guard: "url" | "content", options: Record<string, unknown> = {}): string {
	fs.mkdirSync(dir, { recursive: true });
	const entry = path.join(dir, `${guard}-guard-${++entries}.ts`);
	const opts = JSON.stringify({ configPath: null, ...options }, null, "\t");
	const source =
		guard === "url"
			? [
					`import { createWebUrlGuard } from ${JSON.stringify(path.join(PACKAGE, "src", "url-guard.ts"))};`,
					`import { fakeResolve } from ${JSON.stringify(path.join(PACKAGE, "test", "fake-dns.ts"))};`,
					`export default createWebUrlGuard({ ...${opts}, resolve: fakeResolve });`,
				]
			: [
					`import { createWebContentGuard } from ${JSON.stringify(path.join(PACKAGE, "src", "content-guard.ts"))};`,
					`export default createWebContentGuard(${opts});`,
				];
	fs.writeFileSync(entry, `${source.join("\n")}\n`);
	return entry;
}

let registry: { auth: AuthStorage; models: ModelRegistry; dir: string } | undefined;

async function models(): Promise<ModelRegistry> {
	if (!registry) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-auth-"));
		const auth = await AuthStorage.create(path.join(dir, "auth.db"));
		registry = { auth, models: new ModelRegistry(auth), dir };
	}
	return registry.models;
}

export function closeRegistry(): void {
	if (!registry) return;
	registry.auth.close();
	safeRemove(registry.dir);
	registry = undefined;
}

export interface Notice {
	message: string;
	type: string | undefined;
}

export interface ToolCallOutcome {
	block?: boolean;
	reason?: string;
}

export interface Content {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface ToolResultOutcome {
	content?: Content[];
	details?: unknown;
	isError?: boolean;
}

export interface ResultEvent {
	toolName: string;
	input: Record<string, unknown>;
	content: Content[];
	details?: unknown;
	isError?: boolean;
	toolCallId?: string;
}

export interface Loaded {
	runner: ExtensionRunner;
	notices: Notice[];
	sessionId: string;
	toolCall(toolName: string, input: Record<string, unknown>, toolCallId?: string): Promise<ToolCallOutcome | undefined>;
	toolResult(event: ResultEvent): Promise<ToolResultOutcome | undefined>;
}

let calls = 0;

/** Loads extension entries through omp's own loader and runner, in order, and starts the session in `cwd`. */
export async function loadExtensions(paths: string[], cwd: string): Promise<Loaded> {
	const result = await discoverAndLoadExtensions(paths, cwd, undefined, undefined, { ambient: false });
	const extensions = paths.map(p => result.extensions.find(ext => ext.path === p)).filter(ext => ext !== undefined);
	const loadErrors = result.errors.filter(err => paths.includes(err.path));
	if (loadErrors.length > 0 || extensions.length !== paths.length) {
		throw new Error(`extensions did not load: ${JSON.stringify(loadErrors)} (${extensions.length} loaded)`);
	}
	const sessionManager = SessionManager.inMemory(cwd);
	const runner = new ExtensionRunner(extensions, result.runtime, cwd, sessionManager, await models());
	const notices: Notice[] = [];
	const ui = { notify: (message: string, type?: string) => notices.push({ message, type }) };
	const tools = ["read", "grep", "ast_grep", "ast_edit", "web_search", "bash"];
	runner.initialize({ getActiveTools: () => tools, getAllTools: () => [] } as never, {} as never, undefined, ui as never, "rpc");
	await runner.emit({ type: "session_start" } as never);
	return {
		runner,
		notices,
		sessionId: sessionManager.getSessionId(),
		toolCall: (toolName, input, toolCallId = `call-${++calls}`) =>
			runner.emitToolCall({ type: "tool_call", toolCallId, toolName, input } as never) as Promise<ToolCallOutcome | undefined>,
		toolResult: event =>
			runner.emitToolResult({
				type: "tool_result",
				toolCallId: event.toolCallId ?? `call-${++calls}`,
				isError: false,
				details: undefined,
				...event,
			} as never) as Promise<ToolResultOutcome | undefined>,
	};
}

export function textOf(content: Content[] | undefined): string {
	return (content ?? [])
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

/** A `read` result shaped like omp 18.2.8's fetch.ts output for a URL. */
export function urlReadResult(
	url: string,
	body: string,
	options: { finalUrl?: string; notes?: string[]; method?: string; extra?: Content[]; toolCallId?: string } = {},
): ResultEvent {
	const finalUrl = options.finalUrl ?? url;
	const notes = options.notes ?? [];
	const header = `URL: ${finalUrl}\nContent-Type: text/html\nMethod: ${options.method ?? "native"}\n${notes.length > 0 ? `Notes: ${notes.join("; ")}\n` : ""}`;
	return {
		toolName: "read",
		toolCallId: options.toolCallId,
		input: { path: url },
		content: [{ type: "text", text: `${header}\n---\n\n${body}` }, ...(options.extra ?? [])],
		details: { kind: "url", url, finalUrl, contentType: "text/html", method: options.method ?? "native", truncated: false, notes },
		isError: false,
	};
}
