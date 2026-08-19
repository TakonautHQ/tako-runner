import {
	createHash,
	createPublicKey,
	generateKeyPairSync,
	sign as cryptoSign,
	verify,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	RunnerApiClient,
	canonicalTrustedRunnerJson,
	executeTrustedGitHubOperation,
	loadRunnerDaemonConfig,
	saveRunnerDaemonConfig,
	signTrustedRunnerReceipt,
	verifyTrustedRunnerPermit,
	type RunnerClaim,
	type RunnerDaemonConfig,
} from "../src/runner";

const roots: string[] = [];

function parseJsonObject(value: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error("Expected valid JSON", { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Expected a JSON object");
	}
	return parsed as Record<string, unknown>;
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function runnerClaim(): RunnerClaim {
	return {
		run_id: "run-1",
		project_id: "project-1",
		event_key: "event-1",
		input: "Use Profile tools",
		trigger_payload: {},
		definition_snapshot: {
			agent_profile_id: "profile-1",
			agent_profile_revision_id: "profile-revision-1",
			agent_profile_revision_hash: "a".repeat(64),
			agent_profile_snapshot: {
				identity: { name: "Builder Profile" },
				instructions: "Use bounded tools.",
				tool_grants: {},
			},
		},
		revision_spec: {},
		operation_snapshot: {},
		publication_specs: [],
		reviewed_repository_id: "repo-1",
		repository: {
			id: "repo-1",
			owner: "acme",
			name: "widget",
			default_branch: "main",
		},
		reviewed_head_sha: "a".repeat(40),
		output_destination: "review_queue",
		autonomy: "approval",
		lease_expires_at: "2026-07-28T12:00:00Z",
		run_token: "run-token",
	};
}

function trustedConfig(): RunnerDaemonConfig {
	return {
		serverUrl: "https://takonaut.test",
		organizationId: "org-1",
		credential: "tkr_secret",
		pollIntervalMs: 2_000,
		leaseSeconds: 90,
		repositories: { "project-1": "/work/widget" },
		repositoryBindings: {
			"repo-1": {
				projectId: "project-1",
				path: "/work/widget",
				trustedNative: true,
			},
		},
	};
}

describe("Trusted Native Runner identity and capabilities", () => {
	it("generates an Ed25519 identity and stores only the private key in the secret file", () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-trusted-native-"));
		roots.push(root);
		const paths = {
			configPath: join(root, "runner.json"),
			credentialPath: join(root, "runner-credentials.json"),
		};
		saveRunnerDaemonConfig(trustedConfig(), paths);
		const loaded = loadRunnerDaemonConfig(paths);
		const publicFile = readFileSync(paths.configPath, "utf8");
		const secretFile = readFileSync(paths.credentialPath, "utf8");

		expect(loaded.signingKey?.keyId).toMatch(/^tnrk_/);
		expect(loaded.signingKey?.publicKeyB64).toBeTruthy();
		expect(loaded.signingKey?.privateKeyPem).toContain("PRIVATE KEY");
		expect(publicFile).not.toContain("PRIVATE KEY");
		expect(secretFile).toContain("PRIVATE KEY");
	});

	it("advertises protocol v3 capability evidence only for trusted repository bindings", async () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-trusted-capability-"));
		roots.push(root);
		const paths = {
			configPath: join(root, "runner.json"),
			credentialPath: join(root, "runner-credentials.json"),
		};
		saveRunnerDaemonConfig(trustedConfig(), paths);
		const config = loadRunnerDaemonConfig(paths);
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify({ status: "online" }), { status: 200 }),
		);
		const client = new RunnerApiClient(config, fetchMock as typeof fetch);
		await client.advertiseCapabilities();
		const body = parseJsonObject(String(fetchMock.mock.calls[0]?.[1]?.body));

		expect(body.protocol_version).toBe(3);
		expect(body.signing_key).toEqual({
			key_id: config.signingKey?.keyId,
			public_key_b64: config.signingKey?.publicKeyB64,
			algorithm: "Ed25519",
		});
		expect(body.repository_capabilities).toEqual([
			{
				repository_id: "repo-1",
				capabilities: [
					"git.detached_worktree",
					"github.native.v1",
					"profile_tools.proxy.v1",
					"receipts.ed25519.v1",
				],
			},
		]);
	});
});

