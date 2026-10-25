import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerDaemonConfig } from "../src/runner";
import {
	cloneUrls,
	ensureManagedClone,
	managedRepositoryPath,
	provisionRepositories,
	type GitRunner,
} from "../src/runner-provision";
import type { RunnerSetupCatalog } from "../src/runner-setup";

const catalog: RunnerSetupCatalog = {
	organization: { id: "org-1", name: "Acme" },
	runner: { id: "runner-1", name: "Mac", capacity: 1 },
	projects: [
		{
			id: "p1",
			name: "Platform",
			key: "PL",
			repositories: [
				{ id: "r1", owner: "Acme", name: "Api", default_branch: "main" },
				{ id: "r2", owner: "Acme", name: "App", default_branch: "main" },
			],
		},
	],
};

const config: RunnerDaemonConfig = {
	serverUrl: "https://takonaut.test",
	organizationId: "org-1",
	credential: "tkr_x",
	pollIntervalMs: 2000,
	leaseSeconds: 90,
	repositories: {},
};

/** Fake git: "clones" by creating a real repository with the requested origin. */
function fakeGit(failFor: string[] = []): { git: GitRunner; calls: string[][] } {
	const calls: string[][] = [];
	const git: GitRunner = (args) => {
		calls.push(args);
		if (args[0] === "clone") {
			const [url, path] = args.slice(-2);
			if (failFor.some((name) => url.includes(name))) {
				const error = new Error("clone failed") as Error & { stderr: string };
				error.stderr = "Cloning into x...\nERROR: Repository not found.\n";
				throw error;
			}
			execFileSync("git", ["init", "-q", path]);
			execFileSync("git", ["-C", path, "remote", "add", "origin", url]);
			return "";
		}
		if (args.includes("fetch")) return "";
		return execFileSync("git", args, { encoding: "utf8" });
	};
	return { git, calls };
}

describe("Runner-owned clones", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	const temp = () => {
		const root = mkdtempSync(join(tmpdir(), "tako-repos-"));
		roots.push(root);
		return root;
	};

	it("rejects path traversal in repository names", () => {
		expect(() => managedRepositoryPath("/r", { owner: "..", name: "x" })).toThrow();
		expect(() => managedRepositoryPath("/r", { owner: "a", name: "b/c" })).toThrow();
		expect(managedRepositoryPath("/r", { owner: "Acme", name: "Api" })).toBe("/r/Acme/Api");
	});

	it("tries SSH before HTTPS", () => {
		expect(cloneUrls({ owner: "a", name: "b" })).toEqual([
			"git@github.com:a/b.git",
			"https://github.com/a/b.git",
		]);
	});

	it("clones every catalog repository and binds it", () => {
		const root = temp();
		const { git } = fakeGit();
		const { config: next, results } = provisionRepositories(config, catalog, { root, git });
		expect(results.map((r) => r.status)).toEqual(["cloned", "cloned"]);
		expect(next.repositoryBindings?.r1).toEqual({
			projectId: "p1",
			path: join(root, "Acme", "Api"),
			trustedNative: true,
		});
	});

	it("fetches an existing clone instead of cloning again", () => {
		const root = temp();
		const { git, calls } = fakeGit();
		provisionRepositories(config, catalog, { root, git });
		calls.length = 0;
		const { results } = provisionRepositories(config, catalog, { root, git });
		expect(results.map((r) => r.status)).toEqual(["updated", "updated"]);
		expect(calls.some((c) => c[0] === "clone")).toBe(false);
	});

	it("reports a clone failure with git's reason and keeps going", () => {
		const root = temp();
		const { git } = fakeGit(["Api"]);
		const { config: next, results } = provisionRepositories(config, catalog, { root, git });
		expect(results[0].status).toBe("failed");
		expect(results[0].reason).toContain("Repository not found");
		expect(results[1].status).toBe("cloned");
		expect(next.repositoryBindings?.r1).toBeUndefined();
	});

	it("keeps a developer checkout chosen with --path unless replaced", () => {
		const root = temp();
		const { git } = fakeGit();
		const withPath: RunnerDaemonConfig = {
			...config,
			repositoryBindings: { r1: { projectId: "p1", path: "/dev/checkout" } },
		};
		const kept = provisionRepositories(withPath, catalog, { root, git });
		expect(kept.results[0].status).toBe("kept");
		const replaced = provisionRepositories(withPath, catalog, { root, git, replace: true });
		expect(replaced.config.repositoryBindings?.r1.path).toBe(join(root, "Acme", "Api"));
	});

	it("refuses to adopt a directory cloned from another repository", () => {
		const root = temp();
		const path = join(root, "Acme", "Api");
		mkdirSync(path, { recursive: true });
		execFileSync("git", ["init", "-q", path]);
		execFileSync("git", ["-C", path, "remote", "add", "origin", "git@github.com:evil/other.git"]);
		expect(() => ensureManagedClone({ owner: "Acme", name: "Api" }, root, fakeGit().git)).toThrow(
			/not a clone of Acme\/Api/,
		);
	});
});
