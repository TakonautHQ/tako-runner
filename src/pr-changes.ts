/**
 * "Open a PR with its changes": the Runner attaches the files the Agent edited.
 *
 * The model only names the pull request (title, description, branch). The
 * changed files come from this Run's copy of the repository, compared with
 * the exact commit the Run started from, so what a person approves is
 * exactly what the Agent changed. Takonaut commits them and opens the draft
 * pull request after approval; this machine never talks to GitHub.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PR_TOOL = "open_pull_request_with_changes";
export const MAX_PR_FILES = 100;
export const MAX_PR_BYTES = 5 * 1024 * 1024;
const MAX_DIFF_BYTES = 400_000;

export interface ChangedFile {
	path: string;
	/** null deletes the file. */
	content_b64: string | null;
	mode: "100644" | "100755";
}

export interface PrChanges {
	files: ChangedFile[];
	diff: string;
}

export const PR_TOOL_DESCRIPTION =
	"Propose draft pull requests with the changes you made in this Run's copies of the repositories. " +
	"Your changed files in every repository you changed are attached automatically; you only give the title and description. " +
	"Each changed repository gets its own draft pull request, linked to the others. " +
	"A person reviews the exact changes and approves them together before anything reaches GitHub. " +
	"Call it once, when your fix is complete and you have run the tests.";

export const PR_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		title: { type: "string", description: "Pull request title, e.g. Fix stuck purchase jobs" },
		body: {
			type: "string",
			description: "What changed and why, how you tested it, and anything a reviewer should check",
		},
		branch_name: { type: "string", description: "Optional branch name; one is chosen if omitted" },
	},
	required: ["title"],
	additionalProperties: false,
} as const;

/**
 * The Agent's sandbox can write this worktree's git directory, and these
 * commands run outside the sandbox. Command-line settings override anything
 * planted there that would run a program (fsmonitor, hooks, diff drivers).
 */
export const SAFE_GIT = [
	"-c", "core.fsmonitor=false",
	"-c", "core.hooksPath=/dev/null",
	"-c", "diff.external=",
	"-c", "core.pager=cat",
	"-c", "core.untrackedCache=false",
];

function git(cwd: string, args: string[]): string {
	return execFileSync("git", [...SAFE_GIT, ...args], {
		cwd,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
	});
}

/** Files changed since ``baseSha`` (edits, new files, deletions), ready to commit. */
export function collectPrChanges(worktree: string, baseSha: string): PrChanges {
	git(worktree, ["add", "--intent-to-add", "--all"]);
	const listing = git(worktree, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "--no-renames", "-z", baseSha]);
	const parts = listing.split("\0").filter(Boolean);
	const files: ChangedFile[] = [];
	let total = 0;
	for (let index = 0; index + 1 < parts.length; index += 2) {
		const status = parts[index] as string;
		const path = parts[index + 1] as string;
		if (path === ".git" || path.startsWith(".git/")) continue;
		if (status.startsWith("D")) {
			files.push({ path, content_b64: null, mode: "100644" });
			continue;
		}
		const absolute = join(worktree, path);
		const stat = lstatSync(absolute);
		if (stat.isSymbolicLink()) throw new Error(`${path} is a symbolic link; pull requests from Agents can't change links`);
		if (!stat.isFile()) continue;
		const bytes = readFileSync(absolute);
		total += bytes.length;
		files.push({
			path,
			content_b64: bytes.toString("base64"),
			mode: stat.mode & 0o111 ? "100755" : "100644",
		});
	}
	if (files.length > MAX_PR_FILES) throw new Error(`You changed ${files.length} files; a pull request from an Agent can change at most ${MAX_PR_FILES}`);
	if (total > MAX_PR_BYTES) throw new Error("Your changed files are larger than 5 MB in total");
	const diff = git(worktree, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", baseSha]);
	return {
		files: files.sort((a, b) => a.path.localeCompare(b.path)),
		diff: Buffer.byteLength(diff) > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n… diff truncated` : diff,
	};
}

/** The arguments sent to Takonaut: what the model gave plus the changes. */
export function prArguments(params: Record<string, unknown>, changes: PrChanges, baseSha: string): Record<string, unknown> {
	return {
		title: typeof params.title === "string" ? params.title : "",
		...(typeof params.body === "string" ? { body: params.body } : {}),
		...(typeof params.branch_name === "string" && params.branch_name ? { branch_name: params.branch_name } : {}),
		base_sha: baseSha,
		files: changes.files,
		diff: changes.diff,
	};
}
