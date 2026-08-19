import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	RunnerApiClient,
	changedSafeRunnerPaths,
	cleanupRunnerCheckout,
	loadRunnerDaemonConfig,
	makeRunnerTools,
	prepareRunnerCheckout,
	processRunnerClaim,
	resolveRunnerRepositoryRoot,
	resolveSafeRunnerPath,
	runnerDiffRange,
	runnerFetchRefspecs,
	runnerSystemPrompt,
	saveRunnerDaemonConfig,
	type RunnerClaim,
} from "../src/runner";

function parseJsonObject(value: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error("Expected valid JSON", { cause: error });
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("Expected a JSON object");
	}
	return parsed as Record<string, unknown>;
}

const claim = (overrides: Partial<RunnerClaim> = {}): RunnerClaim => ({
	run_id: "run-1",
	project_id: "project-1",
	event_key: "event-1",
	input: "Review this change.",
	trigger_payload: { head_sha: "abc123" },
	definition_snapshot: {
		agent_profile_id: "profile-1",
		agent_profile_revision_id: "profile-revision-1",
		agent_profile_revision_hash: "a".repeat(64),
		agent_profile_snapshot: {
			identity: { name: "Review Profile" },
			instructions: "Review only.",
			tool_grants: { allow: ["read", "grep"] },
		},
	},
	revision_spec: {},
	operation_snapshot: {},
	publication_specs: [
		{
			schema_version: 1,
			handler: "github.pr_comment",
			handler_version: 1,
			policy: "approval",
			target: { repository_id: "repo-1", pr_number: 42 },
		},
	],
	reviewed_repository_id: "repo-1",
	repository: {
		id: "repo-1",
		owner: "acme",
		name: "widget",
		default_branch: "main",
	},
	reviewed_head_sha: "abc123",
	output_destination: "github.comment",
	autonomy: "approval",
	lease_expires_at: "2026-07-28T12:00:00Z",
	run_token: "run-token",
	...overrides,
});

