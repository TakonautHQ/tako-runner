import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	GRAPH_EXTRACTOR_CONFIG_HASH,
	resolveGraphRepositoryRoot,
	runGraphOnce,
	sweepStaleGraphWorkRoots,
} from "../src/graph-build";
import {
	type RunnerDaemonConfig,
	type RunnerGraphClaim,
	runRunnerDaemon,
	saveRunnerDaemonConfig,
} from "../src/runner";
import { RunnerSupervisionError } from "../src/runner-supervisor";

// Local Git repositories and an in-process fake API only.
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

function repository() {
	const root = temp("takonaut-graph-daemon-");
	const source = join(root, "source");
	const remote = join(root, "remote.git");
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
	execFileSync("git", ["init", "--quiet", "--bare", remote]);
	execFileSync("git", ["init", "--quiet", "-b", "main", source]);
	git("config", "user.name", "Runner Test");
	git("config", "user.email", "runner@test.invalid");
	git("config", "commit.gpgsign", "false");
	mkdirSync(join(source, "src"));
	writeFileSync(join(source, "src/a.ts"), "export function a() {}\n");
	git("add", "-A");
	git("commit", "--quiet", "-m", "first");
	git("remote", "add", "origin", "https://github.com/acme/widget.git");
	git(
		"config",
		`url.${remote}.insteadOf`,
		"https://github.com/acme/widget.git",
	);
	git("push", "--quiet", "origin", "HEAD:main");
	return { source, commit: git("rev-parse", "HEAD") };
}

const projectId = randomUUID();
const repositoryId = randomUUID();

function claim(commit: string): RunnerGraphClaim {
	return {
		build_id: randomUUID(),
		project_id: projectId,
		repository_id: repositoryId,
		repository: {
			id: repositoryId,
			owner: "acme",
			name: "widget",
			default_branch: "main",
		},
		commit_sha: commit,
		attempt_id: randomUUID(),
		lease_expires_at: new Date(Date.now() + 90_000).toISOString(),
		path_allowlist: ["src/**"],
		policy_revision: 1,
		access_epoch: 0,
		extractor: "tako-structure/1",
		extractor_config_hash: GRAPH_EXTRACTOR_CONFIG_HASH,
		schema_version: 1,
	};
}

function config(path = "/unbound"): RunnerDaemonConfig {
	return {
		serverUrl: "https://takonaut.test",
		organizationId: randomUUID(),
		credential: "tkr_machine",
		pollIntervalMs: 10,
		leaseSeconds: 60,
		repositories: { [projectId]: "/legacy/mapping" },
		repositoryBindings: { [repositoryId]: { projectId, path } },
	};
}

// These spawn a real Bun graph worker; slower under load (CI, containers).
const WORKER_TEST_TIMEOUT = 30_000;

describe("graph repository binding", () => {
	it("uses the explicit binding for the claimed repository and Project", () => {
		const current = claim("a".repeat(40));
		expect(resolveGraphRepositoryRoot(config("/repo"), current)).toBe("/repo");
	});

	it("refuses an unbound repository or another Project's binding", () => {
		const current = claim("a".repeat(40));
		expect(() =>
			resolveGraphRepositoryRoot(
				{ ...config(), repositoryBindings: {} },
				current,
			),
		).toThrow();
		expect(() =>
			resolveGraphRepositoryRoot(config(), {
				...current,
				project_id: randomUUID(),
			}),
		).toThrow();
		// The legacy Project-only mapping never stands in for a binding.
		expect(() =>
			resolveGraphRepositoryRoot(
				{ ...config(), repositoryBindings: undefined },
				current,
			),
		).toThrow();
	});
});

/** A fake Takonaut API for one graph claim. */
function fakeApi(next: () => Promise<RunnerGraphClaim | null>) {
	const calls: string[] = [];
	const uploads: { json: string; sha256: string }[] = [];
	const leases: number[] = [];
	return {
		calls,
		uploads,
		leases,
		api: {
			claimGraphBuild: async () => {
				calls.push("claim");
				return next();
			},
			heartbeatGraphBuild: async (_claim: unknown, lease?: number) => {
				calls.push("heartbeat");
				leases.push(lease ?? -1);
				return { active: true };
			},
			failGraphBuild: async (_claim: unknown, code: string) => {
				calls.push(`fail:${code}`);
				return null;
			},
			uploadGraphArtifact: async (
				_claim: unknown,
				artifact: { bytes: Uint8Array; sha256: string },
			) => {
				calls.push("upload");
				uploads.push({
					json: Buffer.from(artifact.bytes).toString("utf8"),
					sha256: artifact.sha256,
				});
				return { snapshot_id: randomUUID() };
			},
		},
	};
}

