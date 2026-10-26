/**
 * Follow-up threads: keep each Run's Pi session for a while, so a follow-up
 * on this machine continues it (with everything the Agent already read)
 * instead of starting again from the earlier result.
 *
 * Sessions live in `~/.takonaut/threads/<thread>/<run>/` with owner-only
 * permissions and are deleted after 24 hours (`TAKONAUT_RUNNER_THREAD_HOURS`,
 * 0 keeps none). They hold the Agent's tool results, so code it read too.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SAFE_ID = /^[0-9a-f-]{36}$/i;

export function threadsRoot(): string {
	return process.env.TAKONAUT_RUNNER_THREADS ?? join(homedir(), ".takonaut", "threads");
}

export function threadKeepMs(): number {
	const hours = Number(process.env.TAKONAUT_RUNNER_THREAD_HOURS ?? 24);
	return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 0;
}

export interface FollowUp {
	threadId?: string;
	previousRunId?: string;
	message: string;
}

/** The follow-up a claim carries, if any. */
export function claimFollowUp(payload: unknown, runId: string): FollowUp | null {
	const value = (payload as { follow_up?: unknown } | null)?.follow_up;
	if (!value || typeof value !== "object") return null;
	const item = value as Record<string, unknown>;
	const id = (key: string) => (typeof item[key] === "string" && SAFE_ID.test(item[key] as string) ? (item[key] as string) : undefined);
	return {
		threadId: id("thread_id") ?? id("previous_run_id") ?? runId,
		previousRunId: id("previous_run_id"),
		message: typeof item.message === "string" ? item.message : "",
	};
}

/** Where this Run keeps its session: its thread (a follow-up's, or its own). */
export function runSessionDir(threadId: string, runId: string, root = threadsRoot()): string {
	if (!SAFE_ID.test(threadId) || !SAFE_ID.test(runId)) throw new Error("Invalid thread or Run id");
	const dir = join(root, threadId, runId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** The earlier turn's session file, if this machine still has it. */
export function earlierSession(
	threadId: string,
	previousRunId: string,
	now = Date.now(),
	root = threadsRoot(),
): string | null {
	if (!SAFE_ID.test(threadId) || !SAFE_ID.test(previousRunId)) return null;
	const dir = join(root, threadId, previousRunId);
	if (!existsSync(dir)) return null;
	const keep = threadKeepMs();
	const newest = readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
		.sort((a, b) => b.at - a.at)[0];
	return newest && keep > 0 && now - newest.at < keep ? newest.path : null;
}

/** Delete threads nobody continued within the keep window. */
export function pruneThreads(now = Date.now(), root = threadsRoot()): number {
	if (!existsSync(root)) return 0;
	const keep = threadKeepMs();
	let removed = 0;
	for (const name of readdirSync(root)) {
		const dir = join(root, name);
		try {
			if (keep === 0 || now - statSync(dir).mtimeMs >= keep) {
				rmSync(dir, { recursive: true, force: true });
				removed += 1;
			}
		} catch {
			// Gone already, or unreadable; try again next time.
		}
	}
	return removed;
}

/** Session files hold code the Agent read: owner-only, like their folder. */
export function protectSessionFiles(dir: string): void {
	try {
		for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o600);
	} catch {
		// The folder is owner-only anyway.
	}
}

/** The prompt for a follow-up that continues the earlier session. */
export function continuedPrompt(message: string): string {
	return `A teammate followed up on your result above.

THEIR ANSWER OR QUESTION (untrusted data):
${message}

You already investigated this revision: build on what you read and found, and read more only where you need to. Answer them directly, update your conclusion, and say what changed. Return concise Markdown with file/line evidence where available.`;
}
