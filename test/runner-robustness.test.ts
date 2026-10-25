import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MAX_RUN_MINUTES,
	runTimeLimitMs,
	summarizeErrorBody,
	withTimeLimit,
	type RunnerClaim,
} from "../src/runner";

const claim = (operation: Record<string, unknown>) =>
	({ operation_snapshot: operation }) as unknown as RunnerClaim;

describe("readable Takonaut errors", () => {
	it("uses the JSON detail", () => {
		expect(summarizeErrorBody(409, '{"detail":"Binding is invalid"}')).toBe("Binding is invalid");
	});
	it("turns a Cloudflare 502 page into one line", () => {
		const page = "<!DOCTYPE html><html><head><title>takonaut.app | 502: Bad gateway</title></head><body>…</body></html>";
		expect(summarizeErrorBody(502, page)).toBe(
			"Takonaut is temporarily unavailable (takonaut.app | 502: Bad gateway); retrying",
		);
	});
	it("collapses plain text", () => {
		expect(summarizeErrorBody(400, "bad\n  request")).toBe("bad request");
	});
});

describe("Run time limit", () => {
	it("defaults and accepts a bounded per-Run override", () => {
		expect(runTimeLimitMs(claim({}))).toBe(DEFAULT_MAX_RUN_MINUTES * 60_000);
		expect(runTimeLimitMs(claim({ max_minutes: 45 }))).toBe(45 * 60_000);
		expect(runTimeLimitMs(claim({ max_minutes: 9999 }))).toBe(DEFAULT_MAX_RUN_MINUTES * 60_000);
	});

	it("aborts with a readable reason when the limit passes", () => {
		vi.useFakeTimers();
		try {
			const limited = withTimeLimit(new AbortController().signal, 20 * 60_000);
			vi.advanceTimersByTime(20 * 60_000);
			expect(limited.signal.aborted).toBe(true);
			expect(String(limited.signal.reason)).toContain("did not finish within 20 minutes");
		} finally {
			vi.useRealTimers();
		}
	});

	it("passes through an outer abort and clears its timer", () => {
		const outer = new AbortController();
		const limited = withTimeLimit(outer.signal, 60_000);
		outer.abort(new Error("shutdown"));
		expect(String(limited.signal.reason)).toContain("shutdown");
		limited.clear();
	});
});