describe("one graph build from the daemon", () => {
	it(
		"claims, builds in the supervised worker and uploads",
		async () => {
			const { source, commit } = repository();
			const fake = fakeApi(async () => claim(commit));
			const worked = await runGraphOnce(config(source), fake.api, {
				workRootBase: temp("takonaut-graph-work-"),
				workerCommand: "bun",
			});
			expect(worked).toBe(true);
			expect(fake.calls.filter((call) => call.startsWith("fail"))).toEqual([]);
			expect(fake.calls.at(-1)).toBe("upload");
			const [upload] = fake.uploads;
			expect(JSON.parse(upload?.json ?? "{}").commit).toBe(commit);
			// The daemon's configured lease, not a default.
			expect(new Set(fake.leases)).toEqual(new Set([60]));
		},
		WORKER_TEST_TIMEOUT,
	);

	it("reports no work when there is no claim", async () => {
		const fake = fakeApi(async () => null);
		expect(await runGraphOnce(config(), fake.api)).toBe(false);
		expect(fake.calls).toEqual(["claim"]);
	});

	it("backs off while the server has graph builds turned off", async () => {
		const fake = fakeApi(async () => {
			throw new Error('Takonaut Runner API 404: {"detail":"Not found"}');
		});
		let now = 1_000_000;
		const clock = () => now;
		expect(await runGraphOnce(config(), fake.api, { clock })).toBe(false);
		expect(await runGraphOnce(config(), fake.api, { clock })).toBe(false);
		expect(fake.calls).toEqual(["claim"]);
		now += 11 * 60_000;
		expect(await runGraphOnce(config(), fake.api, { clock })).toBe(false);
		expect(fake.calls).toEqual(["claim", "claim"]);
	});

	it("passes other claim errors to the daemon", async () => {
		const fake = fakeApi(async () => {
			throw new Error("Takonaut Runner API 500: boom");
		});
		await expect(runGraphOnce(config(), fake.api)).rejects.toThrow("500");
	});
});

describe("upload refusals", () => {
	it.each([
		["422", "invalid_output"],
		["413", "output_too_large"],
	])(
		"reports a definitive %s refusal instead of rebuilding",
		async (status, code) => {
			const { source, commit } = repository();
			const fake = fakeApi(async () => claim(commit));
			fake.api.uploadGraphArtifact = async () => {
				throw new Error(`Takonaut Runner API ${status}: refused`);
			};
			expect(
				await runGraphOnce(config(source), fake.api, {
					workRootBase: temp("takonaut-graph-work-"),
					workerCommand: "bun",
				}),
			).toBe(true);
			expect(fake.calls.at(-1)).toBe(`fail:${code}`);
		},
		WORKER_TEST_TIMEOUT,
	);

	it.each(["409", "503"])(
		"leaves a %s upload failure to the lease and the server's attempt cap",
		async (status) => {
			const { source, commit } = repository();
			const fake = fakeApi(async () => claim(commit));
			fake.api.uploadGraphArtifact = async () => {
				throw new Error(`Takonaut Runner API ${status}: try later`);
			};
			await expect(
				runGraphOnce(config(source), fake.api, {
					workRootBase: temp("takonaut-graph-work-"),
					workerCommand: "bun",
				}),
			).rejects.toThrow(status);
			expect(fake.calls.some((call) => call.startsWith("fail"))).toBe(false);
		},
		WORKER_TEST_TIMEOUT,
	);
});

describe("stale graph work roots", () => {
	it("removes only old build directories", () => {
		const base = temp("takonaut-graph-sweep-");
		const now = Date.now();
		const old = new Date(now - 2 * 60 * 60_000);
		for (const name of ["build-old", "build-new", "other-old"]) {
			mkdirSync(join(base, name));
			writeFileSync(join(base, name, "artifact.json"), "{}");
		}
		utimesSync(join(base, "build-old"), old, old);
		utimesSync(join(base, "other-old"), old, old);
		const outside = temp("takonaut-graph-outside-");
		writeFileSync(join(outside, "keep.txt"), "keep");
		symlinkSync(outside, join(base, "build-link"));
		expect(sweepStaleGraphWorkRoots(base, { now })).toBe(1);
		expect(existsSync(join(base, "build-old"))).toBe(false);
		expect(existsSync(join(base, "build-new"))).toBe(true);
		expect(existsSync(join(base, "other-old"))).toBe(true);
		// A link is never followed.
		expect(existsSync(join(outside, "keep.txt"))).toBe(true);
	});

	it("tolerates a missing base directory", () => {
		expect(
			sweepStaleGraphWorkRoots(join(temp("takonaut-graph-none-"), "missing")),
		).toBe(0);
	});
});

