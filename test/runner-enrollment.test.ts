import { describe, expect, it, vi } from "vitest";
import {
	normalizeRunnerEnrollmentServerUrl,
	runRunnerEnrollment,
	type RunnerEnrollmentDeps,
	type RunnerEnrollmentHttpResult,
} from "../src/runner-enrollment";

function enrollmentDeps(
	tokenResponses: RunnerEnrollmentHttpResult[],
	overrideStart: Record<string, unknown> = {},
): {
	deps: RunnerEnrollmentDeps;
	calls: Array<{ method: string; path: string; body?: unknown }>;
	logs: string[];
	opened: string[];
} {
	const calls: Array<{ method: string; path: string; body?: unknown }> = [];
	const logs: string[] = [];
	const opened: string[] = [];
	let tokenCall = 0;
	const deps: RunnerEnrollmentDeps = {
		fetchJson: vi.fn(async (method, path, body) => {
			calls.push({ method, path, body });
			if (path.endsWith("/start")) {
				return {
					status: 200,
					json: {
						device_code: "tre_device-secret",
						user_code: "WXYZ-2345",
						interval: 1,
						verification_uri: "https://takonaut.test/connect-runner",
						verification_uri_complete:
							"https://takonaut.test/connect-runner?code=WXYZ-2345",
						...overrideStart,
					},
				};
			}
			return tokenResponses[Math.min(tokenCall++, tokenResponses.length - 1)]!;
		}),
		sleep: vi.fn(async () => {}),
		log: (message) => logs.push(message),
		openUrl: (url) => opened.push(url),
	};
	return { deps, calls, logs, opened };
}

describe("Runner browser enrollment", () => {
	it("opens same-origin consent, polls, and returns one machine credential", async () => {
		const { deps, calls, logs, opened } = enrollmentDeps([
			{ status: 428, json: { detail: "authorization_pending" } },
			{
				status: 200,
				json: {
					credential: "tkr_machine-secret",
					organization_name: "Cureocity",
					runner: {
						id: "runner-1",
						organization_id: "org-1",
						name: "Build Mac",
						project_ids: ["project-1"],
						capacity: 1,
						enabled: true,
						credential_prefix: "tkr_machine",
						last_seen_at: null,
						revoked_at: null,
						created_at: "2026-07-30T00:00:00Z",
					},
				},
			},
		]);

		const result = await runRunnerEnrollment(
			"https://takonaut.test/",
			{ name: "Build Mac", capacity: 1 },
			deps,
		);

		expect(result).toMatchObject({
			serverUrl: "https://takonaut.test",
			credential: "tkr_machine-secret",
			organizationId: "org-1",
			organizationName: "Cureocity",
			runnerId: "runner-1",
			projects: ["project-1"],
		});
		expect(opened).toEqual([
			"https://takonaut.test/connect-runner?code=WXYZ-2345",
		]);
		expect(calls[0]).toEqual({
			method: "POST",
			path: "/api/runner/enrollment/start",
			body: { name: "Build Mac", capacity: 1 },
		});
		expect(calls[1]?.body).toEqual({ device_code: "tre_device-secret" });
		expect(logs.join("\n")).toContain("WXYZ-2345");
		expect(logs.join("\n")).not.toContain("tre_device-secret");
		expect(logs.join("\n")).not.toContain("tkr_machine-secret");
	});

	it("requires HTTPS except for explicit loopback development", () => {
		expect(() =>
			normalizeRunnerEnrollmentServerUrl("http://takonaut.app"),
		).toThrow(/https/i);
		expect(normalizeRunnerEnrollmentServerUrl("http://localhost:8000/")).toBe(
			"http://localhost:8000",
		);
		expect(normalizeRunnerEnrollmentServerUrl("http://127.0.0.1:8000")).toBe(
			"http://127.0.0.1:8000",
		);
	});

	it("refuses to open a cross-origin verification URL", async () => {
		const { deps, opened } = enrollmentDeps(
			[{ status: 428, json: { detail: "authorization_pending" } }],
			{
				verification_uri_complete:
					"https://attacker.test/connect-runner?code=WXYZ-2345",
			},
		);

		await expect(
			runRunnerEnrollment(
				"https://takonaut.test",
				{ name: "Build Mac", capacity: 1 },
				deps,
				1,
			),
		).rejects.toThrow(/same origin/i);
		expect(opened).toEqual([]);
	});

	it("explains recovery when credential delivery was already consumed", async () => {
		const { deps } = enrollmentDeps([
			{
				status: 409,
				json: {
					detail: {
						code: "RUNNER_ENROLLMENT_CONSUMED",
						runner_id: "runner-lost",
					},
				},
			},
		]);

		await expect(
			runRunnerEnrollment(
				"https://takonaut.test",
				{ name: "Build Mac", capacity: 1 },
				deps,
			),
		).rejects.toThrow(/runner-lost.*rotate or revoke/i);
	});
});
