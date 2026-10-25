import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { RunnerApiClient } from "../src/runner";

// Actual loopback HTTP, not a fetch stub; no provider/AI/runtime is invoked.
describe("delivery wire client", () => {
	it("retains the issued attempt on every mutation after another claim", async () => {
		const runId = randomUUID();
		const projectId = randomUUID();
		const organizationId = randomUUID();
		let currentAttempt = "";
		let empty = false;
		const seen: string[] = [];
		const bodies: unknown[] = [];
		const server = createServer(async (request, response) => {
			response.setHeader("Content-Type", "application/json");
			if (
				request.method !== "POST" ||
				request.headers.authorization !== "Bearer synthetic" ||
				request.headers["x-organization-id"] !== organizationId
			) {
				response.writeHead(401).end();
				return;
			}
			let rawBody = "";
			for await (const chunk of request) rawBody += String(chunk);
			if (request.url === "/api/runner/v2/delivery/claim") {
				if (empty) {
					response.writeHead(204).end();
					return;
				}
				currentAttempt = randomUUID();
				response.end(
					JSON.stringify({
						run_id: runId,
						project_id: projectId,
						attempt_id: currentAttempt,
						lease_expires_at: new Date(Date.now() + 90_000).toISOString(),
					}),
				);
				return;
			}
			if (request.headers["x-runner-attempt-id"] !== currentAttempt) {
				response
					.writeHead(409)
					.end(JSON.stringify({ detail: "stale attempt" }));
				return;
			}
			seen.push(request.url ?? "");
			bodies.push(JSON.parse(rawBody));
			response.end(JSON.stringify({ status: "accepted" }));
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("Missing test listener");
			const api = new RunnerApiClient({
				serverUrl: `http://127.0.0.1:${address.port}`,
				organizationId,
				credential: "synthetic",
				leaseSeconds: 90,
				pollIntervalMs: 1000,
				repositories: {},
			});
			const first = await api.claimDelivery();
			const second = await api.claimDelivery();
			if (!first || !second) throw new Error("Missing test claim");
			expect(first.attempt_id).not.toBe(second.attempt_id);
			expect(Object.isFrozen(first)).toBe(true);
			const commandId = randomUUID();
			for (const claim of [first, second]) {
				const calls = [
					() => api.heartbeatDelivery(claim),
					() => api.activityDelivery(claim, "active"),
					() => api.evidenceDelivery(claim, "test-key", "Synthetic", {}),
					() => api.pollDeliveryCommands(claim),
					() =>
						api.acknowledgeDeliveryCommand(claim, commandId, {
							accepted: true,
						}),
					() => api.completeDelivery(claim),
				];
				for (const call of calls) {
					if (claim === first) await expect(call()).rejects.toThrow("409");
					else await expect(call()).resolves.toEqual({ status: "accepted" });
				}
			}
			expect(seen).toEqual(
				[
					"heartbeat",
					"activity",
					"evidence",
					"commands/poll",
					`commands/${commandId}/ack`,
					"complete",
				].map((suffix) => `/api/runner/v2/runs/${runId}/${suffix}`),
			);
			expect(bodies).toEqual([
				{ lease_seconds: 90 },
				{ phase: "active" },
				{ idempotency_key: "test-key", title: "Synthetic", body: {} },
				{},
				{ result: { accepted: true } },
				{},
			]);
			empty = true;
			expect(await api.claimDelivery()).toBeNull();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					// Bun may close the listener along with its connections.
					if (
						!error ||
						("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
					)
						resolve();
					else reject(error);
				});
			});
		}
	});
});