describe("daemon dispatch", () => {
	const markerPath = () => join(temp("takonaut-graph-marker-"), "stop.json");
	// No bindings: the daemon would otherwise advertise them over the network.
	const daemonConfig = { ...config(), repositoryBindings: undefined };

	it("runs graph work only when there is no analysis work", async () => {
		const controller = new AbortController();
		const order: string[] = [];
		let analysisRuns = 0;
		await runRunnerDaemon(daemonConfig, {
			signal: controller.signal,
			stopMarkerPath: markerPath(),
			log: () => undefined,
			runOnce: async () => {
				analysisRuns += 1;
				order.push("analysis");
				// Work on the first poll, none on the second.
				return analysisRuns === 1;
			},
			runGraphOnce: async (_config, _api, options) => {
				order.push("graph");
				expect(options?.signal).toBe(controller.signal);
				controller.abort();
				return true;
			},
		});
		expect(order).toEqual(["analysis", "analysis", "graph"]);
	});

	it("writes the stop marker when a graph worker may survive", async () => {
		const marker = markerPath();
		await expect(
			runRunnerDaemon(daemonConfig, {
				stopMarkerPath: marker,
				log: () => undefined,
				runOnce: async () => false,
				runGraphOnce: async (_config, _api, options) => {
					options?.onTerminationUnconfirmed?.();
					throw new RunnerSupervisionError("unconfirmed");
				},
			}),
		).rejects.toThrow("unconfirmed");
		expect(JSON.parse(readFileSync(marker, "utf8")).reason).toBe(
			"Graph worker termination was not confirmed",
		);
	});

	it("sweeps stale work roots at start, after the stop check", async () => {
		const controller = new AbortController();
		let swept = 0;
		await runRunnerDaemon(daemonConfig, {
			signal: controller.signal,
			stopMarkerPath: markerPath(),
			log: () => undefined,
			runOnce: async () => {
				controller.abort();
				return true;
			},
			sweepGraphWorkRoots: () => {
				swept += 1;
				return 0;
			},
		});
		expect(swept).toBe(1);

		// A kept work root may still be in use after unconfirmed termination.
		const marker = markerPath();
		mkdirSync(dirname(marker), { recursive: true });
		writeFileSync(marker, "{}");
		let sweptWithMarker = 0;
		await expect(
			runRunnerDaemon(daemonConfig, {
				stopMarkerPath: marker,
				sweepGraphWorkRoots: () => {
					sweptWithMarker += 1;
					return 0;
				},
			}),
		).rejects.toThrow("Runner is stopped");
		expect(sweptWithMarker).toBe(0);
	});
});

describe("diagnostics", () => {
	it("reports how many stale graph work roots exist, never their names", () => {
		const root = temp("takonaut-graph-diagnostics-");
		const paths = {
			configPath: join(root, "runner.json"),
			credentialPath: join(root, "runner-credentials.json"),
		};
		saveRunnerDaemonConfig(
			{ ...config(), pollIntervalMs: 2_000, repositoryBindings: {} },
			paths,
		);
		// Work roots live next to the Runner configuration.
		const stale = join(root, "runner-graph", "build-secret-name");
		mkdirSync(stale, { recursive: true });
		const old = new Date(Date.now() - 2 * 60 * 60_000);
		utimesSync(stale, old, old);
		const output = join(root, "bundle.json");
		execFileSync(
			"bun",
			[
				fileURLToPath(new URL("../src/runner-cli.ts", import.meta.url)),
				"diagnostic-bundle",
				"--output",
				output,
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
		const bundle = readFileSync(output, "utf8");
		expect(JSON.parse(bundle).staleGraphWorkRoots).toBe(1);
		expect(bundle).not.toContain("secret-name");
	});
});

describe("once", () => {
	it("refuses to run while a supervision stop is set", () => {
		const root = temp("takonaut-graph-once-");
		const paths = {
			configPath: join(root, "runner.json"),
			credentialPath: join(root, "runner-credentials.json"),
		};
		saveRunnerDaemonConfig(
			{ ...config(), pollIntervalMs: 2_000, repositoryBindings: {} },
			paths,
		);
		writeFileSync(join(root, "runner-supervision-stop.json"), "{}");
		let failure: { status?: number; stderr?: string } = {};
		try {
			execFileSync(
				"bun",
				[
					fileURLToPath(new URL("../src/runner-cli.ts", import.meta.url)),
					"once",
				],
				{
					encoding: "utf8",
					stdio: "pipe",
					env: {
						...process.env,
						TAKONAUT_RUNNER_CONFIG: paths.configPath,
						TAKONAUT_RUNNER_CREDENTIALS: paths.credentialPath,
					},
				},
			);
		} catch (error) {
			failure = error as typeof failure;
		}
		expect(failure.status).toBe(1);
		expect(String(failure.stderr)).toContain("Runner is stopped");
	});
});
