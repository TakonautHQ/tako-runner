import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bwrapArgs, detectSandbox, macosProfile, runSandboxed, type SandboxPaths } from "../src/sandbox";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): SandboxPaths & { root: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "tako-sandbox-")));
	roots.push(root);
	const home = join(root, "home");
	const worktree = join(root, "work");
	const tmp = join(root, "tmp");
	for (const dir of [home, worktree, tmp, join(home, ".ssh"), join(home, ".takonaut")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE");
	writeFileSync(join(home, ".takonaut", "runner-credentials.json"), "{\"credential\":\"tkr_secret\"}");
	writeFileSync(join(worktree, "app.txt"), "hello\n");
	return { root, home, worktree, tmp, writable: [] };
}

describe("sandbox profile", () => {
	it("denies network and secret reads, allows worktree writes", () => {
		const paths = fixture();
		const profile = macosProfile(paths);
		expect(profile).toContain("(deny network*)");
		expect(profile).toContain(`(subpath "${paths.worktree}")`);
		expect(profile).toContain(`(subpath "${join(paths.home, ".ssh")}")`);
		const args = bwrapArgs(paths, "true");
		expect(args).toContain("--unshare-net");
		expect(args.join(" ")).toContain(`--tmpfs ${join(paths.home, ".ssh")}`);
	});
});

describe.skipIf(detectSandbox() !== "macos")("sandboxed commands on macOS", () => {
	it("runs tools, writes in the worktree only, and cannot read secrets or reach the network", async () => {
		const paths = fixture();
		const result = await runSandboxed(
			"macos",
			paths,
			[
				"cat app.txt",
				"echo patched > app.txt && echo wrote-worktree",
				`echo x > ${paths.root}/outside 2>/dev/null || echo outside-denied`,
				`cat ${paths.home}/.ssh/id_ed25519 2>/dev/null || echo ssh-denied`,
				`cat ${paths.home}/.takonaut/runner-credentials.json 2>/dev/null || echo credentials-denied`,
				"curl -s -m 3 https://example.com >/dev/null 2>&1 || echo network-denied",
				"git --version >/dev/null && echo git-ok",
			].join("; "),
			{ timeoutMs: 20_000 },
		);
		expect(result.exitCode).toBe(0);
		for (const line of [
			"hello",
			"wrote-worktree",
			"outside-denied",
			"ssh-denied",
			"credentials-denied",
			"network-denied",
			"git-ok",
		]) {
			expect(result.output).toContain(line);
		}
		expect(result.output).not.toContain("PRIVATE");
		expect(result.output).not.toContain("tkr_secret");
		expect(readFileSync(join(paths.worktree, "app.txt"), "utf8")).toBe("patched\n");
	}, 30_000);

	it("stops a command that runs too long", async () => {
		const paths = fixture();
		const result = await runSandboxed("macos", paths, "sleep 30", { timeoutMs: 500 });
		expect(result.timedOut).toBe(true);
	}, 10_000);

	it("caps very large output", async () => {
		const paths = fixture();
		const result = await runSandboxed("macos", paths, "yes | head -c 200000", { timeoutMs: 10_000 });
		expect(result.truncated).toBe(true);
		expect(result.output.length).toBeLessThanOrEqual(50 * 1024);
	}, 15_000);

	it("keeps the environment minimal", async () => {
		const paths = fixture();
		process.env.TAKONAUT_RUNNER_TOKEN = "tkr_leak";
		try {
			const result = await runSandboxed("macos", paths, "env", { timeoutMs: 5_000 });
			expect(result.output).not.toContain("tkr_leak");
			expect(result.output).toContain(`TMPDIR=${paths.tmp}`);
		} finally {
			delete process.env.TAKONAUT_RUNNER_TOKEN;
		}
	});
});

void execFileSync;
