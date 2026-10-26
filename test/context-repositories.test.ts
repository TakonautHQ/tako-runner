import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writablePaths } from "../src/sandbox";
import { makeWorkspaceTools } from "../src/workspace-tools";
import {
	changeableRepositories,
	claimContextRepositories,
	cleanupRunnerCheckout,
	collectRunChanges,
	runPrArguments,
	makeRunnerTools,
	prepareContextCheckouts,
	repositoriesSection,
	runnerToolRoot,
	type RunnerClaim,
} from "../src/runner";

const APP = "11111111-1111-4111-8111-111111111111";
const API = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(root: string, name: string, file: string): { path: string; sha: string } {
	const path = join(root, name);
	execFileSync("git", ["init", "-q", path]);
	execFileSync("git", ["-C", path, "config", "user.name", "Runner Test"]);
	execFileSync("git", ["-C", path, "config", "user.email", "runner@test.invalid"]);
	writeFileSync(join(path, file), `${name} code\n`);
	execFileSync("git", ["-C", path, "add", file]);
	execFileSync("git", ["-C", path, "commit", "-q", "-m", "first"]);
	execFileSync("git", ["-C", path, "remote", "add", "origin", `https://github.com/acme/${name}.git`]);
	return { path, sha: execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
}

function claim(context: NonNullable<RunnerClaim["revision_spec"]["context_repositories"]>): RunnerClaim {
	return {
		run_id: "33333333-3333-4333-8333-333333333333",
		project_id: "project-1",
		event_key: "event-1",
		input: "Investigate.",
		trigger_payload: {},
		definition_snapshot: {
			agent_profile_id: "p",
			agent_profile_revision_id: "r",
			agent_profile_revision_hash: "a".repeat(64),
			agent_profile_snapshot: { tool_grants: { allow: ["read", "grep", "list", "find"] } },
		},
		revision_spec: { type: "repository.branch_head", context_repositories: context },
		operation_snapshot: {},
		publication_specs: [],
		reviewed_repository_id: "main",
		repository: { id: "main", owner: "acme", name: "platform", default_branch: "develop" },
		reviewed_head_sha: "b".repeat(40),
		output_destination: null,
		autonomy: "observe",
		lease_expires_at: new Date().toISOString(),
		run_token: "t",
	};
}

describe("repositories read alongside", () => {
	it("checks out each at its commit, reports one it can't, and cleans up", async () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-context-"));
		roots.push(root);
		const app = repo(root, "app", "screen.dart");
		const api = repo(root, "api", "routes.py");
		const events: [string, Record<string, unknown>][] = [];
		const current = claim([
			{ repository_id: APP, owner: "acme", name: "app", sha: app.sha, branch: "master" },
			{ repository_id: API, owner: "acme", name: "api", sha: api.sha, branch: null },
		]);
		const worktrees = join(root, "worktrees");
		const result = await prepareContextCheckouts(current, { [APP]: app.path }, worktrees, async (_key, type, metadata = {}) => {
			events.push([type, metadata]);
		});
		expect(result.checkouts.map((item) => [item.label, item.sha, item.branch])).toEqual([["app", app.sha, "master"]]);
		const checkout = result.checkouts[0]!;
		expect(existsSync(join(checkout.path, "screen.dart"))).toBe(true);
		expect(events).toEqual([
			["context_repository_ready", { repository_id: APP, sha: app.sha }],
			["context_repository_unavailable", { repository_id: API, reason: "This Runner has no local clone of it" }],
		]);

		// The file tools reach it by name; the main repository stays the default.
		current.context_checkouts = result.checkouts;
		const main = join(root, "main");
		expect(runnerToolRoot(main, current)).toBe(main);
		expect(runnerToolRoot(main, current, "app")).toBe(checkout.path);
		expect(runnerToolRoot(main, current, "acme/app")).toBe(checkout.path);
		expect(() => runnerToolRoot(main, current, "api")).toThrow(/Unknown repository api; this Run has platform, app/);
		const read = makeRunnerTools(main, current).find((tool) => tool.name === "runner_read")!;
		const output = await read.execute("1", { path: "screen.dart", repository: "app" } as never, undefined, undefined, undefined as never);
		expect(JSON.stringify(output)).toContain("app code");

		expect(repositoriesSection(current)).toContain(`acme/app (repository: "app") at ${app.sha.slice(0, 7)} on master, read-only`);

		await cleanupRunnerCheckout({ cwd: main, repositoryRoot: app.path, worktreePath: join(root, "unused"), contexts: result.contexts }).catch(() => undefined);
		expect(existsSync(checkout.path)).toBe(false);
	});

	it("refuses a clone of a different repository", async () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-context-"));
		roots.push(root);
		const other = repo(root, "other", "x.txt");
		const events: string[] = [];
		const result = await prepareContextCheckouts(
			claim([{ repository_id: APP, owner: "acme", name: "app", sha: other.sha }]),
			{ [APP]: other.path },
			join(root, "worktrees"),
			async (_key, _type, metadata = {}) => {
				events.push(String(metadata.reason));
			},
		);
		expect(result.checkouts).toEqual([]);
		expect(events[0]).toMatch(/isn't github.com\/acme\/app/);
	});

	it("keeps only valid entries and labels two of the same name apart", () => {
		const sha = "c".repeat(40);
		const items = claimContextRepositories(
			claim([
				{ repository_id: APP, owner: "acme", name: "platform", sha },
				{ repository_id: API, owner: "acme", name: "api", sha: "nope" },
				{ repository_id: "not-a-uuid", owner: "acme", name: "x", sha },
			]),
		);
		expect(items.map((item) => item.label)).toEqual(["acme/platform"]);
		expect(repositoriesSection(claim([]))).toBe("");
	});
});

