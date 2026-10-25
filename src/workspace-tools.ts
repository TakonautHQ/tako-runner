/**
 * Workspace tools for Assist and Act Agents: a sandboxed shell, file writes
 * and exact edits, all confined to the Run's disposable worktree. The Runner
 * turns any resulting changes into a patch attached to the result; nothing is
 * committed or pushed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSensitiveSegment } from "./runner-paths";
import { runSandboxed, type SandboxKind, type SandboxPaths } from "./sandbox";

export type AgentAutonomy = "observe" | "assist" | "act";

const MAX_WRITE_BYTES = 256 * 1024;
const DEFAULT_COMMAND_SECONDS = 120;
const MAX_COMMAND_SECONDS = 600;
const MAX_PATCH_BYTES = 40 * 1024;

export function claimAutonomy(snapshot: unknown): AgentAutonomy {
	const profile = (snapshot ?? {}) as {
		model_policy?: { autonomy?: unknown };
	};
	const level = profile.model_policy?.autonomy;
	return level === "assist" || level === "act" ? level : "observe";
}

/** A worktree-relative path that is not sensitive and does not escape. */
export function safeWorkspacePath(root: string, input: string): string {
	if (!input || input.includes("\0")) throw new Error("A file path is required");
	const target = resolve(root, input);
	const rel = relative(root, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("Paths must stay inside the repository");
	}
	const segments = rel.split(/[\\/]/);
	if (segments.some((segment) => segment === ".git" || isSensitiveSegment(segment))) {
		throw new Error("That path is protected");
	}
	return target;
}

export function gitWritableDirs(worktree: string): string[] {
	try {
		const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
			cwd: worktree,
			encoding: "utf8",
		}).trim();
		return gitDir ? [gitDir] : [];
	} catch {
		return [];
	}
}

const text = (value: string) => ({
	content: [{ type: "text" as const, text: value }],
	details: {},
});

export function makeWorkspaceTools(options: {
	worktree: string;
	sandbox: SandboxKind;
	paths: SandboxPaths;
	signal?: AbortSignal;
}) {
	const { worktree } = options;
	const shell = defineTool({
		name: "runner_shell",
		label: "Run a command",
		description:
			"Run a bash command in the repository worktree inside a sandbox: no network, writes only inside the repository, no access to credentials. Use it to run tests, builds, linters, git log/blame/show, and scripts. Install nothing; dependencies that need the network are unavailable.",
		parameters: Type.Object({
			command: Type.String(),
			timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_COMMAND_SECONDS })),
		}),
		execute: async (_id, params) => {
			const seconds = Math.min(params.timeout_seconds ?? DEFAULT_COMMAND_SECONDS, MAX_COMMAND_SECONDS);
			const result = await runSandboxed(options.sandbox, options.paths, params.command, {
				timeoutMs: seconds * 1000,
				signal: options.signal,
			});
			const status = result.timedOut
				? `Stopped after ${seconds} s`
				: `Exit code ${result.exitCode ?? "unknown"}`;
			return text(`${status}${result.truncated ? " (output truncated)" : ""}\n${result.output}`);
		},
	});
	const write = defineTool({
		name: "runner_write",
		label: "Write a file",
		description:
			"Create or replace a text file in the repository worktree. Changes become a proposed patch; nothing is committed or pushed.",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		execute: async (_id, params) => {
			const target = safeWorkspacePath(worktree, params.path);
			if (Buffer.byteLength(params.content) > MAX_WRITE_BYTES) {
				throw new Error("Files are limited to 256 KiB");
			}
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, params.content);
			return text(`Wrote ${relative(worktree, target)}`);
		},
	});
	const edit = defineTool({
		name: "runner_edit",
		label: "Edit a file",
		description:
			"Replace one exact, unique occurrence of old_text with new_text in a repository file.",
		parameters: Type.Object({
			path: Type.String(),
			old_text: Type.String(),
			new_text: Type.String(),
		}),
		execute: async (_id, params) => {
			const target = safeWorkspacePath(worktree, params.path);
			if (statSync(target).size > MAX_WRITE_BYTES) throw new Error("File is too large to edit");
			const current = readFileSync(target, "utf8");
			const first = current.indexOf(params.old_text);
			if (!params.old_text || first < 0) throw new Error("old_text was not found");
			if (current.indexOf(params.old_text, first + 1) >= 0) {
				throw new Error("old_text matches more than once; include more context");
			}
			writeFileSync(
				target,
				current.slice(0, first) + params.new_text + current.slice(first + params.old_text.length),
			);
			return text(`Edited ${relative(worktree, target)}`);
		},
	});
	return [shell, write, edit];
}

/** The worktree's changes as a unified diff (untracked files included). */
export function workspacePatch(worktree: string): string {
	try {
		execFileSync("git", ["add", "--intent-to-add", "--all"], { cwd: worktree, stdio: "ignore" });
		const diff = execFileSync("git", ["diff", "--no-ext-diff", "--no-color"], {
			cwd: worktree,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		});
		if (!diff.trim()) return "";
		return Buffer.byteLength(diff) > MAX_PATCH_BYTES
			? `${Buffer.from(diff).subarray(0, MAX_PATCH_BYTES).toString("utf8")}\n… patch truncated`
			: diff;
	} catch {
		return "";
	}
}

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** The Agent's model choice: "provider/model-id" and a thinking level. */
export function modelPreference(snapshot: unknown): {
	provider?: string;
	modelId?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
} {
	const policy = ((snapshot ?? {}) as { model_policy?: Record<string, unknown> }).model_policy ?? {};
	const out: ReturnType<typeof modelPreference> = {};
	const model = policy.model;
	if (typeof model === "string" && /^[a-z0-9][\w-]*\/[a-z0-9][\w.:@-]*$/i.test(model)) {
		const index = model.indexOf("/");
		out.provider = model.slice(0, index);
		out.modelId = model.slice(index + 1);
	}
	if (typeof policy.thinking === "string" && THINKING.has(policy.thinking)) {
		out.thinking = policy.thinking as NonNullable<typeof out.thinking>;
	}
	return out;
}