describe("Runner daemon config", () => {
	const roots: string[] = [];
	afterEach(() => {
		delete process.env.TAKONAUT_RUNNER_ALLOW_UNSAFE_ANCESTOR;
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	it("stores the bearer credential only in a 0600 secret file", () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-runner-config-"));
		roots.push(root);
		const configPath = join(root, "runner.json");
		const credentialPath = join(root, "runner-credentials.json");
		const capabilityConfig = {
			serverUrl: "https://takonaut.test",
			organizationId: "org-1",
			credential: "tkr_secret",
			pollIntervalMs: 2_000,
			leaseSeconds: 90,
			repositories: { "project-1": "/work/widget" },
			repositoryBindings: {
				"repo-1": { projectId: "project-1", path: "/work/widget" },
			},
			agentIds: ["agent-1"],
		};
		saveRunnerDaemonConfig(capabilityConfig, { configPath, credentialPath });

		expect(readFileSync(configPath, "utf8")).not.toContain("tkr_secret");
		expect(readFileSync(configPath, "utf8")).not.toContain("agentIds");
		expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
		expect(
			loadRunnerDaemonConfig({ configPath, credentialPath }),
		).toMatchObject({
			credential: "tkr_secret",
			repositories: { "project-1": "/work/widget" },
			repositoryBindings: {
				"repo-1": { projectId: "project-1", path: "/work/widget" },
			},
		});
	});

	it("resolves repository paths by repository ID without crossing Projects", () => {
		const config = {
			serverUrl: "https://takonaut.test",
			organizationId: "org-1",
			credential: "tkr_secret",
			pollIntervalMs: 2_000,
			leaseSeconds: 90,
			repositories: { "project-1": "/legacy/widget" },
			repositoryBindings: {
				"repo-1": { projectId: "project-1", path: "/bound/widget" },
			},
			agentIds: ["agent-1"],
		};
		expect(resolveRunnerRepositoryRoot(config, claim())).toBe("/bound/widget");
		expect(() =>
			resolveRunnerRepositoryRoot(config, claim({ project_id: "project-2" })),
		).toThrow(/Project/i);
	});

	it("requires HTTPS except for loopback runtime configuration", () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-runner-https-"));
		roots.push(root);
		const paths = {
			configPath: join(root, "runner.json"),
			credentialPath: join(root, "runner-credentials.json"),
		};
		const config = {
			serverUrl: "http://takonaut.test",
			organizationId: "org-1",
			credential: "tkr_secret",
			pollIntervalMs: 2_000,
			leaseSeconds: 90,
			repositories: {},
		};

		expect(() => saveRunnerDaemonConfig(config, paths)).toThrow(/https/i);
		expect(() =>
			saveRunnerDaemonConfig(
				{ ...config, serverUrl: "http://localhost:8000" },
				paths,
			),
		).not.toThrow();
	});

	it("rejects insecure or symlinked configuration directories", () => {
		const insecure = mkdtempSync(join(tmpdir(), "takonaut-runner-insecure-"));
		const target = mkdtempSync(join(tmpdir(), "takonaut-runner-target-"));
		const linkRoot = mkdtempSync(join(tmpdir(), "takonaut-runner-link-"));
		const writableAncestor = mkdtempSync(
			join(tmpdir(), "takonaut-runner-writable-ancestor-"),
		);
		roots.push(insecure, target, linkRoot, writableAncestor);
		chmodSync(insecure, 0o755);
		const config = {
			serverUrl: "https://takonaut.test",
			organizationId: "org-1",
			credential: "tkr_secret",
			pollIntervalMs: 2_000,
			leaseSeconds: 90,
			repositories: {},
		};
		const saveInReadableDirectory = () =>
			saveRunnerDaemonConfig(config, {
				configPath: join(insecure, "runner.json"),
				credentialPath: join(insecure, "runner-credentials.json"),
			});
		expect(saveInReadableDirectory).toThrow(
			/contains machine identity and local repository mappings/i,
		);
		expect(saveInReadableDirectory).toThrow(/chmod 700/i);

		const privateChild = join(writableAncestor, "private");
		mkdirSync(privateChild, { mode: 0o700 });
		chmodSync(writableAncestor, 0o777);
		const saveBelowWritableAncestor = () =>
			saveRunnerDaemonConfig(config, {
				configPath: join(privateChild, "runner.json"),
				credentialPath: join(privateChild, "runner-credentials.json"),
			});
		expect(saveBelowWritableAncestor).toThrow(
			/Writable ancestors let another local account replace Runner configuration, credentials, or repository paths/i,
		);
		expect(saveBelowWritableAncestor).toThrow(
			/--allow-unsafe-ancestor.*takonaut-runner-writable-ancestor/i,
		);

		const linkedDirectory = join(linkRoot, "config");
		symlinkSync(target, linkedDirectory, "dir");
		expect(() =>
			saveRunnerDaemonConfig(config, {
				configPath: join(linkedDirectory, "runner.json"),
				credentialPath: join(linkedDirectory, "runner-credentials.json"),
			}),
		).toThrow(/symlink/i);

		const nestedTarget = join(target, "nested");
		mkdirSync(nestedTarget, { mode: 0o700 });
		const linkedAncestor = join(linkRoot, "ancestor");
		symlinkSync(target, linkedAncestor, "dir");
		expect(() =>
			saveRunnerDaemonConfig(config, {
				configPath: join(linkedAncestor, "nested", "runner.json"),
				credentialPath: join(
					linkedAncestor,
					"nested",
					"runner-credentials.json",
				),
			}),
		).toThrow(/symlink/i);
	});

	it("allows only one explicitly selected writable ancestor", () => {
		const writableAncestor = mkdtempSync(
			join(tmpdir(), "takonaut-runner-allowed-ancestor-"),
		);
		const privateChild = join(writableAncestor, "private");
		const secondWritableAncestor = join(writableAncestor, "still-unsafe");
		const secondPrivateChild = join(secondWritableAncestor, "private");
		roots.push(writableAncestor);
		mkdirSync(privateChild, { mode: 0o700 });
		mkdirSync(secondWritableAncestor, { mode: 0o777 });
		mkdirSync(secondPrivateChild, { mode: 0o700 });
		chmodSync(writableAncestor, 0o777);
		chmodSync(secondWritableAncestor, 0o777);
		process.env.TAKONAUT_RUNNER_ALLOW_UNSAFE_ANCESTOR = writableAncestor;
		const config = {
			serverUrl: "https://takonaut.test",
			organizationId: "org-1",
			credential: "tkr_secret",
			pollIntervalMs: 2_000,
			leaseSeconds: 90,
			repositories: {},
		};

		expect(() =>
			saveRunnerDaemonConfig(config, {
				configPath: join(privateChild, "runner.json"),
				credentialPath: join(privateChild, "runner-credentials.json"),
			}),
		).not.toThrow();
		expect(() =>
			saveRunnerDaemonConfig(config, {
				configPath: join(secondPrivateChild, "runner.json"),
				credentialPath: join(secondPrivateChild, "runner-credentials.json"),
			}),
		).toThrow(new RegExp(secondWritableAncestor));
	});

	it("accepts the exact unsafe ancestor through the CLI flag", () => {
		const writableAncestor = mkdtempSync(
			join(tmpdir(), "takonaut-runner-cli-ancestor-"),
		);
		const privateChild = join(writableAncestor, "private");
		roots.push(writableAncestor);
		mkdirSync(privateChild, { mode: 0o700 });
		chmodSync(writableAncestor, 0o777);
		const paths = {
			configPath: join(privateChild, "runner.json"),
			credentialPath: join(privateChild, "runner-credentials.json"),
		};
		process.env.TAKONAUT_RUNNER_ALLOW_UNSAFE_ANCESTOR = writableAncestor;
		saveRunnerDaemonConfig(
			{
				serverUrl: "https://takonaut.test",
				organizationId: "org-1",
				credential: "tkr_secret",
				pollIntervalMs: 2_000,
				leaseSeconds: 90,
				repositories: {},
			},
			paths,
		);
		delete process.env.TAKONAUT_RUNNER_ALLOW_UNSAFE_ANCESTOR;

		const stdout = execFileSync(
			"bun",
			[
				fileURLToPath(new URL("../src/runner-cli.ts", import.meta.url)),
				"status",
				"--allow-unsafe-ancestor",
				writableAncestor,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					TAKONAUT_RUNNER_CONFIG: paths.configPath,
					TAKONAUT_RUNNER_CREDENTIALS: paths.credentialPath,
				},
			},
		);

		expect(parseJsonObject(stdout)).toMatchObject({ organizationId: "org-1" });
	});

	it("rejects existing configuration files with permissive modes", () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-runner-file-mode-"));
		roots.push(root);
		const paths = {
			configPath: join(root, "runner.json"),
			credentialPath: join(root, "runner-credentials.json"),
		};
		writeFileSync(paths.configPath, "{}", { mode: 0o600 });
		writeFileSync(paths.credentialPath, "{}", { mode: 0o600 });
		chmodSync(paths.configPath, 0o644);

		expect(() =>
			saveRunnerDaemonConfig(
				{
					serverUrl: "https://takonaut.test",
					organizationId: "org-1",
					credential: "tkr_secret",
					pollIntervalMs: 2_000,
					leaseSeconds: 90,
					repositories: {},
				},
				paths,
			),
		).toThrow(/group\/others/i);
	});

	it("rejects malformed JSON and non-numeric intervals", () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-runner-invalid-"));
		roots.push(root);
		const paths = {
			configPath: join(root, "runner.json"),
			credentialPath: join(root, "runner-credentials.json"),
		};
		saveRunnerDaemonConfig(
			{
				serverUrl: "https://takonaut.test",
				organizationId: "org-1",
				credential: "tkr_secret",
				pollIntervalMs: 2_000,
				leaseSeconds: 90,
				repositories: {},
			},
			paths,
		);

		writeFileSync(paths.configPath, "{");
		expect(() => loadRunnerDaemonConfig(paths)).toThrow(
			"Runner config is not valid JSON",
		);
		writeFileSync(
			paths.configPath,
			JSON.stringify({
				serverUrl: "https://takonaut.test",
				organizationId: "org-1",
				pollIntervalMs: "later",
				leaseSeconds: 90,
				repositories: {},
			}),
		);
		expect(() => loadRunnerDaemonConfig(paths)).toThrow(
			"Runner polling and lease intervals must be finite numbers",
		);
		writeFileSync(
			paths.configPath,
			JSON.stringify({
				serverUrl: "http://",
				organizationId: "org-1",
				pollIntervalMs: 2_000,
				leaseSeconds: 90,
				repositories: {},
			}),
		);
		expect(() => loadRunnerDaemonConfig(paths)).toThrow(
			"Runner server URL must be a valid http or https URL",
		);
	});
});

