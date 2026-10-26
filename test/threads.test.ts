import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { availableModels, withModelLock } from "../src/models";
import { claimFollowUp, continuedPrompt, earlierSession, protectSessionFiles, pruneThreads, runSessionDir } from "../src/threads";

const ROOT_RUN = "11111111-1111-4111-8111-111111111111";
const TURN_2 = "22222222-2222-4222-8222-222222222222";
const TURN_3 = "33333333-3333-4333-8333-333333333333";
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "runner-threads-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.TAKONAUT_RUNNER_THREAD_HOURS;
});

describe("follow-up threads", () => {
	it("reads the thread from a claim and refuses unsafe ids", () => {
		expect(claimFollowUp({}, ROOT_RUN)).toBeNull();
		expect(claimFollowUp({ follow_up: { thread_id: ROOT_RUN, previous_run_id: TURN_2, message: "Which file?" } }, TURN_3)).toEqual({
			threadId: ROOT_RUN,
			previousRunId: TURN_2,
			message: "Which file?",
		});
		// Older follow-ups only name the Run before: that is the thread.
		expect(claimFollowUp({ follow_up: { previous_run_id: ROOT_RUN, message: "x" } }, TURN_2)?.threadId).toBe(ROOT_RUN);
		expect(claimFollowUp({ follow_up: { thread_id: "../../etc", message: "x" } }, TURN_2)?.threadId).toBe(TURN_2);
		expect(() => runSessionDir("../x", TURN_2, root)).toThrow(/Invalid/);
	});

	it("finds the earlier turn's session only while it is kept", () => {
		const dir = runSessionDir(ROOT_RUN, ROOT_RUN, root);
		const file = join(dir, "session.jsonl");
		writeFileSync(file, "{}\n");
		expect(earlierSession(ROOT_RUN, ROOT_RUN, Date.now(), root)).toBe(file);
		expect(earlierSession(ROOT_RUN, TURN_2, Date.now(), root)).toBeNull();
		expect(earlierSession(ROOT_RUN, ROOT_RUN, Date.now() + 25 * 3_600_000, root)).toBeNull();
		process.env.TAKONAUT_RUNNER_THREAD_HOURS = "0";
		expect(earlierSession(ROOT_RUN, ROOT_RUN, Date.now(), root)).toBeNull();
	});

	it("deletes threads nobody continued within a day", () => {
		runSessionDir(ROOT_RUN, ROOT_RUN, root);
		runSessionDir(TURN_2, TURN_2, root);
		const day = (Date.now() - 25 * 3_600_000) / 1000;
		utimesSync(join(root, TURN_2), day, day);
		expect(pruneThreads(Date.now(), root)).toBe(1);
		expect(existsSync(join(root, ROOT_RUN))).toBe(true);
		expect(existsSync(join(root, TURN_2))).toBe(false);
	});

	it("makes kept session files owner-only", () => {
		const dir = runSessionDir(ROOT_RUN, ROOT_RUN, root);
		const file = join(dir, "s.jsonl");
		writeFileSync(file, "{}\n", { mode: 0o644 });
		protectSessionFiles(dir);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	it("asks only the new question when continuing", () => {
		const prompt = continuedPrompt("Only on Android?");
		expect(prompt).toContain("Only on Android?");
		expect(prompt).toContain("You already investigated this revision");
		expect(prompt).not.toContain("YOUR EARLIER RESULT");
	});
});

describe("model logins", () => {
	it("lets one process at a time open the model list", async () => {
		const lock = join(root, "models.json.lock");
		const order: string[] = [];
		const slow = (name: string) =>
			withModelLock(async () => {
				order.push(`${name} start`);
				await new Promise((resolve) => setTimeout(resolve, 50));
				order.push(`${name} end`);
			}, lock);
		await Promise.all([slow("a"), slow("b")]);
		expect(order).toEqual(["a start", "a end", "b start", "b end"]);
	});

	it("keeps the working providers when one login is broken", async () => {
		const runtime = {
			getAvailable: async (provider?: string) => {
				if (!provider || provider === "openai-codex") throw new Error("OAuth refresh failed for openai-codex\n{...}");
				return [{ provider, id: "gpt-6.1-sol" }];
			},
			getProviders: () => [{ id: "openai-codex" }, { id: "litellm" }],
		};
		const errors: string[] = [];
		expect(await availableModels(runtime as never, errors)).toEqual([{ provider: "litellm", id: "gpt-6.1-sol" }]);
		expect(errors).toEqual(["openai-codex: OAuth refresh failed for openai-codex"]);
	});
});
