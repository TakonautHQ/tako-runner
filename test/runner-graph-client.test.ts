import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createServer, type RequestListener } from "node:http";
import { describe, expect, it } from "vitest";
import { RunnerApiClient, type RunnerGraphClaim } from "../src/runner";

// Actual loopback HTTP; no checkout, extractor, provider or AI runtime.
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

const organizationId = randomUUID();

function client(serverUrl: string) {
	return new RunnerApiClient({
		serverUrl,
		organizationId,
		credential: "synthetic",
		leaseSeconds: 90,
		pollIntervalMs: 1000,
		repositories: {},
	});
}

function contract(overrides: Record<string, unknown> = {}) {
	const repositoryId = randomUUID();
	return {
		build_id: randomUUID(),
		project_id: randomUUID(),
		repository_id: repositoryId,
		repository: {
			id: repositoryId,
			owner: "acme",
			name: "widget",
			default_branch: "main",
		},
		commit_sha: "a".repeat(40),
		attempt_id: randomUUID(),
		lease_expires_at: new Date(Date.now() + 90_000).toISOString(),
		path_allowlist: ["src/**"],
		policy_revision: 1,
		access_epoch: 0,
		extractor: "tako-structure/1",
		extractor_config_hash: "b".repeat(64),
		schema_version: 1,
		...overrides,
	};
}

describe("graph build control client", () => {
	it("keeps the issued attempt on heartbeat and failure, even after a newer claim", async () => {
		let current = contract();
		const seen: Array<{ url?: string; attempt?: string; body: unknown }> = [];
		const peer = await loopback(async (request, response) => {
			response.setHeader("Content-Type", "application/json");
			if (
				request.headers.authorization !== "Bearer synthetic" ||
				request.headers["x-organization-id"] !== organizationId
			) {
				response.writeHead(401).end();
				return;
			}
			let raw = "";
			for await (const chunk of request) raw += String(chunk);
			if (request.url === "/api/runner/v2/graph/claim") {
				current = contract({ build_id: current.build_id });
				response.end(JSON.stringify(current));
				return;
			}
			const attempt = request.headers["x-runner-attempt-id"];
			if (attempt !== current.attempt_id) {
				response.writeHead(409).end(JSON.stringify({ detail: "lease_lost" }));
				return;
			}
			seen.push({
				url: request.url,
				attempt: String(attempt),
				body: JSON.parse(raw),
			});
			if (request.url?.endsWith("/fail")) {
				response.writeHead(204).end();
				return;
			}
			response.end(
				JSON.stringify({
					active: true,
					lease_expires_at: current.lease_expires_at,
				}),
			);
		});
		try {
			const api = client(peer.url);
			const first = await api.claimGraphBuild();
			const second = await api.claimGraphBuild();
			if (!first || !second) throw new Error("Missing test claim");
			expect(Object.isFrozen(first)).toBe(true);
			expect(Object.isFrozen(first.path_allowlist)).toBe(true);
			expect(first.repository).toEqual({
				id: first.repository_id,
				owner: "acme",
				name: "widget",
				default_branch: "main",
			});
			expect(Object.isFrozen(first.repository)).toBe(true);
			await expect(api.heartbeatGraphBuild(first)).rejects.toThrow("409");
			await expect(
				api.failGraphBuild(first, "extractor_failed"),
			).rejects.toThrow("409");
			expect(await api.heartbeatGraphBuild(second)).toEqual({
				active: true,
				lease_expires_at: second.lease_expires_at,
			});
			expect(await api.failGraphBuild(second, "extractor_failed")).toBeNull();
			const base = `/api/runner/v2/graph/builds/${second.build_id}`;
			expect(seen).toEqual([
				{
					url: `${base}/heartbeat`,
					attempt: second.attempt_id,
					body: { lease_seconds: 90 },
				},
				{
					url: `${base}/fail`,
					attempt: second.attempt_id,
					body: { failure_code: "extractor_failed" },
				},
			]);
		} finally {
			await peer.close();
		}
	});

	it("returns null when no build is available", async () => {
		const peer = await loopback((_request, response) => {
			response.writeHead(204).end();
		});
		try {
			expect(await client(peer.url).claimGraphBuild()).toBeNull();
		} finally {
			await peer.close();
		}
	});

	it.each([
		["a short commit", { commit_sha: "abc" }],
		["an uppercase commit", { commit_sha: "A".repeat(40) }],
		["a non-UUID attempt", { attempt_id: "attempt-1" }],
		["a non-string allowlist entry", { path_allowlist: ["src/**", 7] }],
		["an empty allowlist", { path_allowlist: [] }],
		["a fractional revision", { policy_revision: 1.5 }],
		["an unparseable lease", { lease_expires_at: "soon" }],
		["a missing extractor", { extractor: undefined }],
		["a missing repository", { repository: undefined }],
		[
			"a repository that is not the claimed one",
			{
				repository: {
					id: randomUUID(),
					owner: "acme",
					name: "widget",
					default_branch: "main",
				},
			},
		],
		[
			"an empty repository owner",
			{
				repository_id: "00000000-0000-4000-8000-000000000001",
				repository: {
					id: "00000000-0000-4000-8000-000000000001",
					owner: "",
					name: "widget",
					default_branch: "main",
				},
			},
		],
		[
			"a non-string default branch",
			{
				repository_id: "00000000-0000-4000-8000-000000000001",
				repository: {
					id: "00000000-0000-4000-8000-000000000001",
					owner: "acme",
					name: "widget",
					default_branch: 7,
				},
			},
		],
	])("rejects a claim with %s", async (_label, overrides) => {
		const peer = await loopback((_request, response) => {
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify(contract(overrides)));
		});
		try {
			await expect(client(peer.url).claimGraphBuild()).rejects.toThrow(
				"Invalid graph build claim contract",
			);
		} finally {
			await peer.close();
		}
	});
});

