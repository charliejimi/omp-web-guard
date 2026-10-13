// The user's configuration, read from one file. Nothing here reads environment variables: Bun loads
// a project's .env into omp's environment, and the guards must not take their trust from the project.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Cidr, parseCidr } from "./net";

export type LabelChannel = "auto" | "content" | "additionalContext";
const LABEL_CHANNELS: readonly LabelChannel[] = ["auto", "content", "additionalContext"];

export interface DomainPolicy {
	/** When set, web reads may reach only these hosts and their subdomains. */
	allow?: string[];
	/** Web reads may not reach these hosts or their subdomains; deny wins over allow. */
	deny?: string[];
}

export interface WebGuardConfig {
	/** The ledger both guards append to: absolute, or starting with `~/`. Default `~/.omp/web-guard-ledger.jsonl`. */
	ledger?: string;
	/** CIDRs exempt from the internal-address block, e.g. `["10.20.0.0/16"]`. `/0` is refused. */
	allowRanges?: string[];
	domainPolicy?: DomainPolicy;
	/** Where the content guard puts its label: `auto` (default), `content`, or `additionalContext`. */
	labelChannel?: LabelChannel;
	/** Wrap labelled web text in a boundary with a random nonce. Default `true`. */
	nonceBoundary?: boolean;
	/** How long a DNS lookup may take before the URL guard blocks the call: 100–20000 ms, default 5000. */
	lookupTimeoutMs?: number;
}

export const CONFIG_KEYS: readonly (keyof WebGuardConfig)[] = ["ledger", "allowRanges", "domainPolicy", "labelChannel", "nonceBoundary", "lookupTimeoutMs"];

export interface GuardSettings {
	ledger: string;
	allowRanges: Cidr[];
	domainAllow: string[];
	domainDeny: string[];
	labelChannel: LabelChannel;
	nonceBoundary: boolean;
	lookupTimeoutMs: number;
}

export interface GuardOptions extends WebGuardConfig {
	/** The config file to read; `null` reads none. Defaults to `~/.config/omp-web-guard/config.json`. */
	configPath?: string | null;
}

export function defaultConfigPath(): string {
	return path.join(os.homedir(), ".config", "omp-web-guard", "config.json");
}

export function defaultLedgerPath(): string {
	return path.join(os.homedir(), ".omp", "web-guard-ledger.jsonl");
}

/** A path for messages, with the home directory written as `~`. */
export function shown(file: string): string {
	const rel = path.relative(os.homedir(), file);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel}` : file;
}

function stringList(value: unknown, key: string, file: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.trim() === "")) throw new Error(`${file}: "${key}" must be a list of strings`);
	return value as string[];
}

/** Reads the config file; a missing file is an empty config, anything malformed throws. */
export function loadConfig(file: string): WebGuardConfig {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(`${file}: not valid JSON (${(err as Error).message})`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file}: expected a JSON object`);
	const data = raw as Record<string, unknown>;
	const unknown = Object.keys(data).filter(key => !(CONFIG_KEYS as readonly string[]).includes(key));
	if (unknown.length > 0) throw new Error(`${file}: unknown setting ${unknown.map(key => `"${key}"`).join(", ")}`);
	if (data.ledger !== undefined && typeof data.ledger !== "string") throw new Error(`${file}: "ledger" must be a path`);
	if (data.nonceBoundary !== undefined && typeof data.nonceBoundary !== "boolean") throw new Error(`${file}: "nonceBoundary" must be true or false`);
	if (data.lookupTimeoutMs !== undefined && typeof data.lookupTimeoutMs !== "number") throw new Error(`${file}: "lookupTimeoutMs" must be a number`);
	if (data.labelChannel !== undefined && typeof data.labelChannel !== "string") throw new Error(`${file}: "labelChannel" must be a string`);
	let domainPolicy: DomainPolicy | undefined;
	if (data.domainPolicy !== undefined) {
		const policy = data.domainPolicy;
		if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error(`${file}: "domainPolicy" must be an object with "allow" and/or "deny"`);
		const extra = Object.keys(policy).filter(key => key !== "allow" && key !== "deny");
		if (extra.length > 0) throw new Error(`${file}: unknown domainPolicy setting ${extra.map(key => `"${key}"`).join(", ")}`);
		const p = policy as Record<string, unknown>;
		domainPolicy = { allow: stringList(p.allow, "domainPolicy.allow", file), deny: stringList(p.deny, "domainPolicy.deny", file) };
	}
	return {
		ledger: data.ledger as string | undefined,
		allowRanges: stringList(data.allowRanges, "allowRanges", file),
		domainPolicy,
		labelChannel: data.labelChannel as LabelChannel | undefined,
		nonceBoundary: data.nonceBoundary as boolean | undefined,
		lookupTimeoutMs: data.lookupTimeoutMs as number | undefined,
	};
}

