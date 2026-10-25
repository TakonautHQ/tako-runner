import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	GRAPH_ARTIFACT_FILE,
	GRAPH_EXTRACTOR_CONFIG_HASH,
	GraphPublishRejected,
	processGraphClaim,
	runGraphWorker,
	runSupervisedGraphWorker,
	type GraphWorkerInput,
	type GraphWorkerResult,
	type ProcessGraphClaimDeps,
} from "../src/graph-build";
import type { RunnerGraphClaim } from "../src/runner";
import { RunnerSupervisionError } from "../src/runner-supervisor";

// Local Git repositories and vendored grammars only: no network or AI runtime.
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const temp = (prefix: string) => {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
};
const sha256 = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");

function repository(files: Record<string, string>) {
	const root = temp("takonaut-graph-build-");
	const source = join(root, "source");
	const remote = join(root, "remote.git");
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
	execFileSync("git", ["init", "--quiet", "--bare", remote]);
	execFileSync("git", ["init", "--quiet", "-b", "main", source]);
	git("config", "user.name", "Runner Test");
	git("config", "user.email", "runner@test.invalid");
	git("config", "commit.gpgsign", "false");
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(source, path)), { recursive: true });
		writeFileSync(join(source, path), content);
	}
	git("add", "-A");
	git("commit", "--quiet", "-m", "first");
	git("remote", "add", "origin", "https://github.com/acme/widget.git");
	// Fetches go to a local bare repository, never the network.
	git(
		"config",
		`url.${remote}.insteadOf`,
		"https://github.com/acme/widget.git",
	);
	git("push", "--quiet", "origin", "HEAD:main");
	return { source, commit: git("rev-parse", "HEAD") };
}

function claim(overrides: Partial<RunnerGraphClaim> = {}): RunnerGraphClaim {
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
		extractor_config_hash: GRAPH_EXTRACTOR_CONFIG_HASH,
		schema_version: 1,
		...overrides,
	};
}

/** Records every call the build makes to Takonaut. */
function fakeApi(
	heartbeat: (beat: number) => Promise<unknown> = async () => ({
		active: true,
	}),
) {
	const calls: string[] = [];
	let beats = 0;
	return {
		calls,
		api: {
			heartbeatGraphBuild: async () => {
				calls.push("heartbeat");
				beats += 1;
				return heartbeat(beats);
			},
			failGraphBuild: async (_claim: RunnerGraphClaim, code: string) => {
				calls.push(`fail:${code}`);
				return null;
			},
		},
	};
}

function deps(
	overrides: Partial<ProcessGraphClaimDeps> & {
		api: ProcessGraphClaimDeps["api"];
	},
): ProcessGraphClaimDeps & { published: { json: string; sha256: string }[] } {
	const published: { json: string; sha256: string }[] = [];
	return {
		published,
		repositoryRoot: () => {
			throw new Error("No local repository is bound");
		},
		extract: (input, signal) =>
			runSupervisedGraphWorker(input, signal, { command: "bun" }),
		publish: async (_claim, artifact) => {
			published.push({
				json: artifact.bytes.toString("utf8"),
				sha256: artifact.sha256,
			});
		},
		...overrides,
	};
}

/** A stub worker that writes the given bytes and claims the given hash. */
const writes =
	(json: string, claimedHash = sha256(json)) =>
	async (input: GraphWorkerInput): Promise<GraphWorkerResult> => {
		writeFileSync(join(input.workRoot, GRAPH_ARTIFACT_FILE), json);
		return { ok: true, sha256: claimedHash, bytes: Buffer.byteLength(json) };
	};

