import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { normalizeGitHubRemote } from "./git";
import type { RunnerDaemonConfig } from "./runner";

export interface RunnerSetupRepository {
	id: string;
	owner: string;
	name: string;
	default_branch: string;
}

export interface RunnerSetupProject {
	id: string;
	name: string;
	key: string;
	repositories: RunnerSetupRepository[];
}

export interface RunnerSetupAgent {
	id: string;
	name: string;
	slug: string;
}

export interface RunnerSetupCatalog {
	organization: { id: string; name: string };
	runner: { id: string; name: string; capacity: number };
	projects: RunnerSetupProject[];
	agents: RunnerSetupAgent[];
}

export interface RunnerSetupRepositoryMatch {
	projectId: string;
	projectName: string;
	repository: RunnerSetupRepository;
}

export interface RunnerSetupSelection {
	projectId: string;
	repositoryId: string;
	repositoryPath: string;
	agentIds: string[];
}

export interface DetectedRunnerRepository {
	root: string;
	origin: string;
	normalizedOrigin: string;
}

function setupFailure(
	summary: string,
	why: string,
	fixes: string[],
	cause?: unknown,
): Error {
	return new Error(
		[
			summary,
			"",
			"Why this is required",
			`  ${why}`,
			"",
			"How to fix",
			...fixes.map((fix) => `  ${fix}`),
			"",
			"Then retry",
			"  Run the same tako-runner setup command again.",
			"",
			"No Runner was created.",
		].join("\n"),
		cause === undefined ? undefined : { cause },
	);
}

export function matchRunnerSetupRepository(
	catalog: RunnerSetupCatalog,
	origin: string,
): RunnerSetupRepositoryMatch {
	const normalized = normalizeGitHubRemote(origin);
	if (!normalized) {
		throw new Error("The detected origin is not a supported GitHub remote");
	}
	const matches = catalog.projects.flatMap((project) =>
		project.repositories
			.filter(
				(repository) =>
					`github.com/${repository.owner}/${repository.name}`.toLowerCase() ===
					normalized,
			)
			.map((repository) => ({
				projectId: project.id,
				projectName: project.name,
				repository,
			})),
	);
	if (matches.length === 0) {
		throw new Error(
			`Repository ${normalized} is not linked to an approved Project`,
		);
	}
	if (matches.length > 1) {
		throw new Error(
			`Repository ${normalized} matches multiple approved Projects; select a repository ID explicitly`,
		);
	}
	return matches[0] as RunnerSetupRepositoryMatch;
}

export function assertRunnerSetupRepositoryOrigin(
	repository: RunnerSetupRepository,
	origin: string,
): void {
	const normalized = normalizeGitHubRemote(origin);
	const expected =
		`github.com/${repository.owner}/${repository.name}`.toLowerCase();
	if (normalized !== expected) {
		throw new Error(
			`Selected repository ${expected} does not match the detected origin ${normalized || "unknown"}`,
		);
	}
}

export function applyRunnerSetupSelection(
	config: RunnerDaemonConfig,
	selection: RunnerSetupSelection,
): RunnerDaemonConfig {
	if (
		!selection.projectId ||
		!selection.repositoryId ||
		!isAbsolute(selection.repositoryPath) ||
		selection.agentIds.length === 0
	) {
		throw new Error(
			"Runner setup requires a Project, repository, absolute path, and at least one Agent",
		);
	}
	return {
		...config,
		repositoryBindings: {
			...(config.repositoryBindings ?? {}),
			[selection.repositoryId]: {
				projectId: selection.projectId,
				path: selection.repositoryPath,
			},
		},
		agentIds: [...new Set(selection.agentIds)].sort(),
	};
}

export function detectRunnerRepository(
	cwd = process.cwd(),
): DetectedRunnerRepository {
	const requestedPath = resolve(cwd);
	let root: string;
	try {
		root = realpathSync(
			execFileSync(
				"git",
				["-C", requestedPath, "rev-parse", "--show-toplevel"],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			).trim(),
		);
	} catch (error) {
		throw setupFailure(
			`No Git repository was found at ${JSON.stringify(requestedPath)}. Runner setup requires a Git repository; run inside a clone or pass --path /absolute/path/to/repository.`,
			"The Runner must inspect a real local clone and verify its GitHub identity before enrollment.",
			[
				"cd /absolute/path/to/repository",
				"tako-runner setup --url https://takonaut.app",
			],
			error,
		);
	}

	let origin: string;
	try {
		origin = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		throw setupFailure(
			`No Git remote named "origin" was found.`,
			"Tako Runner uses origin to match this clone to a repository explicitly connected to the selected Project.",
			[
				`git -C ${JSON.stringify(root)} remote add origin git@github.com:OWNER/REPOSITORY.git`,
				`git -C ${JSON.stringify(root)} fetch --dry-run --no-tags origin`,
			],
			error,
		);
	}
	const normalizedOrigin = normalizeGitHubRemote(origin);
	if (!normalizedOrigin) {
		throw setupFailure(
			`The Git remote "origin" is not a supported GitHub URL: ${JSON.stringify(origin)}.`,
			"The Runner must compare a canonical GitHub owner/repository identity with the Project's connected repository.",
			[
				`git -C ${JSON.stringify(root)} remote set-url origin git@github.com:OWNER/REPOSITORY.git`,
				`git -C ${JSON.stringify(root)} fetch --dry-run --no-tags origin`,
			],
		);
	}
	return { root, origin, normalizedOrigin };
}

export function verifyRunnerRepositoryFetch(root: string): void {
	try {
		execFileSync(
			"git",
			["-C", root, "fetch", "--dry-run", "--no-tags", "origin"],
			{
				stdio: "pipe",
			},
		);
	} catch (error) {
		throw setupFailure(
			"Runner setup could not fetch origin. Check GitHub authentication and repository access.",
			"A successful fetch proves that this operating-system user can read the exact repository during unattended Runs.",
			[
				"gh auth status",
				`git -C ${JSON.stringify(root)} fetch --dry-run --no-tags origin`,
			],
			error,
		);
	}
}
