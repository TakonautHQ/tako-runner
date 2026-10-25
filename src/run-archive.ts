/**
 * What the Agent did during one Run: counted for Takonaut (numbers only) and
 * archived on this machine for debugging (never uploaded).
 *
 * The archive lives in `~/.takonaut/runs/<run_id>/` with owner-only
 * permissions, holds the tool timeline (tool names, durations, outcomes) and
 * the result, and is deleted after the retention period (7 days by default,
 * `TAKONAUT_RUNNER_ARCHIVE_DAYS`, 0 disables archiving).
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ToolEvent {
	tool: string;
	ok: boolean;
	ms: number;
	at: string;
}

export interface RunMetrics {
	toolCalls: number;
	commandsRun: number;
	changesMade: number;
	durationSeconds: number;
}

export class RunRecorder {
	readonly events: ToolEvent[] = [];
	private readonly started = Date.now();

	/** Wrap a tool so every call is counted and timed. */
	wrap<T extends { name: string; execute: (...args: never[]) => unknown }>(tool: T): T {
		const original = tool.execute as (...args: unknown[]) => Promise<unknown>;
		const recorder = this;
		const execute = async function (this: unknown, ...args: unknown[]) {
			const began = Date.now();
			try {
				const result = await original.apply(this, args);
				recorder.events.push({ tool: tool.name, ok: true, ms: Date.now() - began, at: new Date(began).toISOString() });
				return result;
			} catch (error) {
				recorder.events.push({ tool: tool.name, ok: false, ms: Date.now() - began, at: new Date(began).toISOString() });
				throw error;
			}
		};
		return { ...tool, execute } as T;
	}

	metrics(patch: string): RunMetrics {
		return {
			toolCalls: this.events.length,
			commandsRun: this.events.filter((event) => event.tool === "runner_shell").length,
			changesMade: (patch.match(/^diff --git /gm) ?? []).length,
			durationSeconds: Math.round((Date.now() - this.started) / 1000),
		};
	}
}

export function archiveRoot(): string {
	return process.env.TAKONAUT_RUNNER_ARCHIVE ?? join(homedir(), ".takonaut", "runs");
}

export function archiveDays(): number {
	const raw = Number(process.env.TAKONAUT_RUNNER_ARCHIVE_DAYS ?? 7);
	return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 90) : 7;
}

const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

export function writeRunArchive(
	runId: string,
	record: { metrics: RunMetrics; events: ToolEvent[]; model: string | null; result: string },
	root = archiveRoot(),
): string | null {
	if (archiveDays() === 0 || !SAFE_ID.test(runId)) return null;
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const dir = join(root, runId);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(dir, "run.json"),
			JSON.stringify({ run_id: runId, model: record.model, metrics: record.metrics, timeline: record.events }, null, 2),
			{ mode: 0o600 },
		);
		writeFileSync(join(dir, "result.md"), record.result, { mode: 0o600 });
		return dir;
	} catch {
		return null;
	}
}

/** Delete archived Runs older than the retention period. */
export function pruneRunArchive(root = archiveRoot(), now = Date.now()): number {
	const maxAge = archiveDays() * 86_400_000;
	let removed = 0;
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!SAFE_ID.test(entry)) continue;
		const dir = join(root, entry);
		try {
			if (now - statSync(dir).mtimeMs > maxAge) {
				rmSync(dir, { recursive: true, force: true });
				removed += 1;
			}
		} catch {
			// Gone already.
		}
	}
	return removed;
}