describe("graph build", () => {
	it("stages, indexes and publishes one commit in a supervised worker", async () => {
		const { source, commit } = repository({
			"src/a.ts":
				'import { b } from "./b";\nexport function a() { return b(); }\n',
			"src/b.ts": "export function b() {}\n",
			"src/.env": "SECRET=1\n",
			"docs/x.md": "outside the allowlist\n",
		});
		const workRootBase = temp("takonaut-graph-work-");
		const { api, calls } = fakeApi();
		const current = claim({ commit_sha: commit });
		const build = deps({ api, repositoryRoot: () => source });
		const outcome = await processGraphClaim(current, build, {
			workRootBase,
		});
		expect(outcome).toBe("published");
		expect(calls.filter((call) => call.startsWith("fail"))).toEqual([]);
		expect(calls[0]).toBe("heartbeat");
		const [artifact] = build.published;
		if (!artifact) throw new Error("Nothing was published");
		expect(artifact.sha256).toBe(sha256(artifact.json));
		const parsed = JSON.parse(artifact.json);
		expect(parsed.commit).toBe(commit);
		expect(parsed.files.map((file: { path: string }) => file.path)).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
		expect(parsed.withheld).toEqual({ sensitive: 1, unsafe: 0 });
		expect(artifact.json).not.toContain(source);
		expect(artifact.json).not.toContain(workRootBase);
		// Staged sources and the artifact are removed afterwards.
		expect(readdirSync(workRootBase)).toEqual([]);
	});

	it("reports a content-free code when the commit cannot be staged", async () => {
		const { source } = repository({ "src/a.ts": "export const a = 1;\n" });
		const workRootBase = temp("takonaut-graph-work-");
		const { api, calls } = fakeApi();
		const build = deps({ api, repositoryRoot: () => source });
		const outcome = await processGraphClaim(
			claim({ commit_sha: "d".repeat(40) }),
			build,
			{ workRootBase },
		);
		expect(outcome).toBe("checkout_failed");
		expect(calls.at(-1)).toBe("fail:checkout_failed");
		expect(build.published).toEqual([]);
		expect(readdirSync(workRootBase)).toEqual([]);
	});

	it("refuses a repository with no local binding before starting a worker", async () => {
		const { api, calls } = fakeApi();
		let started = false;
		const build = deps({
			api,
			extract: async () => {
				started = true;
				return { ok: false, code: "extractor_failed" };
			},
		});
		const outcome = await processGraphClaim(claim(), build, {
			workRootBase: temp("takonaut-graph-work-"),
		});
		expect(outcome).toBe("checkout_failed");
		expect(started).toBe(false);
		expect(calls.at(-1)).toBe("fail:checkout_failed");
	});

	it("stops a build that outlives its deadline and reports a timeout", async () => {
		const { api, calls } = fakeApi();
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: (_input, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		});
		const outcome = await processGraphClaim(claim(), build, {
			workRootBase: temp("takonaut-graph-work-"),
			buildTimeoutMs: 50,
		});
		expect(outcome).toBe("timeout");
		expect(calls.at(-1)).toBe("fail:timeout");
		expect(build.published).toEqual([]);
	});

	it("never reports or publishes after the lease is lost", async () => {
		const { api, calls } = fakeApi(async (beat) => {
			if (beat > 1) throw new Error("Takonaut Runner API 409: lease_lost");
			return { active: true };
		});
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: (_input, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		});
		// Compare the message directly: under `bun test`, rejects.toThrow was
		// unreliable for errors carrying a `cause` once earlier tests had run.
		const error = await processGraphClaim(claim(), build, {
			workRootBase: temp("takonaut-graph-work-"),
			leaseSeconds: 3,
		}).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			"Runner lease lost; graph build was stopped",
		);
		expect(String((error as Error).cause)).toContain("409");
		expect(calls.every((call) => call === "heartbeat")).toBe(true);
		expect(build.published).toEqual([]);
	});

	it("does not start when the server says the lease is inactive", async () => {
		const { api, calls } = fakeApi(async () => ({ active: false }));
		let started = false;
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: async () => {
				started = true;
				return { ok: false, code: "extractor_failed" };
			},
		});
		await expect(
			processGraphClaim(claim(), build, {
				workRootBase: temp("takonaut-graph-work-"),
			}),
		).rejects.toThrow("Graph build lease inactive");
		expect(started).toBe(false);
		expect(calls).toEqual(["heartbeat"]);
	});

	it("does not report a build stopped by daemon shutdown", async () => {
		const { api, calls } = fakeApi();
		const shutdown = new AbortController();
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: (_input, signal) =>
				new Promise((_resolve, reject) => {
					setTimeout(() => shutdown.abort(new Error("shutdown")), 10);
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		});
		await expect(
			processGraphClaim(claim(), build, {
				workRootBase: temp("takonaut-graph-work-"),
				signal: shutdown.signal,
			}),
		).rejects.toThrow("Runner shutting down; graph build was stopped");
		expect(calls).toEqual(["heartbeat"]);
	});

	it("rejects an artifact whose bytes do not match the worker's hash", async () => {
		const { api, calls } = fakeApi();
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: writes('{"schema":"x"}', "e".repeat(64)),
		});
		const outcome = await processGraphClaim(claim(), build, {
			workRootBase: temp("takonaut-graph-work-"),
		});
		expect(outcome).toBe("invalid_output");
		expect(calls.at(-1)).toBe("fail:invalid_output");
		expect(build.published).toEqual([]);
	});

	it("rejects an artifact over the size limit before publishing", async () => {
		const { api, calls } = fakeApi();
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: writes(`{"pad":"${"x".repeat(200)}"}`),
		});
		const outcome = await processGraphClaim(claim(), build, {
			workRootBase: temp("takonaut-graph-work-"),
			maxArtifactBytes: 100,
		});
		expect(outcome).toBe("output_too_large");
		expect(calls.at(-1)).toBe("fail:output_too_large");
		expect(build.published).toEqual([]);
	});

	it("keeps the work root and stops the daemon when termination is unconfirmed", async () => {
		const { api, calls } = fakeApi();
		const workRootBase = temp("takonaut-graph-work-");
		let stopped = false;
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: async () => {
				throw new RunnerSupervisionError("unconfirmed");
			},
		});
		await expect(
			processGraphClaim(claim(), build, {
				workRootBase,
				onTerminationUnconfirmed: () => {
					stopped = true;
				},
			}),
		).rejects.toBeInstanceOf(RunnerSupervisionError);
		expect(stopped).toBe(true);
		expect(calls.at(-1)).toBe("fail:isolation_failed");
		// A surviving worker may still be writing there.
		expect(readdirSync(workRootBase)).toHaveLength(1);
	});
});