describe("Runner API client", () => {
	it("uses the machine credential only for claim and the short token for run calls", async () => {
		const fetchMock = vi.fn(
			async (input: string | URL | Request, _init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/runner/claim")) {
					return new Response(JSON.stringify(claim()), { status: 200 });
				}
				return new Response(JSON.stringify({ status: "running" }), {
					status: 200,
				});
			},
		);
		const client = new RunnerApiClient(
			{
				serverUrl: "https://takonaut.test/",
				organizationId: "org-1",
				credential: "tkr_machine",
				pollIntervalMs: 2_000,
				leaseSeconds: 90,
				repositories: {},
				repositoryBindings: {
					"repo-1": { projectId: "project-1", path: "/work/widget" },
				},
			},
			fetchMock as typeof fetch,
		);

		await (
			client as RunnerApiClient & {
				advertiseCapabilities(): Promise<unknown>;
			}
		).advertiseCapabilities();
		const claimed = await client.claim();
		expect(claimed?.run_id).toBe("run-1");
		await client.heartbeat("run-1", "short-token", 90);

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://takonaut.test/api/runner/capabilities",
		);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			method: "PUT",
			redirect: "error",
			headers: {
				Authorization: "Bearer tkr_machine",
				"X-Organization-Id": "org-1",
			},
		});
		expect(
			parseJsonObject(String(fetchMock.mock.calls[0]?.[1]?.body)),
		).toMatchObject({
			protocol_version: 1,
			runner_version: "0.2.0",
			repository_ids: ["repo-1"],
		});
		expect(
			parseJsonObject(String(fetchMock.mock.calls[0]?.[1]?.body)),
		).not.toHaveProperty("agent_ids");
		expect(fetchMock.mock.calls[1]?.[1]?.redirect).toBe("error");
		expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
			Authorization: "Bearer tkr_machine",
			"X-Organization-Id": "org-1",
		});
		expect(fetchMock.mock.calls[2]?.[1]?.redirect).toBe("error");
		expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
			Authorization: "Bearer short-token",
			"X-Organization-Id": "org-1",
		});
	});
});

