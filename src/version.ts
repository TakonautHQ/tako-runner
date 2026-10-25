import { readFileSync } from "node:fs";

/** This package's version, reported to Takonaut and to MCP servers. */
export const RUNNER_VERSION: string = (() => {
	try {
		const parsed = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version.slice(0, 32) : "unknown";
	} catch {
		return "unknown";
	}
})();
