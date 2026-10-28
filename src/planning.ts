/**
 * Planning Runs: act within one Grill turn (ADR-0010 B6).
 *
 * - The prompt carries the ADRs in force, frozen at the turn's enqueue time,
 *   plus the member's instruction. The Planner's own session is kept warm
 *   per (Grill session, acting member) pair (longer than a chat session,
 *   since planning turns are spaced further apart) in
 *   ~/.takonaut/planning/<grill_session_id>/<acting_user_id>, so a later
 *   turn by the same member in the same session continues the earlier one
 *   instead of starting cold — and never continues with another member's
 *   earlier turns in context (M5: a shared Grill session has many members,
 *   each asking the Planner things the others may not be allowed to see).
 * - A planning Run never writes to the repository; the worktree is read-only
 *   and the Run uses only the Planner's exactly granted tools.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { fenceNonce, fenceUntrustedData } from "./prompt-fence";

export const PLANNING_WARM_MS = 30 * 60_000;
const SAFE_ID = /^[0-9a-f-]{36}$/i;

export interface AdrSnapshotItem {
	adr_id: string;
	number: number;
	title: string;
	org_wide: boolean;
	revision_id: string;
	content: string;
	truncated: boolean;
}

export interface AdrSnapshot {
	digest: string;
	adrs: AdrSnapshotItem[];
}

export function planningSessionsRoot(): string {
	return process.env.TAKONAUT_RUNNER_PLANNING_SESSIONS ?? join(homedir(), ".takonaut", "planning");
}

/** The configured warm window, or the default when unset or invalid. */
export function planningWarmMs(): number {
	const raw = process.env.TAKONAUT_RUNNER_PLANNING_WARM_MS;
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : PLANNING_WARM_MS;
}

/** The (Grill session, acting member) pair's session folder, and the newest session file if still warm. */
export function warmPlanningSession(
	grillSessionId: string,
	actingUserId: string,
	now = Date.now(),
	root = planningSessionsRoot(),
): { dir: string; warmFile: string | null } {
	if (!SAFE_ID.test(grillSessionId)) throw new Error("Invalid Grill session id");
	if (!SAFE_ID.test(actingUserId)) throw new Error("Invalid acting member id");
	const dir = join(root, grillSessionId, actingUserId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
		.sort((a, b) => b.at - a.at);
	const newest = files[0];
	const warmMs = planningWarmMs();
	return { dir, warmFile: newest && now - newest.at < warmMs ? newest.path : null };
}

/** Remove (Grill session, acting member) folders not touched for longer than the warm window. */
export function prunePlanningSessions(now = Date.now(), root = planningSessionsRoot()): number {
	if (!existsSync(root)) return 0;
	let removed = 0;
	const warmMs = planningWarmMs();
	for (const sessionName of readdirSync(root)) {
		const sessionDir = join(root, sessionName);
		let memberNames: string[];
		try {
			memberNames = readdirSync(sessionDir);
		} catch {
			continue; // Not a directory, or raced with another prune.
		}
		for (const memberName of memberNames) {
			const memberDir = join(sessionDir, memberName);
			try {
				if (now - statSync(memberDir).mtimeMs > warmMs) {
					rmSync(memberDir, { recursive: true, force: true });
					removed += 1;
				}
			} catch {
				// Raced with another prune.
			}
		}
		try {
			if (readdirSync(sessionDir).length === 0) rmSync(sessionDir, { recursive: true, force: true });
		} catch {
			// Raced with another prune, or not actually empty; a later prune retries.
		}
	}
	return removed;
}

/** The ADRs in force, frozen at this turn's enqueue time (B14, DJ-083). */
export function adrSnapshotSection(nonce: string, snapshot: AdrSnapshot | null | undefined): string {
	if (!snapshot || !Array.isArray(snapshot.adrs) || snapshot.adrs.length === 0) return "";
	const items = snapshot.adrs.map((adr) => {
		const number = String(adr.number).padStart(4, "0");
		// The title is untrusted too (set by any adrs.manage holder): kept
		// inside the fence below, never as prompt structure outside it.
		return `### ADR-${number}: ${adr.title}${adr.org_wide ? " (organization-wide)" : ""}\n${adr.content}${
			adr.truncated ? "\n(truncated)" : ""
		}`;
	});
	return `

ARCHITECTURE DECISION RECORDS IN FORCE (digest ${snapshot.digest}):
${fenceUntrustedData("ADR DATA", nonce, items.join("\n\n"))}`;
}

export function planningPrompt(
	instruction: string,
	adrSnapshot: AdrSnapshot | null | undefined,
	warm: boolean,
): string {
	const nonce = fenceNonce();
	const continuity = warm
		? "This continues your warm session for this Grill session; you already have the earlier turns."
		: "This is the first turn of a new session for this Grill session, or your earlier session has expired; you have no memory of earlier turns.";
	return `You are the Planner, helping a team plan work in a Tako Grill session. This is a read-only analysis: use only your granted tools, and never write, commit, push, or open a pull request.${adrSnapshotSection(
		nonce,
		adrSnapshot,
	)}

${continuity}

THE TEAM ASKS:
${fenceUntrustedData("TEAM INSTRUCTION", nonce, instruction)}

Respond in Markdown with your draft thinking and conclusion. Cite files (path:line) or ADRs you used.`;
}