describe("Runner tool grants", () => {
	it("exposes only tools allowed by the immutable Agent snapshot", () => {
		expect(
			makeRunnerTools(process.cwd(), claim()).map((tool) => tool.name),
		).toEqual(["runner_read", "runner_grep"]);
	});

	it("supports enabled catalog-style Runner and PR review grants", () => {
		const catalogClaim = claim({
		definition_snapshot: {
			...claim().definition_snapshot,
			agent_profile_snapshot: {
				...claim().definition_snapshot.agent_profile_snapshot,
				tool_grants: {
					"runner.read": { enabled: true },
					"runner.diff": { enabled: true },
					"runner.grep": { enabled: false },
				},
			},
		},
		});
		expect(
			makeRunnerTools(process.cwd(), catalogClaim).map((tool) => tool.name),
		).toEqual(["runner_read", "runner_git_diff"]);

		const reviewClaim = claim({
			definition_snapshot: {
				...claim().definition_snapshot,
				agent_profile_snapshot: {
						...claim().definition_snapshot.agent_profile_snapshot,
						tool_grants: { "github.review": { enabled: true } },
				},
			},
		});
		expect(
			makeRunnerTools(process.cwd(), reviewClaim).map((tool) => tool.name),
		).toEqual([
			"runner_read",
			"runner_list",
			"runner_find",
			"runner_grep",
			"runner_git_diff",
		]);
	});
});

describe("Runner Profile identity", () => {
	it("uses only the nested immutable Profile identity and instructions", () => {
		const prompt = runnerSystemPrompt(claim(), false);
		expect(prompt).toContain("Agent Profile 'Review Profile'");
		expect(prompt).toContain("Review only.");
		expect(prompt).not.toContain("agent_slug");
	});

	it("falls back only to the immutable Profile ID when the Profile name is absent", () => {
		const prompt = runnerSystemPrompt(
			claim({
				definition_snapshot: {
					...claim().definition_snapshot,
					agent_profile_snapshot: { tool_grants: {} },
				},
			}),
			false,
		);
		expect(prompt).toContain("Agent Profile 'profile-1'");
		expect(prompt).toContain(
			"Follow the immutable Profile policy and use only allowed tools.",
		);
	});
});

