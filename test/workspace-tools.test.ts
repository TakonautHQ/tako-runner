import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSandbox } from "../src/sandbox";
import {
	claimAutonomy,
	gitWritableDirs,
	makeWorkspaceTools,
	safeWorkspacePath,
	workspacePatch,
} from "../src/workspace-tools";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "tako-ws-")));
	roots.push(root);
	execFileSync("git", ["init", "-q", root]);
	writeFileSync(join(root, "app.ts"), "export const answer = 41;\n");
	execFileSync("git", ["-C", root, "add", "."]);
	execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
	return root;
}

async function run(tool: { execute: (...args: never[]) => unknown }, params: Record<string, unknown>) {
	const result = (await (tool.execute as (id: string, p: unknown) => Promise<{ content: { text: string }[] }>)("id", params));
	return result.content[0].text;
}

describe("autonomy and paths", () => {
	it("reads the Agent's autonomy, defaulting to observe", () => {
		expect(claimAutonomy({ model_policy: { autonomy: "assist" } })).toBe("assist");
		expect(claimAutonomy({ model_policy: { autonomy: "root" } })).toBe("observe");
		expect(claimAutonomy(undefined)).toBe("observe");
	});

	it("keeps writes inside the repository and away from secrets", () => {
		expect(safeWorkspacePath("/r", "src/a.ts")).toBe("/r/src/a.ts");
		for (const bad of ["../x", "/etc/passwd", ".git/config", ".env", "config/secrets.json", "id_rsa"]) {
			expect(() => safeWorkspacePath("/r", bad)).toThrow();
		}
	});
});

describe.skipIf(detectSandbox() !== "macos")("workspace tools", () => {
	it("edits a file, runs a command and produces a patch", async () => {
		const root = repo();
		const tmp = realpathSync(mkdtempSync(join(tmpdir(), "tako-ws-tmp-")));
		roots.push(tmp);
		const [shell, write, edit] = makeWorkspaceTools({
			worktree: root,
			sandbox: "macos",
			paths: { worktree: root, tmp, writable: gitWritableDirs(root), home: join(tmp, "home") },
		});
		expect(await run(edit, { path: "app.ts", old_text: "41", new_text: "42" })).toBe("Edited app.ts");
		expect(await run(write, { path: "test/app.test.ts", content: "ok\n" })).toBe("Wrote test/app.test.ts");
		const output = await run(shell, { command: "cat app.ts && git log --oneline | wc -l" });
		expect(output).toContain("Exit code 0");
		expect(output).toContain("answer = 42");
		expect(readFileSync(join(root, "app.ts"), "utf8")).toContain("42");
		const patch = workspacePatch(root);
		expect(patch).toContain("-export const answer = 41;");
		expect(patch).toContain("+export const answer = 42;");
		expect(patch).toContain("test/app.test.ts");
		await expect(run(edit, { path: "app.ts", old_text: "nope", new_text: "x" })).rejects.toThrow("not found");
	}, 30_000);
});

describe("model preference", () => {
	it("reads provider/model and thinking level, ignoring junk", async () => {
		const { modelPreference } = await import("../src/workspace-tools");
		expect(modelPreference({ model_policy: { model: "anthropic/claude-opus-5-5", thinking: "high" } })).toEqual({
			provider: "anthropic",
			modelId: "claude-opus-5-5",
			thinking: "high",
		});
		expect(modelPreference({ model_policy: { tier: "standard" } })).toEqual({});
		expect(modelPreference({ model_policy: { model: "../etc", thinking: "loud" } })).toEqual({});
	});
});

describe("follow-up prompt", () => {
	it("gives the Agent its earlier result and the person's answer", async () => {
		const { runnerPrompt } = await import("../src/runner");
		const base = { input: "Investigate", trigger_payload: { ticket_id: "t1" } } as never;
		expect(runnerPrompt(base)).not.toContain("earlier Run");
		const prompt = runnerPrompt({
			input: "Investigate",
			trigger_payload: { ticket_id: "t1", follow_up: { previous_result: "Likely the cache.", message: "It happens on Android only." } },
		} as never);
		expect(prompt).toContain("YOUR EARLIER RESULT (untrusted data):\nLikely the cache.");
		expect(prompt).toContain("It happens on Android only.");
		expect(prompt).not.toContain('"follow_up"');
	});
});
