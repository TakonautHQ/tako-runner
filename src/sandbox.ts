/**
 * Per-command OS sandbox for the Agent's shell.
 *
 * Every command the model runs gets: no network, writes only inside the Run's
 * worktree, its Git metadata and a private temp folder, and no access to
 * credentials (Runner, Pi, SSH, cloud, GitHub CLI, keychains, browsers). Pi
 * itself and the Runner process are outside the sandbox; only model-authored
 * commands are inside it.
 *
 * macOS uses sandbox-exec (Seatbelt). Linux uses bubblewrap. Without either,
 * the shell tool is not offered.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type SandboxKind = "macos" | "bwrap";

export function detectSandbox(platform = process.platform): SandboxKind | null {
	if (process.env.TAKONAUT_RUNNER_SANDBOX === "off") return null;
	const has = (command: string, args: string[]) => {
		try {
			execFileSync(command, args, { stdio: "ignore", timeout: 5_000 });
			return true;
		} catch {
			return false;
		}
	};
	if (platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) return "macos";
	if (platform === "linux" && has("bwrap", ["--version"])) return "bwrap";
	return null;
}

/** Home-relative paths no model-authored command may read. */
export const SECRET_PATHS = [
	".takonaut/runner.json",
	".takonaut/runner-credentials.json",
	".takonaut/runner-connectors.json",
	".takonaut/secrets.json",
	".takonaut/tools.json",
	".takonaut/models.json",
	".takonaut/chats",
	".takonaut/paused",
	".takonaut/runs",
	".takonaut/threads",
	".pi",
	".ssh",
	".aws",
	".azure",
	".config/gcloud",
	".config/gh",
	".config/git/credentials",
	".git-credentials",
	".netrc",
	".npmrc",
	".pypirc",
	".gnupg",
	".docker",
	".kube",
	".codex",
	".claude",
	"Library/Keychains",
	"Library/Application Support",
	"Library/Cookies",
	"Library/Mail",
	"Library/Messages",
	"Desktop",
	"Documents",
	"Downloads",
];

export interface SandboxPaths {
	worktree: string;
	/** Directories the command may write besides the worktree (Git metadata, other repositories). */
	writable: string[];
	/** The worktree is a repository the Agent may read but not change. */
	readOnlyWorktree?: boolean;
	tmp: string;
	home: string;
}

/** Where a command may write: the worktree unless it is read-only, temp, and the rest. */
export function writablePaths(paths: SandboxPaths): string[] {
	return [...(paths.readOnlyWorktree ? [] : [paths.worktree]), paths.tmp, ...paths.writable];
}

function sbString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Seatbelt profile. Later rules win, so the allows re-open what we need. */
export function macosProfile(paths: SandboxPaths): string {
	const secret = SECRET_PATHS.map((path) => join(paths.home, path));
	return [
		"(version 1)",
		"(allow default)",
		"(deny network*)",
		"(deny file-write*)",
		`(allow file-write* ${writablePaths(paths)
			.map((path) => `(subpath ${sbString(path)})`)
			.join(" ")} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/fd/") (regex #"^/dev/tty"))`,
		`(deny file-read* ${secret.map((path) => `(subpath ${sbString(path)})`).join(" ")})`,
		'(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent") (global-name "com.apple.pasteboard.1"))',
	].join("\n");
}

export function bwrapArgs(paths: SandboxPaths, command: string): string[] {
	const args = [
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--unshare-net",
		"--unshare-pid",
		"--die-with-parent",
		"--new-session",
	];
	for (const path of SECRET_PATHS.map((p) => join(paths.home, p))) {
		if (existsSync(path)) args.push("--tmpfs", path);
	}
	for (const path of writablePaths(paths)) {
		args.push("--bind", path, path);
	}
	args.push("--chdir", paths.worktree, "/bin/bash", "-c", command);
	return args;
}

export function sandboxEnvironment(paths: SandboxPaths): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
		HOME: paths.home,
		LANG: process.env.LANG ?? "en_US.UTF-8",
		TMPDIR: paths.tmp,
		CI: "1",
		NO_COLOR: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		PAGER: "cat",
		GIT_PAGER: "cat",
	};
}

export interface SandboxResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
	truncated: boolean;
}

const MAX_OUTPUT_BYTES = 50 * 1024;

export function runSandboxed(
	kind: SandboxKind,
	paths: SandboxPaths,
	command: string,
	options: { timeoutMs: number; signal?: AbortSignal },
): Promise<SandboxResult> {
	const [file, args] =
		kind === "macos"
			? ["/usr/bin/sandbox-exec", ["-p", macosProfile(paths), "/bin/bash", "-c", command]]
			: ["bwrap", bwrapArgs(paths, command)];
	return new Promise((resolve) => {
		const child = spawn(file, args, {
			cwd: paths.worktree,
			env: sandboxEnvironment(paths),
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let truncated = false;
		const collect = (chunk: Buffer) => {
			if (size >= MAX_OUTPUT_BYTES) {
				truncated = true;
				return;
			}
			const room = MAX_OUTPUT_BYTES - size;
			chunks.push(chunk.subarray(0, room));
			size += Math.min(room, chunk.length);
			if (chunk.length > room) truncated = true;
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		let timedOut = false;
		const kill = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, options.timeoutMs);
		const onAbort = () => kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (exitCode: number | null) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({
				exitCode,
				output: Buffer.concat(chunks).toString("utf8"),
				timedOut,
				truncated,
			});
		};
		child.on("error", (error) => {
			chunks.push(Buffer.from(String(error)));
			finish(null);
		});
		child.on("close", (code) => finish(code));
	});
}

/** A private temp folder for one Run's commands. */
export function createRunTemp(): { path: string; cleanup: () => void } {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "tako-run-")));
	return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function defaultSandboxHome(): string {
	return homedir();
}
