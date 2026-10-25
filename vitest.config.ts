import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Tests never read this machine's Pi model configuration.
		env: { TAKONAUT_RUNNER_ADVERTISE_MODELS: "0" },
	},
});
