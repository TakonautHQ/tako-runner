/**
 * Script tools: a fixed command run as argv inside the Runner sandbox.
 *
 * - `{name}` placeholders are whole arguments only; the program itself is fixed.
 * - Writes are allowed only in a private temp folder; the repository is
 *   read-only; credentials folders stay unreadable (same profile as the
 *   Agent's shell).
 * - No network unless the spec lists hosts. The macOS and Linux sandboxes
 *   can't limit traffic to host names, so a script with hosts gets general
 *   outbound network and the hosts are shown to admins as what it should
 *   reach. Without a sandbox, script tools don't run at all.
 * - Environment: PATH, HOME, LANG, TMPDIR and the spec's own variables
 *   (secrets resolved); output is capped and redacted.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "../redact";
import {
	bwrapArgs,
	createRunTemp,
	detectSandbox,
	macosProfile,
	runnerPath,
	type SandboxKind,
} from "../sandbox";
import { type SecretStore, resolveSecrets } from "../secrets";
import type { ToolCallOutcome } from "./api-tool";

export interface ScriptToolSpec {
	command: string[];
	/** The script stored with the tool in Takonaut; `${script}` in the command is its path. */
	script?: { filename: string; content: string; sha256: string };
	/** Programs it runs besides its own, checked before it counts as ready. */
	requires_programs?: string[];
	cwd: "repository" | "home" | string;
	env?: Record<string, string>;
	network: false | { allowed_hosts: string[] };
	input_schema?: { required?: string[] };
	max_output_bytes?: number;
	timeout_ms?: number;
}

const WHOLE = /^\{([a-zA-Z_][a-zA-Z0-9_]{0,63})\}$/;
export const SCRIPT_TOKEN = "${script}";
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function defaultScriptsDir(): string {
	return process.env.TAKONAUT_RUNNER_TOOL_SCRIPTS ?? join(homedir(), ".takonaut", "tool-scripts");
}

/** Throws when the stored script is malformed or doesn't match its checksum. */
export function verifyScript(spec: ScriptToolSpec): void {
	const script = spec.script;
	if (!script) return;
	if (!FILENAME.test(script.filename) || !/^[0-9a-f]{64}$/.test(script.sha256)) {
		throw new Error("The tool's script file is invalid");
	}
	if (createHash("sha256").update(script.content).digest("hex") !== script.sha256) {
		throw new Error("The tool's script doesn't match its checksum; sync tools again");
	}
}

/**
 * The stored script's path on this machine, written once per checksum.
 * Throws when the content doesn't match the checksum Takonaut sent.
 */
export function scriptFile(spec: ScriptToolSpec, dir = defaultScriptsDir()): string | null {
	const script = spec.script;
	if (!script) return null;
	verifyScript(spec);
	const folder = join(dir, script.sha256);
	const path = join(folder, script.filename);
	if (!existsSync(path)) {
		mkdirSync(folder, { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, script.content, { mode: 0o500 });
		renameSync(temporary, path);
	}
	return path;
}

export function scriptArgv(spec: ScriptToolSpec, args: Record<string, unknown>, script?: string): string[] {
	return spec.command.map((part, index) => {
		if (part === SCRIPT_TOKEN && script) return script;
		const match = WHOLE.exec(part);
		if (!match || index === 0) return part;
		const value = args[match[1] as string];
		return typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);
	});
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ScriptToolOptions {
	secrets: SecretStore;
	/** The Run's repository copy, when there is one. */
	repository?: string;
	sandbox?: SandboxKind | null;
	signal?: AbortSignal;
	personalData?: boolean;
}

export async function executeScriptTool(
	spec: ScriptToolSpec,
	args: Record<string, unknown>,
	options: ScriptToolOptions,
): Promise<ToolCallOutcome> {
	const used = new Set<string>();
	const clean = (text: string) => redact(text, { secrets: used, personalData: options.personalData });
	const kind = options.sandbox === undefined ? detectSandbox() : options.sandbox;
	if (!kind) {
		return { ok: false, summary: "Script tools need the Runner sandbox, which this machine lacks", output: "" };
	}
	for (const name of spec.input_schema?.required ?? []) {
		if (args[name] === undefined || args[name] === "") {
			return { ok: false, summary: `${name} is required`, output: "" };
		}
	}
	const temp = createRunTemp();
	try {
		const cwd =
			spec.cwd === "repository"
				? (options.repository ?? temp.path)
				: spec.cwd === "home"
					? homedir()
					: spec.cwd;
		if (!existsSync(cwd)) return { ok: false, summary: `Working folder ${cwd} does not exist`, output: "" };
		const env: Record<string, string> = {
			PATH: runnerPath(),
			HOME: homedir(),
			LANG: process.env.LANG ?? "en_US.UTF-8",
			TMPDIR: temp.path,
			NO_COLOR: "1",
		};
		for (const [name, value] of Object.entries(spec.env ?? {})) {
			env[name] = resolveSecrets(value, options.secrets, used);
		}
		const argv = scriptArgv(spec, args, scriptFile(spec) ?? undefined);
		const command = `cd ${shellQuote(cwd)} && exec ${argv.map(shellQuote).join(" ")}`;
		const paths = { worktree: temp.path, writable: [], tmp: temp.path, home: homedir() };
		const network = spec.network !== false;
		const [file, sandboxArgs] =
			kind === "macos"
				? [
						"/usr/bin/sandbox-exec",
						[
							"-p",
							network
								? macosProfile(paths).replace("(deny network*)", "(allow network*)")
								: macosProfile(paths),
							"/bin/bash",
							"-c",
							command,
						],
					]
				: ["bwrap", bwrapArgs(paths, command).filter((arg) => !(network && arg === "--unshare-net"))];
		const maxBytes = spec.max_output_bytes ?? 50_000;
		const result = await new Promise<{ code: number | null; output: string; timedOut: boolean; truncated: boolean }>(
			(resolve) => {
				const child = spawn(file, sandboxArgs, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
				const chunks: Buffer[] = [];
				let size = 0;
				let truncated = false;
				const collect = (chunk: Buffer) => {
					const room = maxBytes - size;
					if (room <= 0) {
						truncated = true;
						return;
					}
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
				}, spec.timeout_ms ?? 60_000);
				options.signal?.addEventListener("abort", kill, { once: true });
				const finish = (code: number | null) => {
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", kill);
					resolve({ code, output: Buffer.concat(chunks).toString("utf8"), timedOut, truncated });
				};
				child.on("error", (error) => {
					chunks.push(Buffer.from(String(error)));
					finish(null);
				});
				child.on("close", finish);
			},
		);
		const output = clean(`${result.output}${result.truncated ? "\n[truncated]" : ""}`);
		if (result.timedOut) return { ok: false, summary: "Timed out", output };
		return {
			ok: result.code === 0,
			summary: result.code === 0 ? "Exit 0" : `Exit ${result.code ?? "error"}`,
			output,
		};
	} catch (error) {
		const message = clean(error instanceof Error ? error.message : String(error));
		return { ok: false, summary: message.slice(0, 300), output: message };
	} finally {
		temp.cleanup();
	}
}
