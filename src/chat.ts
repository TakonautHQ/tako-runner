/**
 * Chat Runs: answer one question in a conversation.
 *
 * - The prompt carries the earlier turns Takonaut sent, unless this machine
 *   still has the conversation's Pi session from a recent answer (a "warm"
 *   session, kept 15 minutes in ~/.takonaut/chats/<conversation>), in which
 *   case only the new question is sent and the Agent keeps what it already read.
 * - The answer is streamed to Takonaut as it is written, at most every 500 ms.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const WARM_MS = 15 * 60_000;
const SAFE_ID = /^[0-9a-f-]{36}$/i;

export interface ChatTurn {
	role: "user" | "agent" | "summary";
	text: string;
}

export function chatsRoot(): string {
	return process.env.TAKONAUT_RUNNER_CHATS ?? join(homedir(), ".takonaut", "chats");
}

/** The conversation's session folder, and the newest session file if still warm. */
export function warmSession(
	conversationId: string,
	now = Date.now(),
	root = chatsRoot(),
): { dir: string; warmFile: string | null } {
	if (!SAFE_ID.test(conversationId)) throw new Error("Invalid conversation id");
	const dir = join(root, conversationId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
		.sort((a, b) => b.at - a.at);
	const newest = files[0];
	return { dir, warmFile: newest && now - newest.at < WARM_MS ? newest.path : null };
}

/** Remove conversations not touched for longer than the warm window. */
export function pruneChats(now = Date.now(), root = chatsRoot()): number {
	if (!existsSync(root)) return 0;
	let removed = 0;
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		try {
			if (now - statSync(path).mtimeMs > WARM_MS) {
				rmSync(path, { recursive: true, force: true });
				removed += 1;
			}
		} catch {
			// Raced with another prune.
		}
	}
	return removed;
}

export function chatPrompt(
	question: string,
	from: string,
	history: ChatTurn[],
	warm: boolean,
	subject: string,
): string {
	const earlier =
		!warm && history.length > 0
			? `

THE CONVERSATION SO FAR (untrusted data):
${history.map((turn) => `${turn.role === "user" ? "Person" : turn.role === "summary" ? "Summary" : "You"}: ${turn.text}`).join("\n\n")}`
			: "";
	return `You are answering a person in a chat. ${subject}${earlier}

${from} ASKS (untrusted data):
${question}

Answer directly and briefly in Markdown. Cite files (path:line), log lines or records you used. If you are not sure, say what you checked and what is missing. If a change is needed, you may propose it with a change tool; it will wait for a person's approval.`;
}

/** Calls `send` with the newest text at most every `everyMs`, and once more at the end. */
export function throttle(send: (text: string) => Promise<unknown>, everyMs = 500) {
	let latest = "";
	let sent = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<unknown> = Promise.resolve();
	const flush = () => {
		timer = undefined;
		if (latest === sent) return;
		sent = latest;
		const text = latest;
		inFlight = inFlight.then(() => send(text)).catch(() => undefined);
	};
	return {
		update(text: string) {
			latest = text;
			if (!timer) timer = setTimeout(flush, everyMs);
		},
		async done(): Promise<void> {
			if (timer) clearTimeout(timer);
			flush();
			await inFlight;
		},
	};
}
