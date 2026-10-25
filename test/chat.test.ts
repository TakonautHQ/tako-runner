import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { chatPrompt, pruneChats, throttle, WARM_MS, warmSession } from "../src/chat";
import { claimChat, type RunnerClaim } from "../src/runner";

const id = "0b6f8c2e-1d7a-4c55-9a1f-1f2e3d4c5b6a";

describe("chat", () => {
	it("keeps a session warm for 15 minutes", () => {
		const root = mkdtempSync(join(tmpdir(), "tako-chats-"));
		expect(warmSession(id, Date.now(), root).warmFile).toBeNull();
		const file = join(root, id, "s.jsonl");
		writeFileSync(file, "{}\n");
		expect(warmSession(id, Date.now(), root).warmFile).toBe(file);
		expect(warmSession(id, Date.now() + WARM_MS + 1, root).warmFile).toBeNull();
		expect(() => warmSession("../etc", Date.now(), root)).toThrow();
		const old = join(root, "0b6f8c2e-1d7a-4c55-9a1f-000000000000");
		mkdirSync(old);
		const past = (Date.now() - WARM_MS - 60_000) / 1000;
		utimesSync(old, past, past);
		expect(pruneChats(Date.now(), root)).toBe(1);
	});

	it("sends earlier turns only when the session is cold", () => {
		const history = [
			{ role: "user" as const, text: "Is #9 the same bug?" },
			{ role: "agent" as const, text: "Probably." },
		];
		expect(chatPrompt("Why?", "Priya", history, false, "")).toContain("Person: Is #9 the same bug?");
		expect(chatPrompt("Why?", "Priya", history, true, "")).not.toContain("Is #9");
		expect(chatPrompt("Why?", "Priya", [], false, "")).toContain("Priya ASKS");
	});

	it("reads the chat turn from the claim", () => {
		const turn = claimChat({
			trigger_payload: {
				request: { message: "Which service?", from: "Priya" },
				chat: { history: [{ role: "user", text: "hi" }, { role: "bad", text: "x" }] },
				ticket: { number: 12, title: "Blueprint purchase failed" },
			},
		} as unknown as RunnerClaim);
		expect(turn?.question).toBe("Which service?");
		expect(turn?.history).toEqual([{ role: "user", text: "hi" }]);
		expect(turn?.subject).toContain("ticket #12");
	});

	it("streams the newest text at most every interval", async () => {
		vi.useFakeTimers();
		const sent: string[] = [];
		const stream = throttle(async (text) => sent.push(text), 500);
		stream.update("He");
		stream.update("Hello");
		await vi.advanceTimersByTimeAsync(600);
		stream.update("Hello there");
		await stream.done();
		vi.useRealTimers();
		expect(sent).toEqual(["Hello", "Hello there"]);
	});
});