describe("Runner immutable revision", () => {
	it("uses the exact PR base and head SHAs instead of the moving default branch", () => {
		const headSha = "a".repeat(40);
		const baseSha = "b".repeat(40);
		const exactClaim = claim({
			reviewed_head_sha: headSha,
			revision_spec: {
				schema_version: 1,
				type: "github.pr_range",
				pull_request_number: 42,
				pull_ref: "refs/pull/42/head",
				base: {
					repository_full_name: "acme/widget",
					ref: "release/2.x",
					sha: baseSha,
				},
				head: {
					repository_full_name: "contributor/widget",
					ref: "feature/refund-guard",
					sha: headSha,
				},
			},
		});
		expect(runnerDiffRange(exactClaim)).toEqual({
			base: baseSha,
			head: headSha,
		});
		expect(runnerFetchRefspecs(exactClaim)).toEqual([
			"+refs/heads/release/2.x:refs/remotes/origin/release/2.x",
			"+refs/pull/42/head:refs/takonaut/pull/run-1/head",
			baseSha,
			headSha,
		]);
	});
});

describe("Runner repository boundary", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	it("blocks escapes, symlinks, and secret paths", () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-runner-path-"));
		roots.push(root);
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "app.ts"), "export const ok = true;\n");
		for (const secret of [
			".env",
			"secret.env",
			"credentials.json",
			".npmrc",
			".netrc",
			"signing.p8",
		]) {
			writeFileSync(join(root, secret), "SECRET=x\n");
		}
		symlinkSync(join(root, "src", "app.ts"), join(root, "linked.ts"));

		expect(resolveSafeRunnerPath(root, "src/app.ts")).toBe(
			realpathSync(join(root, "src", "app.ts")),
		);
		expect(() => resolveSafeRunnerPath(root, "../outside")).toThrow(/outside/i);
		for (const secret of [
			".env",
			"secret.env",
			"credentials.json",
			".npmrc",
			".netrc",
			"signing.p8",
		]) {
			expect(() => resolveSafeRunnerPath(root, secret)).toThrow(/sensitive/i);
		}
		expect(() => resolveSafeRunnerPath(root, "linked.ts")).toThrow(/symlink/i);

		const sensitiveRoot = join(root, ".ssh");
		mkdirSync(sensitiveRoot, { mode: 0o700 });
		expect(() => resolveSafeRunnerPath(sensitiveRoot, ".")).toThrow(
			/sensitive/i,
		);
	});

	it("excludes tracked secrets from Git diff paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-runner-diff-"));
		roots.push(root);
		execFileSync("git", ["init", root]);
		execFileSync("git", ["-C", root, "config", "user.name", "Runner Test"]);
		execFileSync("git", [
			"-C",
			root,
			"config",
			"user.email",
			"runner@test.invalid",
		]);
		writeFileSync(join(root, "README.md"), "base\n");
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", ["-C", root, "commit", "-m", "base"]);
		const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		execFileSync("git", [
			"-C",
			root,
			"update-ref",
			"refs/remotes/origin/main",
			base,
		]);
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "app.ts"), "export const ok = true;\n");
		writeFileSync(join(root, "credentials.json"), '{"token":"secret"}\n');
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", ["-C", root, "commit", "-m", "change"]);
		const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();

		expect(await changedSafeRunnerPaths(root, "origin/main", head)).toEqual([
			"src/app.ts",
		]);
	});

	it("surfaces unrecoverable Git worktree cleanup failures", async () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-runner-cleanup-"));
		roots.push(root);
		const worktree = join(root, "worktree");
		mkdirSync(worktree);
		await expect(
			cleanupRunnerCheckout({
				cwd: worktree,
				worktreePath: worktree,
				repositoryRoot: join(root, "missing-repository"),
			}),
		).rejects.toThrow();
	});

	it("fetches and checks out the exact server SHA in an isolated worktree", async () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-runner-git-"));
		roots.push(root);
		const remote = join(root, "remote.git");
		const source = join(root, "source");
		const worktrees = join(root, "worktrees");
		execFileSync("git", ["init", "--bare", remote]);
		execFileSync("git", ["init", source]);
		execFileSync("git", ["-C", source, "config", "user.name", "Runner Test"]);
		execFileSync("git", [
			"-C",
			source,
			"config",
			"user.email",
			"runner@test.invalid",
		]);
		writeFileSync(join(source, "README.md"), "first\n");
		execFileSync("git", ["-C", source, "add", "README.md"]);
		execFileSync("git", ["-C", source, "commit", "-m", "first"]);
		const sha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		execFileSync("git", [
			"-C",
			source,
			"remote",
			"add",
			"origin",
			"https://github.com/acme/widget.git",
		]);
		execFileSync("git", [
			"-C",
			source,
			"config",
			`url.${remote}.insteadOf`,
			"https://github.com/acme/widget.git",
		]);
		execFileSync("git", ["-C", source, "push", "origin", "HEAD:main"]);

		const checkout = await prepareRunnerCheckout(
			claim({ reviewed_head_sha: sha }),
			source,
			worktrees,
		);
		expect(
			execFileSync("git", ["-C", checkout.cwd, "rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim(),
		).toBe(sha);
		expect(checkout.cwd).not.toBe(source);
		await cleanupRunnerCheckout(checkout);
		expect(() => statSync(checkout.cwd)).toThrow();

		const redirectedWorktrees = join(root, "redirected-worktrees");
		const linkedWorktrees = join(root, "linked-worktrees");
		mkdirSync(redirectedWorktrees, { mode: 0o700 });
		symlinkSync(redirectedWorktrees, linkedWorktrees, "dir");
		await expect(
			prepareRunnerCheckout(
				claim({ reviewed_head_sha: sha }),
				source,
				linkedWorktrees,
			),
		).rejects.toThrow(/symlink/i);
	});
});