function resolveLedger(value: string | undefined): string {
	if (value === undefined) return defaultLedgerPath();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	if (!path.isAbsolute(value)) throw new Error(`"ledger" must be absolute or start with ~/ (got "${value}")`);
	return value;
}

/** A domain policy entry as the URL parser writes hosts: lower case, punycode, no trailing dot. */
export function normalizeDomain(entry: string): string {
	const bare = entry.trim().replace(/^\*?\./, "");
	if (!bare || /[/?#@:\s]/.test(bare)) throw new Error(`domainPolicy: "${entry}" is not a host name`);
	let host: string;
	try {
		host = new URL(`http://${bare}`).hostname;
	} catch {
		throw new Error(`domainPolicy: "${entry}" is not a host name`);
	}
	return host.replace(/\.+$/, "").toLowerCase();
}

/** Applies defaults and checks every value; throws on the first invalid one. */
export function resolveSettings(config: WebGuardConfig): GuardSettings {
	const allowRanges = (config.allowRanges ?? []).map(range => {
		try {
			return parseCidr(range);
		} catch (err) {
			throw new Error(`allowRanges: ${(err as Error).message}`);
		}
	});
	const labelChannel = config.labelChannel ?? "auto";
	if (!LABEL_CHANNELS.includes(labelChannel)) throw new Error(`"labelChannel" must be one of ${LABEL_CHANNELS.map(c => `"${c}"`).join(", ")} (got "${labelChannel}")`);
	const lookupTimeoutMs = config.lookupTimeoutMs ?? 5_000;
	if (!Number.isInteger(lookupTimeoutMs) || lookupTimeoutMs < 100 || lookupTimeoutMs > 20_000) throw new Error(`"lookupTimeoutMs" must be a whole number from 100 to 20000 (got ${lookupTimeoutMs})`);
	return {
		ledger: resolveLedger(config.ledger),
		allowRanges,
		domainAllow: (config.domainPolicy?.allow ?? []).map(normalizeDomain),
		domainDeny: (config.domainPolicy?.deny ?? []).map(normalizeDomain),
		labelChannel,
		nonceBoundary: config.nonceBoundary ?? true,
		lookupTimeoutMs,
	};
}

function stripUndefined<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

/**
 * The settings a guard runs with: the config file, then explicit options on top. An unusable
 * config is reported as `error` with the defaults (and the configured ledger when that part is
 * valid), so the guard can stay loaded and fail closed instead of disappearing.
 */
export function guardSettings(options: GuardOptions): { settings: GuardSettings; error?: string } {
	const { configPath = defaultConfigPath(), ...overrides } = options;
	let config: WebGuardConfig = {};
	try {
		if (configPath !== null) config = loadConfig(configPath);
		config = { ...stripUndefined(config), ...stripUndefined(overrides) };
		return { settings: resolveSettings(config) };
	} catch (err) {
		let ledger = defaultLedgerPath();
		try {
			ledger = resolveLedger(config.ledger ?? overrides.ledger);
		} catch {}
		return { settings: { ...resolveSettings({}), ledger }, error: (err as Error).message };
	}
}
