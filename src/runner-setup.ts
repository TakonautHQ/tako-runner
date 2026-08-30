import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
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

export interface RunnerSetupCatalog {
	organization: { id: string; name: string };
	runner: { id: string; name: string; capacity: number };
	projects: RunnerSetupProject[];
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
	trustedNative?: boolean;
}

export interface DetectedRunnerRepository {
	root: string;
	origin: string;
	normalizedOrigin: string;
}

export interface RunnerSetupTrustedNativePrompt {
	interactive: boolean;
	explicit: boolean | undefined;
	existing: boolean | undefined;
	warn: (summary: string, detail: string) => void;
	prompt: (question: string) => Promise<string>;
}

export class RunnerRepositoryNotLinkedError extends Error {
	readonly repository: string;

	constructor(repository: string) {
		super(`Repository ${repository} is not linked to an approved Project`);
		this.name = "RunnerRepositoryNotLinkedError";
		this.repository = repository;
	}
}

export interface RunnerRepositoryLinkProject {
	id: string;
	name: string;
	key: string;
	url: string;
}

export interface RunnerRepositoryLinkRecovery {
	repository: string;
	projects: RunnerRepositoryLinkProject[];
	automaticProject?: RunnerRepositoryLinkProject;
}

export function buildRunnerRepositoryLinkRecovery({
	serverUrl,
	catalog,
	origin,
	explicitProjectId,
}: {
	serverUrl: string;
	catalog: RunnerSetupCatalog;
	origin: string;
	explicitProjectId?: string;
}): RunnerRepositoryLinkRecovery {
	const repository = normalizeGitHubRemote(origin);
	if (!repository) {
		throw new Error("The detected origin is not a supported GitHub remote");
	}
	const eligibleProjects = explicitProjectId
		? catalog.projects.filter((project) => project.id === explicitProjectId)
		: catalog.projects;
	const projects = eligibleProjects.map((project) => ({
		id: project.id,
		name: project.name,
		key: project.key,
		url: new URL(
			`/projects/${encodeURIComponent(project.key)}/code-integration`,
			serverUrl,
		).toString(),
	}));
	return {
		repository,
		projects,
		automaticProject: projects.length === 1 ? projects[0] : undefined,
	};
}

export function presentRunnerRepositoryLinkRecovery(
	recovery: RunnerRepositoryLinkRecovery,
	deps: { log(message: string): void; openUrl(url: string): void },
): void {
	deps.log(`Repository ${recovery.repository} is not linked to an approved Project.`);
	if (recovery.automaticProject) {
		const project = recovery.automaticProject;
		deps.log(
			`Opening Code integration for Project ${project.name} (${project.key}):`,
		);
		deps.log(`  ${project.url}`);
		deps.log(
			"The Runner will not link the repository automatically. Link it in Takonaut, then rerun setup.",
		);
		deps.openUrl(project.url);
		return;
	}
	if (recovery.projects.length === 0) {
		deps.log(
			"No approved Project matches --project-id. Verify the Project selection in Takonaut and rerun setup.",
		);
	} else {
		deps.log(
			"Several approved Projects are available. The Runner cannot safely choose one:",
		);
		for (const project of recovery.projects) {
			deps.log(`  ${project.name} (${project.key}): ${project.url}`);
			deps.log(`    rerun with --project-id ${project.id}`);
		}
	}
	deps.log(
		"The Runner will not link the repository automatically. Choose a Project, link it in Takonaut, then rerun setup.",
	);
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
		throw new RunnerRepositoryNotLinkedError(normalized);
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

export async function promptRunnerSetupLine(
	question: string,
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
	const terminal = createInterface({ input, output });
	try {
		return await new Promise<string>((resolve, reject) => {
			let settled = false;
			const rejectClosed = (cause?: unknown): void => {
				if (settled) return;
				settled = true;
				reject(
					new Error(
						"Interactive input closed before a choice was made. Rerun setup and choose Trusted Native explicitly.",
						cause === undefined ? undefined : { cause },
					),
				);
			};
			const onClose = (): void => rejectClosed();
			terminal.once("close", onClose);
			void terminal.question(`${question} `).then(
				(answer) => {
					if (settled) return;
					settled = true;
					terminal.off("close", onClose);
					resolve(answer);
				},
				(error: unknown) => rejectClosed(error),
			);
		});
	} finally {
		terminal.close();
	}
}

export async function selectRunnerSetupTrustedNative({
	interactive,
	explicit,
	existing,
	warn,
	prompt,
}: RunnerSetupTrustedNativePrompt): Promise<boolean | undefined> {
	if (explicit !== undefined) return explicit;
	if (!interactive) return existing;

	warn(
		"Trusted Native can execute protected actions",
		"Enabling it creates a local Ed25519 signing key and advertises native GitHub capabilities. Protected actions still require a separate trust policy in Takonaut, and autonomous protected actions remain a separate approval. Enable it only on a machine and repository you trust.",
	);
	const defaultEnabled = existing === true;
	const question = `Enable Trusted Native execution for this repository? ${defaultEnabled ? "[Y/n]" : "[y/N]"}`;
	while (true) {
		const response = await prompt(question);
		const answer = response.trim().toLowerCase();
		if (!answer) return defaultEnabled;
		if (answer === "y" || answer === "yes") return true;
		if (answer === "n" || answer === "no") return false;
		warn(
			"Please answer yes or no",
			"Enter y to enable Trusted Native or n to keep standard read-only Runner mode.",
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
		!isAbsolute(selection.repositoryPath)
	) {
		throw new Error(
			"Runner setup requires a Project, repository, and absolute path",
		);
	}
	return {
		...config,
		repositoryBindings: {
			...(config.repositoryBindings ?? {}),
			[selection.repositoryId]: {
				projectId: selection.projectId,
				path: selection.repositoryPath,
				...(selection.trustedNative === undefined
					? {}
					: { trustedNative: selection.trustedNative }),
			},
		},
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
