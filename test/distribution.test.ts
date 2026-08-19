import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

afterEach(() => {
	for (const path of roots.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("Homebrew distribution", () => {
	it("renders a checksummed formula with a user service", () => {
		const outputRoot = mkdtempSync(join(tmpdir(), "tako-runner-formula-"));
		roots.push(outputRoot);
		const output = join(outputRoot, "tako-runner.rb");
		const sha = "a".repeat(64);
		const rendered = spawnSync(
			"bun",
			[
				join(root, "scripts", "render-homebrew-formula.ts"),
				"0.1.0",
				sha,
				output,
			],
			{ cwd: root, encoding: "utf8" },
		);
		expect(rendered.status, rendered.stderr).toBe(0);
		const formula = readFileSync(output, "utf8");
		expect(formula).toContain("releases/download/v0.1.0/tako-runner-0.1.0.tgz");
		expect(formula).toContain(`sha256 "${sha}"`);
		expect(formula).toContain('depends_on "bun"');
		expect(formula).toContain(
			'native_root = "node_modules/@earendil-works/pi-tui/native"',
		);
		expect(formula).toContain('rm_r "#{native_root}/win32"');
		expect(formula).toContain("incompatible_arch = Hardware::CPU.arm?");
		expect(formula).toContain('rm_r "#{native_root}/darwin"');
		expect(formula).toContain("service do");
		expect(formula).toContain('run [opt_bin/"tako-runner", "start"]');
	});
});