/** Settles with the rejection reason, or undefined if it resolved. */
const rejection = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(reason: unknown) => reason as Error,
	);

/** A stub worker that dies `afterMs` after being told to stop. */
const dyingWorker =
	(afterMs: number) =>
	(_input: GraphWorkerInput, signal: AbortSignal): Promise<GraphWorkerResult> =>
		new Promise((_resolve, reject) => {
			signal.addEventListener(
				"abort",
				() => setTimeout(() => reject(signal.reason), afterMs),
				{ once: true },
			);
		});

const leaseLostOnSecondBeat = async (beat: number) => {
	if (beat > 1) throw new Error("Takonaut Runner API 409: lease_lost");
	return { active: true };
};

describe("graph build stop precedence", () => {
	it("reports nothing when the deadline passes after the lease was lost", async () => {
		const { api, calls } = fakeApi(leaseLostOnSecondBeat);
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: dyingWorker(300),
		});
		const error = await rejection(
			processGraphClaim(claim(), build, {
				workRootBase: temp("takonaut-graph-work-"),
				leaseSeconds: 3,
				buildTimeoutMs: 1_150,
			}),
		);
		expect(error?.message).toBe("Runner lease lost; graph build was stopped");
		expect(calls.every((call) => call === "heartbeat")).toBe(true);
	});

	it("reports nothing when the lease is lost while a timed-out worker dies", async () => {
		const { api, calls } = fakeApi(leaseLostOnSecondBeat);
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: dyingWorker(1_300),
		});
		const error = await rejection(
			processGraphClaim(claim(), build, {
				workRootBase: temp("takonaut-graph-work-"),
				leaseSeconds: 3,
				buildTimeoutMs: 50,
			}),
		);
		expect(error?.message).toBe("Runner lease lost; graph build was stopped");
		expect(calls.every((call) => call === "heartbeat")).toBe(true);
	});

	it("reports nothing when the deadline passes after shutdown", async () => {
		const { api, calls } = fakeApi();
		const shutdown = new AbortController();
		setTimeout(() => shutdown.abort(), 10);
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: dyingWorker(100),
		});
		const error = await rejection(
			processGraphClaim(claim(), build, {
				workRootBase: temp("takonaut-graph-work-"),
				buildTimeoutMs: 50,
				signal: shutdown.signal,
			}),
		);
		expect(error?.message).toBe(
			"Runner shutting down; graph build was stopped",
		);
		expect(calls).toEqual(["heartbeat"]);
	});

	it("starts no worker when shutdown was already requested", async () => {
		const { api, calls } = fakeApi();
		let started = false;
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: async () => {
				started = true;
				return { ok: false, code: "extractor_failed" };
			},
		});
		const error = await rejection(
			processGraphClaim(claim(), build, {
				workRootBase: temp("takonaut-graph-work-"),
				signal: AbortSignal.abort(),
			}),
		);
		expect(error?.message).toBe(
			"Runner shutting down; graph build was stopped",
		);
		expect(started).toBe(false);
		expect(calls.some((call) => call.startsWith("fail"))).toBe(false);
	});

	it("never publishes a result that arrives after the lease was lost", async () => {
		const { api, calls } = fakeApi(leaseLostOnSecondBeat);
		const json = '{"ok":1}';
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: (input, signal) =>
				new Promise((resolve) => {
					signal.addEventListener("abort", () => resolve(writes(json)(input)), {
						once: true,
					});
				}),
		});
		const error = await rejection(
			processGraphClaim(claim(), build, {
				workRootBase: temp("takonaut-graph-work-"),
				leaseSeconds: 3,
			}),
		);
		expect(error?.message).toBe("Runner lease lost; graph build was stopped");
		expect(build.published).toEqual([]);
		expect(calls.every((call) => call === "heartbeat")).toBe(true);
	});

	it("tells an upload in progress when the lease is lost", async () => {
		const { api, calls } = fakeApi(leaseLostOnSecondBeat);
		let seen: unknown;
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: writes('{"ok":1}'),
			publish: (_claim, _artifact, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							seen = signal.reason;
							reject(signal.reason);
						},
						{ once: true },
					);
				}),
		});
		const error = await rejection(
			processGraphClaim(claim(), build, {
				workRootBase: temp("takonaut-graph-work-"),
				leaseSeconds: 3,
			}),
		);
		expect((seen as Error)?.message).toBe(
			"Runner lease lost; graph build was stopped",
		);
		expect(error).toBe(seen);
		expect(calls.every((call) => call === "heartbeat")).toBe(true);
	});

	it("does not report a supervision failure after the lease was lost", async () => {
		const { api, calls } = fakeApi(leaseLostOnSecondBeat);
		let stopped = false;
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: (_input, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => reject(new RunnerSupervisionError("unconfirmed")),
						{ once: true },
					);
				}),
		});
		const error = await rejection(
			processGraphClaim(claim(), build, {
				workRootBase: temp("takonaut-graph-work-"),
				leaseSeconds: 3,
				onTerminationUnconfirmed: () => {
					stopped = true;
				},
			}),
		);
		expect(error).toBeInstanceOf(RunnerSupervisionError);
		expect(stopped).toBe(true);
		expect(calls.every((call) => call === "heartbeat")).toBe(true);
	});
});

