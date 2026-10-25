import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface SupervisedWorkerSpec {
	command: string;
	args: string[];
	/** Sent as JSON on stdin with `resultPath`; never placed in argv. */
	input: unknown;
	/** Aborting terminates the worker's entire process group. */
	signal: AbortSignal;
	/** SIGTERM-to-SIGKILL grace period. */
	graceMs?: number;
	/** Names the worker in errors; defaults to "analysis". */
	label?: string;
}

/**
 * The supervisor could not confirm that a worker process group is gone.
 * Local capacity must not be reused: callers stop rather than claim more work.
 */
export class RunnerSupervisionError extends Error {}

const GROUP_REAP_TIMEOUT_MS = 5_000;

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		// EPERM still means a process exists in the group.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// Already gone.
	}
}

async function reapGroup(pgid: number, label: string): Promise<void> {
	signalGroup(pgid, "SIGKILL");
	const deadline = Date.now() + GROUP_REAP_TIMEOUT_MS;
	while (groupAlive(pgid)) {
		if (Date.now() > deadline) {
			throw new RunnerSupervisionError(
				`Runner could not confirm ${label} worker termination; stopping`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Runner secrets never passed to a worker process. */
const WITHHELD_ENV = ["TAKONAUT_RUNNER_TOKEN"] as const;

/**
 * Worker side of the protocol: resolves the single request line, then treats
 * stdin EOF (the supervisor died) as a lifeline loss and kills the worker's
 * own process group. The worker must exit explicitly when done.
 */
export function readSupervisedRequest(
	stdin: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
	return new Promise((resolve, reject) => {
		// Decode across chunk boundaries; a split UTF-8 sequence stays intact.
		const decoder = new StringDecoder("utf8");
		let raw = "";
		let line: string | undefined;
		const lifelineLost = () => {
			if (line === undefined) {
				reject(new Error("Runner analysis worker received no request"));
			}
			try {
				process.kill(0, "SIGKILL");
			} catch {
				process.exit(70);
			}
		};
		stdin.on("data", (chunk) => {
			if (line !== undefined) return;
			raw += typeof chunk === "string" ? chunk : decoder.write(chunk);
			const newline = raw.indexOf("\n");
			if (newline >= 0) {
				line = raw.slice(0, newline);
				resolve(line);
			}
		});
		stdin.once("end", lifelineLost);
		stdin.once("close", lifelineLost);
	});
}

/**
 * Runs one worker in its own POSIX process group and settles only after the
 * whole group is confirmed gone, so lease loss or shutdown physically stops
 * descendants before local capacity is reused. Processes that deliberately
 * leave the group (setsid/daemonize) are outside this guarantee.
 */
export async function runSupervisedWorker<T>(
	spec: SupervisedWorkerSpec,
): Promise<T> {
	spec.signal.throwIfAborted();
	if (process.platform === "win32") {
		throw new Error(
			"Runner analysis supervision requires POSIX process groups",
		);
	}
	const label = spec.label ?? "analysis";
	const directory = mkdtempSync(join(tmpdir(), "takonaut-runner-worker-"));
	const resultPath = join(directory, "result.json");
	try {
		const env = { ...process.env };
		for (const name of WITHHELD_ENV) delete env[name];
		const child = spawn(spec.command, spec.args, {
			detached: true,
			env,
			stdio: ["pipe", "ignore", "inherit"],
		});
		const pgid = child.pid;
		const exited = new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
		if (pgid === undefined) {
			await exited;
			throw new Error(`Runner ${label} worker failed to start`);
		}
		child.stdin?.on("error", () => undefined);
		// One request line; stdin then stays open as the worker's lifeline.
		child.stdin?.write(
			`${JSON.stringify({ resultPath, input: spec.input })}\n`,
		);

		let escalation: ReturnType<typeof setTimeout> | undefined;
		const terminate = () => {
			signalGroup(pgid, "SIGTERM");
			escalation = setTimeout(
				() => signalGroup(pgid, "SIGKILL"),
				spec.graceMs ?? 5_000,
			);
		};
		spec.signal.addEventListener("abort", terminate, { once: true });
		let outcome: Awaited<typeof exited>;
		try {
			outcome = await exited;
		} finally {
			spec.signal.removeEventListener("abort", terminate);
			clearTimeout(escalation);
			child.stdin?.destroy();
			// Remaining group members are never left running.
			await reapGroup(pgid, label);
		}
		spec.signal.throwIfAborted();
		if (outcome.code !== 0) {
			throw new Error(
				outcome.signal
					? `Runner ${label} worker exited by ${outcome.signal}`
					: `Runner ${label} worker exited with code ${outcome.code}`,
			);
		}
		let raw: string;
		try {
			raw = readFileSync(resultPath, "utf8");
		} catch {
			throw new Error(`Runner ${label} worker produced no result`);
		}
		return JSON.parse(raw) as T;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