describe("Runner claim processing", () => {
	it("heartbeats, reports separate token usage, completes, and always cleans up", async () => {
		const api = {
			event: vi.fn(
				async (
					_runId: string,
					_runToken: string,
					_eventKey: string,
					_eventType: string,
					_metadata?: Record<string, unknown>,
				) => undefined,
			),
			heartbeat: vi.fn(async () => undefined),
			usage: vi.fn(async () => undefined),
			complete: vi.fn(async () => undefined),
			fail: vi.fn(async () => undefined),
		};
		const cleanup = vi.fn(async () => undefined);
		await processRunnerClaim(claim(), {
			api,
			prepare: vi.fn(async () => ({ cwd: "/tmp/worktree", cleanup })),
			analyze: vi.fn(async () => ({
				outputMarkdown: "No findings.",
				provider: "anthropic",
				model: "claude-sonnet",
				inputTokens: 100,
				outputTokens: 20,
			})),
		});

		expect(api.heartbeat).toHaveBeenCalledWith("run-1", "run-token", 90);
		expect(api.event.mock.calls.map((call) => call[2])).toEqual([
			"claimed",
			"pi-started",
			"analysis-metrics",
			"worktree-cleaned",
		]);
		expect(api.event.mock.calls.map((call) => call[3])).toEqual([
			"claimed",
			"pi_started",
			"analysis_completed",
			"worktree_cleaned",
		]);
		expect(api.usage).toHaveBeenCalledWith("run-1", "run-token", {
			event_key: "final",
			provider: "anthropic",
			model: "claude-sonnet",
			input_tokens: 100,
			output_tokens: 20,
		});
		expect(api.complete).toHaveBeenCalledWith(
			"run-1",
			"run-token",
			"No findings.",
		);
		expect(api.fail).not.toHaveBeenCalled();
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("surfaces cleanup failures instead of silently leaving a worktree", async () => {
		const api = {
			heartbeat: vi.fn(async () => undefined),
			usage: vi.fn(async () => undefined),
			complete: vi.fn(async () => undefined),
			fail: vi.fn(async () => undefined),
		};
		await expect(
			processRunnerClaim(claim(), {
				api,
				prepare: vi.fn(async () => ({
					cwd: "/tmp/worktree",
					cleanup: async () => {
						throw new Error("cleanup failed");
					},
				})),
				analyze: vi.fn(async () => ({
					outputMarkdown: "No findings.",
					provider: "anthropic",
					model: "claude-sonnet",
					inputTokens: 100,
					outputTokens: 20,
				})),
			}),
		).rejects.toThrow("cleanup failed");
		expect(api.complete).toHaveBeenCalledOnce();
	});
});
