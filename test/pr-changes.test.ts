import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectPrChanges, PR_TOOL, prArguments } from "../src/pr-changes";
import { makeTrustedRunnerTools, type RunnerApi, type RunnerClaim } from "../src/runner";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): { cwd: string; sha: string } {
	const cwd = mkdtempSync(join(tmpdir(), "pr-changes-"));
	dirs.push(cwd);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	writeFileSync(join(cwd, "keep.txt"), "same\n");
	writeFileSync(join(cwd, "jobs.py"), "broken\n");
	writeFileSync(join(cwd, "old.txt"), "bye\n");
	git("add", ".");
	git("commit", "-qm", "base");
	return { cwd, sha: git("rev-parse", "HEAD") };
}

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("pull requests with the Agent's changes", () => {
	it("collects edits, new files, deletions and executable bits since the base commit", () => {
		const { cwd, sha } = repo();
		writeFileSync(join(cwd, "jobs.py"), "fixed\n");
		writeFileSync(join(cwd, "new.sh"), "#!/bin/sh\n");
		chmodSync(join(cwd, "new.sh"), 0o755);
		unlinkSync(join(cwd, "old.txt"));
		const changes = collectPrChanges(cwd, sha);
		expect(changes.files).toEqual([
			{ path: "jobs.py", content_b64: b64("fixed\n"), mode: "100644" },
			{ path: "new.sh", content_b64: b64("#!/bin/sh\n"), mode: "100755" },
			{ path: "old.txt", content_b64: null, mode: "100644" },
		]);
		expect(changes.diff).toContain("+fixed");
		expect(prArguments({ title: "Fix", files: "ignored", base_sha: "x" }, changes, sha)).toEqual({
			title: "Fix",
			base_sha: sha,
			files: changes.files,
			diff: changes.diff,
		});
	});

	it("refuses symbolic links", () => {
		const { cwd, sha } = repo();
		symlinkSync("/etc/passwd", join(cwd, "link"));
		expect(() => collectPrChanges(cwd, sha)).toThrow(/symbolic link/);
	});

	it("attaches the changes itself and is offered only to Agents that can edit", async () => {
		const { cwd, sha } = repo();
		const invoke = vi.fn(async () => ({
			id: "a1",
			status: "executed",
			execution_target: "server_proxy",
			result_metadata: { content: "Proposed as action #1" },
		}));
		const api = {
			trustedTools: vi.fn(async () => [
				{ type: "function", function: { name: PR_TOOL, description: "server", parameters: { type: "object" } } },
				{ type: "function", function: { name: "get_task", description: "read", parameters: { type: "object" } } },
			]),
			invokeTrustedTool: invoke,
			consumeTrustedAction: vi.fn(),
		} as unknown as RunnerApi;
		const claim = { run_id: "r", run_token: "t", reviewed_head_sha: sha } as unknown as RunnerClaim;

		const readOnly = await makeTrustedRunnerTools(cwd, claim, api, undefined, { canEdit: false });
		expect(readOnly.map((tool) => tool.name)).toEqual(["get_task"]);

		const tools = await makeTrustedRunnerTools(cwd, claim, api, undefined, { canEdit: true });
		const pr = tools.find((tool) => tool.name === PR_TOOL);
		expect(pr?.parameters).toMatchObject({ required: ["title"] });
		const empty = await pr?.execute("c0", { title: "Nothing" }, undefined, undefined, undefined as never);
		expect(JSON.stringify(empty)).toContain("haven't changed any files");
		expect(invoke).not.toHaveBeenCalled();

		writeFileSync(join(cwd, "jobs.py"), "fixed\n");
		await pr?.execute("c1", { title: "Fix jobs", files: [{ path: "evil" }] }, undefined, undefined, undefined as never);
		const sent = invoke.mock.calls[0] as unknown as [string, string, string, string, Record<string, unknown>];
		expect(sent[2]).toBe(PR_TOOL);
		expect(sent[4]).toMatchObject({ title: "Fix jobs", base_sha: sha, files: [{ path: "jobs.py", content_b64: b64("fixed\n") }] });
	});

	it("a Run carries on when Takonaut tools are unavailable", async () => {
		const api = { trustedTools: vi.fn(async () => Promise.reject(new Error("404"))) } as unknown as RunnerApi;
		const claim = { run_id: "r", run_token: "t" } as unknown as RunnerClaim;
		expect(await makeTrustedRunnerTools("/tmp", claim, api)).toEqual([]);
	});
});

describe("git outside the sandbox", () => {
	it("ignores an fsmonitor or diff driver planted in the worktree config", () => {
		const { cwd, sha } = repo();
		const marker = join(cwd, "..", `pwned-${Date.now()}`);
		const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
		git("config", "core.fsmonitor", `touch ${marker}; false`);
		git("config", "diff.external", `touch ${marker}`);
		writeFileSync(join(cwd, ".gitattributes"), "*.py diff=evil\n");
		git("config", "diff.evil.textconv", `touch ${marker}; cat`);
		writeFileSync(join(cwd, "jobs.py"), "fixed\n");
		const changes = collectPrChanges(cwd, sha);
		expect(changes.files.map((file) => file.path)).toContain("jobs.py");
		expect(() => execFileSync("test", ["-e", marker])).toThrow();
	});
});
