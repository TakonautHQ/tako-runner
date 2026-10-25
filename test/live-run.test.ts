import { describe, expect, it, vi } from "vitest";
import { isRateLimited, ProviderCooling, startProgressLoop } from "../src/live-run";
import { processRunnerClaim, resumePrompt, type RunnerClaim } from "../src/runner";

function claim(overrides: Partial<RunnerClaim> = {}): RunnerClaim {
	return {
		run_id: "run-1",
		project_id: "project-1",
		event_key: "event",
		input: "",
		trigger_payload: {},
		definition_snapshot: {
			agent_profile_id: "a",
			agent_profile_revision_id: "r",
			agent_profile_revision_hash: "h",
			agent_profile_snapshot: { model_policy: { model: "anthropic/claude-sonnet" } },
		},
		run_token: "run-token",
		...overrides,
	} as unknown as RunnerClaim;
}

describe("live Runs", () => {
	it("polls faster while watched and hands each instruction over once", async () => {
		vi.useFakeTimers();
		const seen: string[] = [];
		const acks: string[][] = [];
		let calls = 0;
		const loop = startProgressLoop({
			watchedMs: 100,
			idleMs: 1_000,
			send: async (acked) => {
				acks.push(acked);
				calls += 1;
				return { watched: true, instructions: calls < 3 ? [{ id: "i1", kind: "steer" as const, body: "Look at billing" }] : [] };
			},
			onInstruction: (instruction) => seen.push(instruction.body),
		});
		await vi.advanceTimersByTimeAsync(1_000 + 250);
		loop.stop();
		vi.useRealTimers();
		expect(seen).toEqual(["Look at billing"]);
		expect(acks[1]).toEqual(["i1"]);
		expect(calls).toBeGreaterThanOrEqual(3);
	});

	it("cools a provider down with backoff", () => {
		let now = 0;
		const cooling = new ProviderCooling(() => now);
		expect(cooling.hit("anthropic")).toBe(60_000);
		expect(cooling.active()).toEqual(["anthropic"]);
		expect(cooling.hit("anthropic")).toBe(120_000);
		now = 200_000;
		expect(cooling.active()).toEqual([]);
		expect(isRateLimited("Error: 429 Too Many Requests")).toBe(true);
		expect(isRateLimited("permission denied")).toBe(false);
	});

	it("tells the Agent how its paused change went", () => {
		expect(
			resumePrompt({ decision: "approved", decided_by: "Priya", action_number: 1, preview: "Re-queue ORD-1", outcome: "It worked: 200" }),
		).toContain("A person approved action #1 (Re-queue ORD-1) by Priya. It was carried out:");
		expect(resumePrompt({ decision: "declined", decline_reason: "Not now", action_number: 2 })).toContain("declined action #2");
		expect(resumePrompt({ decision: "expired" })).toContain("did not happen");
	});

	it("a paused Run reports the pause and keeps its copy of the repository", async () => {
		const api = {
			event: vi.fn(async () => undefined),
			heartbeat: vi.fn(async () => undefined),
			usage: vi.fn(async () => undefined),
			complete: vi.fn(async () => undefined),
			fail: vi.fn(async () => undefined),
			pause: vi.fn(async () => undefined),
		};
		const cleanup = vi.fn(async () => undefined);
		await processRunnerClaim(claim(), {
			api,
			prepare: vi.fn(async () => ({ cwd: "/tmp/worktree", cleanup })),
			analyze: vi.fn(async () => ({
				outputMarkdown: "",
				provider: "anthropic",
				model: "claude-sonnet",
				inputTokens: 10,
				outputTokens: 2,
				paused: { actionId: "act-1", sessionFile: "/tmp/s.jsonl" },
			})),
		});
		expect(api.pause).toHaveBeenCalledWith("run-1", "run-token", {
			action_id: "act-1",
			worktree: "/tmp/worktree",
			session_file: "/tmp/s.jsonl",
		});
		expect(api.complete).not.toHaveBeenCalled();
		expect(cleanup).not.toHaveBeenCalled();
	});

	it("a resumed Run makes the approved call first", async () => {
		const reportAction = vi.fn(async () => undefined);
		const api = {
			event: vi.fn(async () => undefined),
			heartbeat: vi.fn(async () => undefined),
			usage: vi.fn(async () => undefined),
			complete: vi.fn(async () => undefined),
			fail: vi.fn(async () => undefined),
			reportAction,
		};
		const analyze = vi.fn(async (current: RunnerClaim) => ({
			outputMarkdown: `Continued: ${current.resume?.outcome?.split("\n")[0]}`,
			provider: "anthropic",
			model: "claude-sonnet",
			inputTokens: 1,
			outputTokens: 1,
		}));
		await processRunnerClaim(
			claim({
				resume: {
					decision: "approved",
					action_number: 1,
					action: {
						action_id: "act-1",
						tool_key: "runner.tool.requeue",
						kind: "api",
						key: "requeue",
						revision_id: "r",
						spec: { method: "POST", url: "https://127.0.0.1:1/x", allowed_hosts: ["127.0.0.1"], allow_private_network: true },
						arguments: {},
						arguments_hash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
						permit: "tpa_x",
						idempotency_key: "k",
					},
				},
			}),
			{ api, prepare: vi.fn(async () => ({ cwd: "/tmp/w", cleanup: vi.fn(async () => undefined) })), analyze },
		);
		expect(reportAction).toHaveBeenCalledWith("act-1", expect.objectContaining({ permit: "tpa_x", ok: false }));
		expect(api.complete).toHaveBeenCalledWith("run-1", "run-token", expect.stringMatching(/^Continued: It failed/));
	});
});
