import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CONFIG_KEYS, loadConfig, resolveSettings } from "../src/config";
import { egressPrefixes } from "../src/net";
import { PACKAGE, removeCreated, tempDir } from "./helpers";

afterAll(removeCreated);

const EXAMPLES = path.join(PACKAGE, "examples");

function setElements(text: string, name: string): string[] {
	const m = new RegExp(`set ${name} \\{[\\s\\S]*?elements = \\{([^}]*)\\}`).exec(text);
	if (!m) throw new Error(`set ${name} not found`);
	return m[1]
		.split(",")
		.map(item => item.replace(/#.*$/gm, "").trim())
		.filter(Boolean)
		.sort();
}

describe("examples", () => {
	it("egress.nft says it is untested and drops exactly the guard's default ranges (AC-7)", () => {
		const text = fs.readFileSync(path.join(EXAMPLES, "egress.nft"), "utf8");
		const expected = egressPrefixes();
		expect(text).toMatch(/UNTESTED/);
		expect(setElements(text, "blocked_v4")).toEqual([...expected.v4].sort());
		expect(setElements(text, "blocked_v6")).toEqual([...expected.v6].sort());
	});

	it("overlay.yml denies bash and eval, allows task, and turns async off, as omp itself reads it", async () => {
		const dir = tempDir("wg-overlay-");
		const settings = await Settings.loadReadOnly({ cwd: dir, agentDir: path.join(dir, "agent"), configFiles: [path.join(EXAMPLES, "overlay.yml")] });
		expect(settings.get("tools.approval")).toEqual({ bash: "deny", eval: "deny", task: "allow" });
		expect(settings.get("async.enabled")).toBe(false);
	});

	it("config.example.json sets every setting, and the guard accepts it", () => {
		const config = loadConfig(path.join(EXAMPLES, "config.example.json"));
		expect(Object.keys(config).sort()).toEqual([...CONFIG_KEYS].sort());
		const resolved = resolveSettings(config);
		expect(resolved.allowRanges.map(range => range.text)).toEqual(config.allowRanges ?? []);
	});
});
