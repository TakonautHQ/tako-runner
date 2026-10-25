/**
 * A Run in progress talks back to Takonaut.
 *
 * - Progress (the text so far and its steps) every 3 s while someone watches,
 *   every 15 s otherwise. The answer carries messages: *steer* (the Agent reads
 *   it before its next step) and *stop*.
 * - A "remember" tool lets the Agent propose a note for a person to approve.
 * - Rate limits put the model provider in a cool-down before more claims.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface Instruction {
	id: string;
	kind: "steer" | "stop";
	body: string;
}

export interface ProgressApi {
	progress?(
		runId: string,
		runToken: string,
		body: { text: string; steps: unknown[]; acked: string[] },
	): Promise<{ watched?: boolean; instructions?: Instruction[] } | null>;
	proposeNote?(runId: string, runToken: string, text: string): Promise<string>;
}

export const WATCHED_MS = 3_000;
export const IDLE_MS = 15_000;

/** Poll progress until stopped; hands each new instruction to `onInstruction` once. */
export function startProgressLoop(options: {
	send: (acked: string[]) => Promise<{ watched?: boolean; instructions?: Instruction[] } | null>;
	onInstruction: (instruction: Instruction) => void;
	watchedMs?: number;
	idleMs?: number;
}): { stop(): void } {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const seen = new Set<string>();
	let acked: string[] = [];
	const tick = async () => {
		if (stopped) return;
		let watched = false;
		try {
			const answer = await options.send(acked);
			acked = [];
			watched = Boolean(answer?.watched);
			for (const instruction of answer?.instructions ?? []) {
				acked.push(instruction.id);
				if (seen.has(instruction.id)) continue;
				seen.add(instruction.id);
				options.onInstruction(instruction);
			}
		} catch {
			// Progress is best effort; the lease heartbeat is what matters.
		}
		if (!stopped) timer = setTimeout(tick, watched ? (options.watchedMs ?? WATCHED_MS) : (options.idleMs ?? IDLE_MS));
	};
	timer = setTimeout(tick, Math.min(options.watchedMs ?? WATCHED_MS, 1_000));
	return {
		stop() {
			stopped = true;
			clearTimeout(timer);
		},
	};
}

export function rememberTool(propose: (text: string) => Promise<string>) {
	return defineTool({
		name: "remember",
		label: "Remember for next time",
		description:
			"Propose a short note your team can approve, so every future Run of this Agent knows it (e.g. where a service logs, a known false alarm). Only for durable facts, not this Run's result.",
		parameters: Type.Object({ note: Type.String({ minLength: 1, maxLength: 1000 }) }),
		execute: async (_id, params) => ({
			content: [{ type: "text" as const, text: await propose(String((params as { note: string }).note)) }],
			details: {},
		}),
	});
}

/** Model providers in cool-down after rate limits, with exponential backoff. */
export class ProviderCooling {
	private readonly until = new Map<string, number>();
	private readonly strikes = new Map<string, number>();

	constructor(private readonly now: () => number = Date.now) {}

	hit(provider: string): number {
		const strikes = Math.min((this.strikes.get(provider) ?? 0) + 1, 5);
		this.strikes.set(provider, strikes);
		const ms = Math.min(15, 2 ** (strikes - 1)) * 60_000;
		this.until.set(provider, this.now() + ms);
		return ms;
	}

	clear(provider: string): void {
		this.strikes.delete(provider);
		this.until.delete(provider);
	}

	active(): string[] {
		const now = this.now();
		return [...this.until.entries()].filter(([, until]) => until > now).map(([provider]) => provider).sort();
	}
}

export function isRateLimited(message: string): boolean {
	return /\b429\b|rate.?limit|too many requests|overloaded/i.test(message);
}
