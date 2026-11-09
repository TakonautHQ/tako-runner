import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests never write this machine's Runner files.
const home = mkdtempSync(join(tmpdir(), "tako-runner-test-"));

export default defineConfig({
	test: {
		env: {
			// Tests never read this machine's Pi model configuration.
			TAKONAUT_RUNNER_ADVERTISE_MODELS: "0",
			TAKONAUT_RUNNER_SEALING_KEY: join(home, "runner-sealing-key.json"),
			TAKONAUT_RUNNER_TOOLS: join(home, "tools.json"),
			TAKONAUT_RUNNER_TOOL_SCRIPTS: join(home, "tool-scripts"),
		},
	},
});