describe("graph build inputs", () => {
	it.each([
		["another extractor", { extractor: "graft-0.16.0" }],
		["another schema version", { schema_version: 2 }],
		[
			"another extractor configuration",
			{ extractor_config_hash: "b".repeat(64) },
		],
	])(
		"refuses a claim for %s before starting a worker",
		async (_label, overrides) => {
			const { api, calls } = fakeApi();
			let started = false;
			const build = deps({
				api,
				repositoryRoot: () => "/unused",
				extract: async () => {
					started = true;
					return { ok: false, code: "extractor_failed" };
				},
			});
			const outcome = await processGraphClaim(claim(overrides), build, {
				workRootBase: temp("takonaut-graph-work-"),
			});
			expect(outcome).toBe("extractor_unavailable");
			expect(started).toBe(false);
			expect(calls.at(-1)).toBe("fail:extractor_unavailable");
		},
	);

	it.each([
		["a NaN artifact limit", { maxArtifactBytes: Number.NaN }],
		["a zero deadline", { buildTimeoutMs: 0 }],
		["a fractional lease", { leaseSeconds: 1.5 }],
		["a deadline beyond the timer range", { buildTimeoutMs: 2 ** 31 }],
	])("rejects %s before contacting Takonaut", async (_label, options) => {
		const { api, calls } = fakeApi();
		await expect(
			processGraphClaim(claim(), deps({ api }), {
				workRootBase: temp("takonaut-graph-work-"),
				...options,
			}),
		).rejects.toThrow("Invalid graph build options");
		expect(calls).toEqual([]);
	});

	it("pins the server's structural configuration hash", () => {
		// sha256 of the server's canonical EXTRACTOR_CONFIG
		// {"layers":["structural"],"semantic":false,"telemetry":false};
		// backend/tests/services/test_project_context_builds.py pins the same.
		expect(GRAPH_EXTRACTOR_CONFIG_HASH).toBe(
			sha256('{"layers":["structural"],"semantic":false,"telemetry":false}'),
		);
	});

	it("publishes exactly the bytes it verified", async () => {
		const { api } = fakeApi();
		const json = '{"verified":true}';
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: writes(json),
		});
		const outcome = await processGraphClaim(claim(), build, {
			workRootBase: temp("takonaut-graph-work-"),
		});
		expect(outcome).toBe("published");
		expect(build.published).toEqual([{ json, sha256: sha256(json) }]);
	});

	it("refuses an artifact that is a FIFO without blocking", async () => {
		const { api, calls } = fakeApi();
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: async (input) => {
				execFileSync("mkfifo", [join(input.workRoot, GRAPH_ARTIFACT_FILE)]);
				return { ok: true, sha256: "a".repeat(64), bytes: 1 };
			},
		});
		const outcome = await processGraphClaim(claim(), build, {
			workRootBase: temp("takonaut-graph-work-"),
		});
		expect(outcome).toBe("invalid_output");
		expect(calls.at(-1)).toBe("fail:invalid_output");
	}, 10_000);

	it("reports a timeout when the deadline passes during upload", async () => {
		const { api, calls } = fakeApi();
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: writes('{"ok":1}'),
			publish: (_claim, _artifact, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		});
		const outcome = await processGraphClaim(claim(), build, {
			workRootBase: temp("takonaut-graph-work-"),
			buildTimeoutMs: 50,
		});
		expect(outcome).toBe("timeout");
		expect(calls.at(-1)).toBe("fail:timeout");
	});

	it("reports a refused upload with its code", async () => {
		const { api, calls } = fakeApi();
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: writes('{"ok":1}'),
			publish: async () => {
				throw new GraphPublishRejected("invalid_output");
			},
		});
		const outcome = await processGraphClaim(claim(), build, {
			workRootBase: temp("takonaut-graph-work-"),
		});
		expect(outcome).toBe("invalid_output");
		expect(calls.at(-1)).toBe("fail:invalid_output");
	});

	it("refuses an artifact that is a symbolic link", async () => {
		const secret = join(temp("takonaut-graph-secret-"), "secret.txt");
		writeFileSync(secret, "TAKONAUT_RUNNER_TOKEN=xyz");
		const { api, calls } = fakeApi();
		const build = deps({
			api,
			repositoryRoot: () => "/unused",
			extract: async (input) => {
				symlinkSync(secret, join(input.workRoot, GRAPH_ARTIFACT_FILE));
				return {
					ok: true,
					sha256: sha256(readFileSync(secret)),
					bytes: readFileSync(secret).length,
				};
			},
		});
		const outcome = await processGraphClaim(claim(), build, {
			workRootBase: temp("takonaut-graph-work-"),
		});
		expect(outcome).toBe("invalid_output");
		expect(calls.at(-1)).toBe("fail:invalid_output");
		expect(build.published).toEqual([]);
	});

	it.each([
		["a malformed success", { ok: true, sha256: "x", bytes: 1 }],
		["an unknown failure code", { ok: false, code: "rm -rf" }],
	])(
		"treats %s from the worker as a failed extraction",
		async (_label, result) => {
			const { api, calls } = fakeApi();
			const build = deps({
				api,
				repositoryRoot: () => "/unused",
				extract: async () => result as unknown as GraphWorkerResult,
			});
			const outcome = await processGraphClaim(claim(), build, {
				workRootBase: temp("takonaut-graph-work-"),
			});
			expect(outcome).toBe("extractor_failed");
			expect(calls.at(-1)).toBe("fail:extractor_failed");
		},
	);
});

describe("graph worker entry point", () => {
	it("rejects a malformed request without touching the result path", async () => {
		const resultPath = join(temp("takonaut-graph-worker-"), "result.json");
		expect(await runGraphWorker("not json")).toBe(65);
		expect(
			await runGraphWorker(
				JSON.stringify({
					resultPath,
					input: {
						claim: { build_id: "x" },
						repositoryRoot: "/r",
						workRoot: "/w",
					},
				}),
			),
		).toBe(65);
		expect(existsSync(resultPath)).toBe(false);
	});
});