describe("changing several repositories", () => {
	async function world(appMayChange: boolean, platformMayChange = true) {
		const root = mkdtempSync(join(tmpdir(), "takonaut-changes-"));
		roots.push(root);
		const platform = repo(root, "platform", "routes.py");
		const app = repo(root, "app", "screen.dart");
		const current = claim([{ repository_id: APP, owner: "acme", name: "app", sha: app.sha, branch: "master", may_change: appMayChange }]);
		current.reviewed_head_sha = platform.sha;
		current.reviewed_repository_id = API;
		current.revision_spec.may_change = platformMayChange;
		const result = await prepareContextCheckouts(current, { [APP]: app.path }, join(root, "worktrees"));
		current.context_checkouts = result.checkouts;
		return { root, platform, app, current, checkout: result.checkouts[0]! };
	}

	it("collects the changes of each repository into one proposal", async () => {
		const { platform, current, checkout } = await world(true);
		expect(changeableRepositories(platform.path, current).map((item) => item.label)).toEqual(["platform", "app"]);
		writeFileSync(join(platform.path, "routes.py"), "fixed api\n");
		writeFileSync(join(checkout.path, "screen.dart"), "fixed screen\n");
		const collected = collectRunChanges(platform.path, current);
		const args = runPrArguments({ title: "Fix plan expiry" }, collected, current);
		expect(args.title).toBe("Fix plan expiry");
		expect(args.files).toBeUndefined();
		const changes = args.changes as { repository_id: string; base_sha: string; files: { path: string }[] }[];
		expect(changes.map((item) => [item.repository_id, item.base_sha, item.files.map((file) => file.path)])).toEqual([
			[API, platform.sha, ["routes.py"]],
			[APP, checkout.sha, ["screen.dart"]],
		]);
	});

	it("keeps the one-repository shape when only the working directory changed", async () => {
		const { platform, current } = await world(true);
		writeFileSync(join(platform.path, "routes.py"), "fixed api\n");
		const args = runPrArguments({ title: "Fix" }, collectRunChanges(platform.path, current), current);
		expect(args.base_sha).toBe(platform.sha);
		expect((args.files as { path: string }[]).map((file) => file.path)).toEqual(["routes.py"]);
		expect(args.changes).toBeUndefined();
	});

	it("refuses to write a read-only repository, and the sandbox can't either", async () => {
		const { root, platform, current, checkout } = await world(false, false);
		expect(changeableRepositories(platform.path, current)).toEqual([]);
		const tools = makeWorkspaceTools({
			worktree: platform.path,
			sandbox: "macos",
			paths: { worktree: platform.path, tmp: root, writable: [], readOnlyWorktree: true, home: root },
			worktreeLabel: "acme/platform",
			worktreeMayChange: false,
			repositories: [{ label: "app", fullName: "acme/app", path: checkout.path, mayChange: false }],
		});
		const write = tools.find((tool) => tool.name === "runner_write")!;
		const call = (params: object) => write.execute("1", params as never, undefined, undefined, undefined as never);
		await expect(call({ path: "routes.py", content: "x" })).rejects.toThrow("acme/platform is read-only in this Run");
		await expect(call({ path: "screen.dart", content: "x", repository: "app" })).rejects.toThrow("acme/app is read-only");
		expect(writablePaths({ worktree: platform.path, tmp: root, writable: [], readOnlyWorktree: true, home: root })).toEqual([root]);
		expect(repositoriesSection(current)).toContain("acme/platform (repository: \"platform\")");
		expect(repositoriesSection(current)).toContain("read-only");
		expect(repositoriesSection(current)).not.toContain("main");
	});

	it("writes a repository it may change by name", async () => {
		const { root, platform, checkout } = await world(true);
		const tools = makeWorkspaceTools({
			worktree: platform.path,
			sandbox: "macos",
			paths: { worktree: platform.path, tmp: root, writable: [checkout.path], home: root },
			worktreeLabel: "acme/platform",
			repositories: [{ label: "app", fullName: "acme/app", path: checkout.path, mayChange: true }],
		});
		const edit = tools.find((tool) => tool.name === "runner_edit")!;
		await edit.execute("1", { path: "screen.dart", old_text: "app code", new_text: "fixed", repository: "app" } as never, undefined, undefined, undefined as never);
		expect(readFileSync(join(checkout.path, "screen.dart"), "utf8")).toBe("fixed\n");
	});
});

describe.runIf(process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))("the macOS sandbox", () => {
	it("blocks writes to a read-only working directory but not to one it may change", async () => {
		const { runSandboxed } = await import("../src/sandbox");
		const root = realpathSync(mkdtempSync(join(tmpdir(), "takonaut-sandbox-")));
		roots.push(root);
		const locked = join(root, "locked");
		const open = join(root, "open");
		mkdirSync(locked);
		mkdirSync(open);
		const paths = { worktree: locked, tmp: join(root, "tmp"), writable: [open], readOnlyWorktree: true, home: root };
		mkdirSync(paths.tmp);
		const denied = await runSandboxed("macos", paths, "echo x > here.txt", { timeoutMs: 10_000 });
		expect(denied.exitCode).not.toBe(0);
		expect(existsSync(join(locked, "here.txt"))).toBe(false);
		const allowed = await runSandboxed("macos", paths, `echo x > ${open}/there.txt`, { timeoutMs: 10_000 });
		expect(allowed.exitCode).toBe(0);
		expect(existsSync(join(open, "there.txt"))).toBe(true);
	});
});