describe("graph artifact upload", () => {
	const artifact = Buffer.from('{"artifact":"canonical"}');
	const digest = createHash("sha256").update(artifact).digest("hex");

	it("sends the verified bytes compressed, on the issued attempt", async () => {
		const claim = contract();
		const seen: {
			method?: string;
			url?: string;
			headers?: Record<string, unknown>;
			body?: Buffer;
		} = {};
		const snapshotId = randomUUID();
		const peer = await loopback(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk as Buffer);
			seen.method = request.method;
			seen.url = request.url;
			seen.headers = request.headers;
			seen.body = Buffer.concat(chunks);
			response.writeHead(202, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ snapshot_id: snapshotId }));
		});
		try {
			const result = await client(peer.url).uploadGraphArtifact(
				claim as unknown as RunnerGraphClaim,
				{ bytes: artifact, sha256: digest },
				new AbortController().signal,
			);
			expect(result).toEqual({ snapshot_id: snapshotId });
			expect(seen.method).toBe("PUT");
			expect(seen.url).toBe(
				`/api/runner/v2/graph/builds/${claim.build_id}/artifact`,
			);
			expect(seen.headers).toMatchObject({
				authorization: "Bearer synthetic",
				"x-organization-id": organizationId,
				"x-runner-attempt-id": claim.attempt_id,
				"content-type": "application/gzip",
				"x-artifact-sha256": digest,
				"x-artifact-bytes": String(artifact.length),
			});
			expect(gunzipSync(seen.body ?? Buffer.alloc(0))).toEqual(artifact);
		} finally {
			await peer.close();
		}
	});

	it("surfaces a refused upload", async () => {
		const peer = await loopback((_request, response) => {
			response.writeHead(409, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ detail: "lease_lost" }));
		});
		try {
			await expect(
				client(peer.url).uploadGraphArtifact(
					contract() as unknown as RunnerGraphClaim,
					{ bytes: artifact, sha256: digest },
					new AbortController().signal,
				),
			).rejects.toThrow("409");
		} finally {
			await peer.close();
		}
	});

	it("stops when the build is stopped", async () => {
		const peer = await loopback(() => {
			// Never answers: only the abort can end the upload.
		});
		const stop = new AbortController();
		setTimeout(() => stop.abort(new Error("lease lost")), 50);
		try {
			await expect(
				client(peer.url).uploadGraphArtifact(
					contract() as unknown as RunnerGraphClaim,
					{ bytes: artifact, sha256: digest },
					stop.signal,
				),
			).rejects.toThrow("lease lost");
		} finally {
			await peer.close();
		}
	});
});
