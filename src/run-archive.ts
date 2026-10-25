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
	/** The call was refused because the tool reached its limit. */
	limited?: boolean;
}

/** [max calls per Run, max calls per minute], keyed by `code.read`, `code.change` or `connector.<name>`. */
export type ToolLimits = Record<string, readonly number[]>;

const CODE_READ = new Set(["runner_read", "runner_list", "runner_find", "runner_grep", "runner_git_diff"]);
const CODE_CHANGE = new Set(["runner_shell", "runner_edit", "runner_write"]);
// Used when Takonaut sends no limits (older servers).
const FALLBACK_LIMITS: ToolLimits = {
	"code.read": [300, 120],
	"code.change": [100, 60],
	connector: [25, 10],
};

/** Which limit applies to a tool; Takonaut tools are limited by Takonaut. */
export function limitKey(toolName: string): string | null {
	if (CODE_READ.has(toolName)) return "code.read";
	if (CODE_CHANGE.has(toolName)) return "code.change";
	// Organization tools: t_<key> and t_<key>__<connector tool>.
	if (toolName.startsWith("t_")) return `tool.${toolName.slice(2).split("__")[0]?.replace(/_/g, "-")}`;
	const split = toolName.indexOf("__");
	return split > 0 ? `connector.${toolName.slice(0, split)}` : null;
}

export class ToolLimitError extends Error {}

export interface RunMetrics {
	toolCalls: number;
	commandsRun: number;
	changesMade: number;
	durationSeconds: number;
}

export class RunRecorder {
	readonly events: ToolEvent[] = [];
	private readonly started = Date.now();
	private readonly calls = new Map<string, number[]>();

	constructor(
		private readonly limits: ToolLimits = {},
		private readonly now: () => number = Date.now,
	) {}

	private limitFor(key: string): readonly number[] | undefined {
		return this.limits[key] ?? FALLBACK_LIMITS[key] ?? (key.startsWith("connector.") ? FALLBACK_LIMITS.connector : undefined);
	}

	/** Count one call against the tool's limits, or refuse it with a message the model can act on. */
	private admit(toolName: string): void {
		const key = limitKey(toolName);
		const limit = key ? this.limitFor(key) : undefined;
		if (!key || !limit) return;
		const [perRun, perMinute] = limit;
		const now = this.now();
		const history = this.calls.get(key) ?? [];
		const refuse = (message: string) => {
			this.events.push({ tool: toolName, ok: false, ms: 0, at: new Date(now).toISOString(), limited: true });
			throw new ToolLimitError(message);
		};
		if (perRun !== undefined && history.length >= perRun) {
			refuse(`Tool limit reached: ${toolName} may be called at most ${perRun} times in one Run. Continue with what you have.`);
		}
		const lastMinute = history.filter((at) => now - at < 60_000).length;
		if (perMinute !== undefined && lastMinute >= perMinute) {
			refuse(`Tool limit reached: ${toolName} may be called at most ${perMinute} times a minute. Wait, or continue with what you have.`);
		}
		history.push(now);
		this.calls.set(key, history);
	}

	/** Wrap a tool so every call is counted, timed and kept within its limits. */
	wrap<T extends { name: string; execute: (...args: never[]) => unknown }>(tool: T): T {
		const original = tool.execute as (...args: unknown[]) => Promise<unknown>;
		const recorder = this;
		const execute = async function (this: unknown, ...args: unknown[]) {
			recorder.admit(tool.name);
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
			toolCalls: this.events.filter((event) => !event.limited).length,
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