describe("Trusted Native Runner broker", () => {
	it("executes only an allowlisted GitHub operation for the claimed repository", async () => {
		const execute = vi.fn(async () => ({
			stdout: JSON.stringify({ ref: "refs/heads/feature" }),
			stderr: "",
		}));
		const result = await executeTrustedGitHubOperation(
			{
				method: "POST",
				path: "/repos/acme/widget/git/refs",
				body: { ref: "refs/heads/feature", sha: "abc123" },
			},
			{ owner: "acme", name: "widget" },
			"/work/widget",
			execute,
		);

		expect(result).toEqual({ ref: "refs/heads/feature" });
		expect(execute).toHaveBeenCalledWith(
			"gh",
			[
				"api",
				"--method",
				"POST",
				"/repos/acme/widget/git/refs",
				"--input",
				"-",
			],
			expect.objectContaining({
				cwd: "/work/widget",
				input: JSON.stringify({ ref: "refs/heads/feature", sha: "abc123" }),
			}),
		);
	});

	it("rejects credentials, shell fragments, and cross-repository operations", async () => {
		const execute = vi.fn();
		await expect(
			executeTrustedGitHubOperation(
				{
					method: "POST",
					path: "/repos/other/private/git/refs",
					body: { token: "secret" },
				},
				{ owner: "acme", name: "widget" },
				"/work/widget",
				execute,
			),
		).rejects.toThrow(/repository scope/i);
		expect(execute).not.toHaveBeenCalled();
	});

	it("verifies platform permits against the exact Run, repository, and SHA", () => {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const publicJwk = publicKey.export({ format: "jwk" });
		if (!publicJwk.x) throw new Error("expected public key");
		const payload = {
			audience: "takonaut-trusted-runner-action",
			schema_version: 1,
			jti: "permit-1",
			action_id: "action-1",
			run_id: "run-1",
			repository_id: "repo-1",
			expected_sha: "a".repeat(40),
			operation: {
				method: "POST",
				path: "/repos/acme/widget/git/refs",
				body: { ref: "refs/heads/agent/fix", sha: "a".repeat(40) },
			},
			issued_at: new Date(Date.now() - 1_000).toISOString(),
			expires_at: new Date(Date.now() + 60_000).toISOString(),
		};
		const bytes = Buffer.from(canonicalTrustedRunnerJson(payload));
		const manifest = {
			algorithm: "Ed25519",
			key_id: "platform-key-1",
			payload_hash: createHash("sha256").update(bytes).digest("hex"),
			payload,
			signature_b64: cryptoSign(null, bytes, privateKey).toString("base64"),
		};
		const publicKeyB64 = Buffer.from(publicJwk.x, "base64url").toString(
			"base64",
		);

		expect(
			verifyTrustedRunnerPermit(
				manifest,
				publicKeyB64,
				runnerClaim(),
				"action-1",
			),
		).toMatchObject({ jti: "permit-1" });
		expect(() =>
			verifyTrustedRunnerPermit(
				{
					...manifest,
					payload: { ...payload, expected_sha: "b".repeat(40) },
				},
				publicKeyB64,
				runnerClaim(),
				"action-1",
			),
		).toThrow(/signature/i);
	});

	it("signs canonical immutable receipts with the Runner key", () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-trusted-receipt-"));
		roots.push(root);
		const paths = {
			configPath: join(root, "runner.json"),
			credentialPath: join(root, "runner-credentials.json"),
		};
		saveRunnerDaemonConfig(trustedConfig(), paths);
		const key = loadRunnerDaemonConfig(paths).signingKey;
		if (!key) throw new Error("expected signing key");
		const receipt = {
			action_id: "action-1",
			permit_nonce: "nonce-1",
			result_status: "succeeded",
			result: { ref: "refs/heads/feature" },
			completed_at: "2026-07-28T12:00:00.000Z",
		};
		const signature = signTrustedRunnerReceipt(receipt, key.privateKeyPem);
		const publicKey = createPublicKey({
			key: {
				kty: "OKP",
				crv: "Ed25519",
				x: Buffer.from(key.publicKeyB64, "base64").toString("base64url"),
			},
			format: "jwk",
		});
		expect(
			verify(
				null,
				Buffer.from(canonicalTrustedRunnerJson(receipt)),
				publicKey,
				Buffer.from(signature, "base64"),
			),
		).toBe(true);
	});
});
