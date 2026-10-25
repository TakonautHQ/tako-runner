/**
 * Runner-owned repository clones.
 *
 * `setup` clones every repository of the Projects an administrator approved
 * into `~/.takonaut/repos/<owner>/<name>` and binds it. The Runner never
 * works in a developer's checkout, so local edits, macOS folder privacy
 * prompts (Desktop, Documents) and hand-typed IDs are out of the picture.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeGitHubRemote } from "./git";
import type { RunnerDaemonConfig } from "./runner";
import type { RunnerSetupCatalog, RunnerSetupRepository } from "./runner-setup";

export type GitRunner = (args: string[], cwd?: string) => string;

export const defaultGit: GitRunner = (args, cwd) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});

export function defaultRepositoriesRoot(): string {
	return (
		process.env.TAKONAUT_RUNNER_REPOS ?? join(homedir(), ".takonaut", "repos")
	);
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

export function managedRepositoryPath(
	root: string,
	repository: Pick<RunnerSetupRepository, "owner" | "name">,
): string {
	for (const segment of [repository.owner, repository.name]) {
		if (!SAFE_SEGMENT.test(segment) || segment === "." || segment === "..") {
			throw new Error(`Unsupported repository name: ${segment}`);
		}
	}
	return join(root, repository.owner, repository.name);
}

/** SSH first (deploy keys, agents), then HTTPS (gh credential helper). */
export function cloneUrls(
	repository: Pick<RunnerSetupRepository, "owner" | "name">,
): string[] {
	return [
		`git@github.com:${repository.owner}/${repository.name}.git`,
		`https://github.com/${repository.owner}/${repository.name}.git`,
	];
}

export interface ProvisionedRepository {
	projectId: string;
	projectName: string;
	repositoryId: string;
	fullName: string;
	path: string;
	status: "cloned" | "updated" | "kept" | "failed";
	reason?: string;
}

function firstLine(error: unknown): string {
	const raw =
		error && typeof error === "object" && "stderr" in error
			? String((error as { stderr: unknown }).stderr)
			: error instanceof Error
				? error.message
				: String(error);
	const line = raw
		.split("\n")
		.map((part) => part.trim())
		.find((part) => part.length > 0 && !part.startsWith("Cloning into"));
	return (line ?? "unknown error").slice(0, 300);
}

function sameRepository(
	git: GitRunner,
	path: string,
	repository: Pick<RunnerSetupRepository, "owner" | "name">,
): boolean {
	try {
		const origin = git(["-C", path, "remote", "get-url", "origin"]).trim();
		return (
			normalizeGitHubRemote(origin) ===
			`github.com/${repository.owner}/${repository.name}`.toLowerCase()
		);
	} catch {
		return false;
	}
}

/** Clone or refresh one repository; never touches a foreign directory. */
export function ensureManagedClone(
	repository: Pick<RunnerSetupRepository, "owner" | "name">,
	root = defaultRepositoriesRoot(),
	git: GitRunner = defaultGit,
): { path: string; status: "cloned" | "updated" } {
	const path = managedRepositoryPath(root, repository);
	if (existsSync(path)) {
		if (!sameRepository(git, path, repository)) {
			throw new Error(
				`${path} exists but is not a clone of ${repository.owner}/${repository.name}; move it away and run setup again`,
			);
		}
		git(["-C", path, "fetch", "--quiet", "--prune", "origin"]);
		return { path, status: "updated" };
	}
	mkdirSync(join(root, repository.owner), { recursive: true, mode: 0o700 });
	let lastError: unknown;
	for (const url of cloneUrls(repository)) {
		try {
			git(["clone", "--quiet", "--no-checkout", url, path]);
			return { path, status: "cloned" };
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`Could not clone ${repository.owner}/${repository.name}: ${firstLine(lastError)}. Give this user read access (ssh -T git@github.com, or gh auth login), then run tako-runner repos sync`,
	);
}

/**
 * Clone every catalog repository and bind it. Existing bindings to other
 * paths (a developer checkout chosen with --path) are kept unless `replace`.
 */
export function provisionRepositories(
	config: RunnerDaemonConfig,
	catalog: RunnerSetupCatalog,
	options: {
		root?: string;
		git?: GitRunner;
		replace?: boolean;
		log?: (line: ProvisionedRepository) => void;
	} = {},
): { config: RunnerDaemonConfig; results: ProvisionedRepository[] } {
	const root = options.root ?? defaultRepositoriesRoot();
	const git = options.git ?? defaultGit;
	const bindings = { ...(config.repositoryBindings ?? {}) };
	const results: ProvisionedRepository[] = [];
	for (const project of catalog.projects) {
		for (const repository of project.repositories) {
			const existing = bindings[repository.id];
			const base = {
				projectId: project.id,
				projectName: project.name,
				repositoryId: repository.id,
				fullName: `${repository.owner}/${repository.name}`,
			};
			let result: ProvisionedRepository;
			if (
				existing &&
				!options.replace &&
				existing.path !== managedRepositoryPath(root, repository)
			) {
				result = { ...base, path: existing.path, status: "kept" };
			} else {
				try {
					const clone = ensureManagedClone(repository, root, git);
					bindings[repository.id] = {
						projectId: project.id,
						path: clone.path,
						// Every binding can use Takonaut tools; GitHub writes are
						// still decided per Runner in Takonaut.
						trustedNative: existing?.trustedNative ?? true,
					};
					result = { ...base, path: clone.path, status: clone.status };
				} catch (error) {
					result = {
						...base,
						path: managedRepositoryPath(root, repository),
						status: "failed",
						reason: error instanceof Error ? error.message : String(error),
					};
				}
			}
			results.push(result);
			options.log?.(result);
		}
	}
	return {
		config: { ...config, repositoryBindings: bindings },
		results,
	};
}
