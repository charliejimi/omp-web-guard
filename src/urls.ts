// Which web URLs a tool call names, read the way omp 18.2.8 reads them (tools/fetch.ts
// parseReadUrlTarget, tools/path-utils.ts delimited paths), and how a URL is written to the ledger.
// A URL starts at the beginning of a path string or after a delimiter omp splits on; every reading
// omp might pick (the whole token, the token cut at a comma or semicolon, a trailing `:selector`
// peeled off) is returned, so a check of all of them covers the one omp fetches.

const URL_START = /https?:\/|www\./gi;
const AFTER_DELIMITER = /[\s,;"'`]/;
const TOKEN_END = /[\s"'`<>]/;
const URL_SHAPED = /^(https?:\/\/?|www\.)/i;
// omp's read selector grammar (`raw`, `-N`, and comma lists of `N`, `N-M`, `N+K`, `N..M`), slightly wider.
const RANGE = String.raw`L?\d+(?:(?:\.\.|[-+])L?\d*)?`;
const SELECTOR = new RegExp(String.raw`^(?:raw|-\d+|${RANGE}(?:,${RANGE})*)$`, "i");

/** Restores the double slash in a collapsed scheme (`http:/x`), as omp does before reading. */
export function repairCollapsedScheme(value: string): string {
	const m = /^(https?):\/(?!\/)/i.exec(value);
	return m ? `${m[1]}://${value.slice(m[0].length)}` : value;
}

/** True when omp's read takes the whole path as one URL instead of splitting it into several paths. */
export function isWholeUrlPath(value: string): boolean {
	return URL_SHAPED.test(repairCollapsedScheme(value));
}

/** URL-shaped tokens in one path string, in order. */
export function urlTokens(text: string): string[] {
	const tokens: string[] = [];
	for (const m of text.matchAll(URL_START)) {
		const start = m.index ?? 0;
		if (start > 0 && !AFTER_DELIMITER.test(text[start - 1])) continue;
		const rest = text.slice(start);
		const end = rest.search(TOKEN_END);
		tokens.push(end < 0 ? rest : rest.slice(0, end));
	}
	return tokens;
}

function pathStrings(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const out: string[] = [];
	for (const key of ["path", "paths"]) {
		const value = (input as Record<string, unknown>)[key];
		if (typeof value === "string") out.push(value);
		else if (Array.isArray(value)) for (const item of value) if (typeof item === "string") out.push(item);
	}
	return out;
}

/** The URL tokens in a tool input's `path` and `paths` fields (a string, a list, or a JSON list in a string). */
export function urlsInInput(input: unknown): string[] {
	return pathStrings(input).flatMap(urlTokens);
}

/** The `artifact://N` ids a tool input's path fields name. */
export function artifactIdsInInput(input: unknown): string[] {
	return [...new Set(pathStrings(input).flatMap(artifactIds))];
}

/** The `artifact://N` ids a text mentions, e.g. omp's "Read artifact://7 for full output". */
export function artifactIds(text: string): string[] {
	return [...new Set([...text.matchAll(/artifact:\/\/(\d+)/g)].map(m => m[1]))];
}

function readings(token: string): string[] {
	const out = new Set<string>([token]);
	const cut = token.search(/[,;]/);
	if (cut > 0) out.add(token.slice(0, cut));
	for (const reading of [...out]) {
		const trimmed = reading.replace(/[)\]}]+$/, "");
		if (trimmed) out.add(trimmed);
		let peeled = reading;
		for (let i = 0; i < 4; i++) {
			const colon = peeled.lastIndexOf(":");
			if (colon <= 0 || !SELECTOR.test(peeled.slice(colon + 1)) || !URL_SHAPED.test(peeled.slice(0, colon))) break;
			peeled = peeled.slice(0, colon);
			out.add(peeled);
		}
	}
	return [...out];
}

/** Every http(s) URL omp might fetch for one token; empty when no reading parses. */
export function interpretations(token: string): URL[] {
	const urls = new Map<string, URL>();
	for (const reading of readings(token)) {
		const repaired = repairCollapsedScheme(reading);
		const normalized = /^https?:\/\//i.test(repaired) ? repaired : `https://${repaired}`;
		try {
			const url = new URL(normalized);
			if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname) urls.set(url.href, url);
		} catch {}
	}
	return [...urls.values()];
}

/** The host a URL connects to: lower case, no brackets, no trailing dots. */
export function hostOf(url: URL): string {
	return url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
}

const MAX_SOURCE = 200;

/** Host and path of a URL, never the query or fragment: a query can carry whatever the agent was told to send. */
export function sourceOf(url: URL): string {
	return `${url.host}${url.pathname}`.slice(0, MAX_SOURCE);
}

/** sourceOf for a URL as written; a token that does not parse is cut before its query. */
export function sourceOfToken(token: string): string {
	const url = interpretations(token)[0];
	return url ? sourceOf(url) : token.split(/[?#]/)[0].slice(0, 80);
}

export interface Via {
	kind: string;
	url: string;
}

const NOTE_KINDS: Array<[RegExp, string]> = [
	[/^Used markdown alternate:\s*/i, "markdown alternate"],
	[/^Used feed alternate:\s*/i, "feed alternate"],
	[/^Used llms\.txt fallback:\s*/i, "llms.txt fallback"],
	[/^Extracted and converted document:\s*/i, "extracted document"],
];

/** The other URLs a URL read fetched its content from, from omp's `details.notes`. */
export function viaOf(notes: unknown): Via[] {
	if (!Array.isArray(notes)) return [];
	const out: Via[] = [];
	for (const note of notes) {
		if (typeof note !== "string") continue;
		const known = NOTE_KINDS.find(([re]) => re.test(note));
		if (known) {
			// omp passes the rest of the note to fetch() as written, and fetch reads `http:host`,
			// `http:/host`, and `http:\\host` as `http://host`; canonicalize the same way so the check
			// sees the host omp fetched. Text that does not parse stays as written and fails the check.
			const raw = note.replace(known[0], "").trim();
			let url = raw;
			try {
				url = new URL(raw).href;
			} catch {}
			out.push({ kind: known[1], url });
			continue;
		}
		for (const m of note.matchAll(/https?:\/\/[^\s]+/gi)) out.push({ kind: "note", url: m[0].replace(/[.,;)\]]+$/, "") });
	}
	return out;
}
