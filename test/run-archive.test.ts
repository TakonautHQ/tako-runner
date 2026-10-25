import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneRunArchive, RunRecorder, writeRunArchive } from "../src/run-archive";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Run recorder", () => {
	it("counts calls, failures and shell commands", async () => {
		const recorder = new RunRecorder();
		const ok = recorder.wrap({ name: "runner_shell", execute: async () => "done" });
		const bad = recorder.wrap({
			name: "runner_read",
			execute: async () => {
				throw new Error("no");
			},
		});
		await ok.execute();
		await ok.execute();
		await expect(bad.execute()).rejects.toThrow("no");
		const metrics = recorder.metrics("diff --git a/x b/x\n+1\ndiff --git a/y b/y\n");
		expect(metrics).toMatchObject({ toolCalls: 3, commandsRun: 2, changesMade: 2 });
		expect(recorder.events.map((e) => e.ok)).toEqual([true, true, false]);
	});
});

describe("Run archive", () => {
	it("writes owner-only files and prunes old Runs", () => {
		const root = mkdtempSync(join(tmpdir(), "tako-archive-"));
		roots.push(root);
		const dir = writeRunArchive(
			"16cfad3b-560b-4077-9fba-baee43a67161",
			{ metrics: { toolCalls: 1, commandsRun: 0, changesMade: 0, durationSeconds: 3 }, events: [], model: "anthropic/x", result: "# Done" },
			root,
		);
		expect(dir).not.toBeNull();
		expect(readFileSync(join(dir!, "result.md"), "utf8")).toBe("# Done");
		expect(statSync(join(dir!, "run.json")).mode & 0o077).toBe(0);
		expect(writeRunArchive("../escape", { metrics: { toolCalls: 0, commandsRun: 0, changesMade: 0, durationSeconds: 0 }, events: [], model: null, result: "" }, root)).toBeNull();
		const old = new Date(Date.now() - 8 * 86_400_000);
		utimesSync(dir!, old, old);
		expect(pruneRunArchive(root)).toBe(1);
		expect(existsSync(dir!)).toBe(false);
	});
});
