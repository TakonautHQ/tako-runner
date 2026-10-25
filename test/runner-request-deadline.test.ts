import { createServer, type RequestListener } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { RunnerApiClient } from "../src/runner";

// Real loopback HTTP only: no repository checkout, provider, or AI runtime.
async function loopback(handler: RequestListener) {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing listener");
	return {
		url: `http://127.0.0.1:${address.port}`,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (
						!error ||
						("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
					)
						resolve();
					else reject(error);
				});
			});
		},
	};
}

function client(
	serverUrl: string,
	requestTimeoutMs = 250,
	fetchImpl: typeof fetch = fetch,
) {
	return new RunnerApiClient(
		{
			serverUrl,
			organizationId: "synthetic-org",
			credential: "synthetic-machine",
			leaseSeconds: 90,
			pollIntervalMs: 1000,
			repositories: {},
		},
		fetchImpl,
		{ requestTimeoutMs },
	);
}

// Keep the red test bounded even when the production request never settles.
async function observed<T>(
	promise: Promise<T>,
): Promise<T | "test deadline exceeded"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<"test deadline exceeded">((resolve) => {
				timer = setTimeout(() => resolve("test deadline exceeded"), 2000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

const timeoutMessage =
	"Takonaut Runner API request timed out; remote outcome is unknown";

describe("Runner request deadlines", () => {
	it("does not replay a timed-out delivery mutation or poison later requests", async () => {
		const issued = {
			run_id: "11111111-1111-4111-8111-111111111111",
			project_id: "22222222-2222-4222-8222-222222222222",
			attempt_id: "33333333-3333-4333-8333-333333333333",
			lease_expires_at: new Date(Date.now() + 90_000).toISOString(),
		};
		const seen: Array<{
			path: string | undefined;
			authenticated: boolean;
			attempt: string | string[] | undefined;
			body: string;
		}> = [];
		const peer = await loopback(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += String(chunk);
			seen.push({
				path: request.url,
				authenticated:
					request.headers.authorization === "Bearer synthetic-machine" &&
					request.headers["x-organization-id"] === "synthetic-org",
				attempt: request.headers["x-runner-attempt-id"],
				body,
			});
			if (request.url === "/api/runner/claim") {
				response.writeHead(204).end();
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			if (request.url?.endsWith("/complete")) response.write('{"pending":');
			else
				response.end(
					JSON.stringify(
						request.url?.endsWith("/delivery/claim")
							? issued
							: { status: "accepted" },
					),
				);
		});
		try {
			const api = client(peer.url);
			const claim = await api.claimDelivery();
			if (!claim) throw new Error("Missing claim");
			expect(
				await observed(
					api.completeDelivery(claim).then(
						() => "unexpected success",
						(error: Error) => error.message,
					),
				),
			).toBe(timeoutMessage);
			expect(await api.heartbeatDelivery(claim)).toEqual({
				status: "accepted",
			});
			expect(await api.claim()).toBeNull();
			expect(seen.map(({ path }) => path)).toEqual([
				"/api/runner/v2/delivery/claim",
				`/api/runner/v2/runs/${issued.run_id}/complete`,
				`/api/runner/v2/runs/${issued.run_id}/heartbeat`,
				"/api/runner/claim",
			]);
			expect(seen.every(({ authenticated }) => authenticated)).toBe(true);
			expect(seen.slice(1, 3).map(({ attempt }) => attempt)).toEqual([
				issued.attempt_id,
				issued.attempt_id,
			]);
			expect(seen.map(({ body }) => JSON.parse(body))).toEqual([
				{ lease_seconds: 90 },
				{},
				{ lease_seconds: 90 },
				{ lease_seconds: 90 },
			]);
		} finally {
			await peer.close();
		}
	});
	it("settles even if an injected transport ignores cancellation", async () => {
		let signal: AbortSignal | null | undefined;
		const transport: typeof fetch = async (_input, init) => {
			signal = init?.signal;
			return new Promise<Response>(() => {});
		};
		const outcome = client("http://127.0.0.1:1", 25, transport)
			.claim()
			.then(
				() => "unexpected success",
				(error: Error) => error.message,
			);
		expect(await observed(outcome)).toBe(timeoutMessage);
		expect(signal?.aborted).toBe(true);
	});
	it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 10_001])(
		"rejects an unsafe request deadline of %s before any I/O",
		(requestTimeoutMs) => {
			expect(() => client("http://127.0.0.1:1", requestTimeoutMs)).toThrow(
				"Runner request timeout must be an integer from 1 to 10000 ms",
			);
		},
	);
	it("bounds setup-catalog reads as well as run mutations", async () => {
		const peer = await loopback((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.write('{"catalog":');
		});
		try {
			const outcome = client(peer.url)
				.setupCatalog()
				.then(
					() => "unexpected success",
					(error: Error) => error.message,
				);
			expect(await observed(outcome)).toBe(timeoutMessage);
		} finally {
			await peer.close();
		}
	});
	it.each([200, 401, 409])(
		"keeps the deadline active while reading a stalled %s body",
		async (status) => {
			const peer = await loopback((_request, response) => {
				response.writeHead(status, {
					"Content-Type": "application/json",
				});
				response.write(
					'{"sensitive":"synthetic-body-that-must-not-appear-in-timeouts',
				);
			});
			try {
				const outcome = client(peer.url)
					.heartbeat("synthetic-run", "synthetic-run-token", 90)
					.then(
						() => "unexpected success",
						(error: Error) => error.message,
					);
				expect(await observed(outcome)).toBe(timeoutMessage);
			} finally {
				await peer.close();
			}
		},
	);
	it("aborts a heartbeat whose peer never sends headers", async () => {
		let disconnected!: () => void;
		const closed = new Promise<void>((resolve) => {
			disconnected = resolve;
		});
		let requests = 0;
		// Raw TCP observes actual disconnection on Node and Bun. Bun's node:http
		// compatibility layer does not emit response/socket close for this peer.
		const sockets = new Set<Socket>();
		const peer = createTcpServer((socket) => {
			sockets.add(socket);
			socket.once("data", () => {
				requests += 1;
			});
			socket.once("close", disconnected);
		});
		await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
		try {
			const address = peer.address();
			if (!address || typeof address === "string")
				throw new Error("Missing listener");
			const outcome = client(`http://127.0.0.1:${address.port}`)
				.heartbeat("synthetic-run", "synthetic-run-token", 90)
				.then(
					() => "unexpected success",
					(error: Error) => error.message,
				);
			expect(await observed(outcome)).toBe(timeoutMessage);
			expect(await observed(closed.then(() => "disconnected"))).toBe(
				"disconnected",
			);
			expect(requests).toBe(1);
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				peer.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
