/**
 * One shared-context graph build: stage the claimed commit's allowlisted
 * sources and index them in a supervised worker (own process group, no Runner
 * credential), then verify the artifact and hand it to `publish`.
 *
 * Failures reported to Takonaut are content-free codes. Lease loss and daemon
 * shutdown report nothing: the lease expires and the build is reclaimed.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphSourceError, stageGraphSources } from "./graph-sources";
import { startLeaseWatchdog } from "./lease-watchdog";
import {
	defaultRunnerConfigPaths,
	parseGraphClaim,
	type RunnerApiClient,
	type RunnerDaemonConfig,
	type RunnerGraphClaim,
	type RunnerGraphFailureCode,
} from "./runner";
import {
	RunnerSupervisionError,
	runSupervisedWorker,
} from "./runner-supervisor";
import {
	buildStructureArtifact,
	MAX_STRUCTURE_ARTIFACT_BYTES,
	StructureArtifactError,
} from "./structure-artifact";
import {
	createStructureIndexer,
	STRUCTURE_INDEXER_ID,
	StructureIndexError,
} from "./structure-index";

/**
 * The server refused the upload for good (not a lost lease or a temporary
 * failure): report this code instead of letting the build be rebuilt.
 */
export class GraphPublishRejected extends Error {
	constructor(readonly code: RunnerGraphFailureCode) {
		super(`Graph artifact upload refused: ${code}`);
		this.name = "GraphPublishRejected";
	}
}

/** Artifact file name inside a build's private work root. */
export const GRAPH_ARTIFACT_FILE = "artifact.json";

const RUNNER_CLI_PATH = fileURLToPath(
	new URL("./runner-cli.ts", import.meta.url),
);
/** Next to the Runner configuration (and its supervision stop marker). */
export function defaultGraphWorkRoot(): string {
	return join(dirname(defaultRunnerConfigPaths().configPath), "runner-graph");
}
const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60_000;
/** Exit code for a malformed worker request (EX_DATAERR). */
const WORKER_BAD_REQUEST = 65;

const LEASE_LOST = "Runner lease lost; graph build was stopped";
const SHUTTING_DOWN = "Runner shutting down; graph build was stopped";

const FAILURE_CODES: ReadonlySet<string> = new Set<RunnerGraphFailureCode>([
	"checkout_failed",
	"extractor_failed",
	"extractor_unavailable",
	"invalid_output",
	"isolation_failed",
	"output_too_large",
	"timeout",
]);
const SHA256 = /^[0-9a-f]{64}$/;
/** The claim `schema_version` this Runner's artifact format implements. */
export const GRAPH_SCHEMA_VERSION = 1;
/**
 * SHA-256 of the server's canonical structural-only extractor configuration
 * (`{"layers":["structural"],"semantic":false,"telemetry":false}`); the
 * backend test suite pins the same value.
 */
export const GRAPH_EXTRACTOR_CONFIG_HASH =
	"9fd4f6f6f2bfe77ec5b4632111fe32d9f64769330f0670304c90e0c72c124c54";
/** setTimeout's largest delay; longer ones fire immediately. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface GraphWorkerInput {
	claim: RunnerGraphClaim;
	repositoryRoot: string;
	/** Private directory for this build: staging and the artifact. */
	workRoot: string;
	artifactBudgetMs?: number;
}

export type GraphWorkerResult =
	| { ok: true; sha256: string; bytes: number }
	| { ok: false; code: RunnerGraphFailureCode };

/** The verified artifact bytes; what was checked is exactly what is sent. */
export interface GraphArtifact {
	bytes: Buffer;
	sha256: string;
}

export interface ProcessGraphClaimDeps {
	api: Pick<RunnerApiClient, "heartbeatGraphBuild" | "failGraphBuild">;
	/** Local clone for the claim's repository; throws when none is bound. */
	repositoryRoot(claim: RunnerGraphClaim): string;
	extract(
		input: GraphWorkerInput,
		signal: AbortSignal,
	): Promise<GraphWorkerResult>;
	/** Must stop when `signal` aborts (lease loss, shutdown or deadline). */
	publish(
		claim: RunnerGraphClaim,
		artifact: GraphArtifact,
		signal: AbortSignal,
	): Promise<void>;
}

export interface ProcessGraphClaimOptions {
	leaseSeconds?: number;
	/** Whole build, worker included; the worker is killed after it. */
	buildTimeoutMs?: number;
	maxArtifactBytes?: number;
	workRootBase?: string;
	signal?: AbortSignal;
	/** Called before any reporting when a worker may survive. */
	onTerminationUnconfirmed?: () => void;
}

/** A content-free code for a failure inside the worker. */
function failureCode(error: unknown): RunnerGraphFailureCode {
	if (
		error instanceof GraphSourceError ||
		error instanceof StructureArtifactError
	) {
		return error.code;
	}
	if (
		error instanceof StructureIndexError &&
		error.code === "extractor_unavailable"
	) {
		return "extractor_unavailable";
	}
	return "extractor_failed";
}

/** Shape check only: anything else from the worker is a failed extraction. */
function workerResult(value: unknown): GraphWorkerResult {
	const result = (value ?? {}) as Record<string, unknown>;
	if (
		result.ok === true &&
		typeof result.sha256 === "string" &&
		SHA256.test(result.sha256) &&
		Number.isSafeInteger(result.bytes) &&
		(result.bytes as number) >= 0
	) {
		return { ok: true, sha256: result.sha256, bytes: result.bytes as number };
	}
	if (
		result.ok === false &&
		typeof result.code === "string" &&
		FAILURE_CODES.has(result.code)
	) {
		return { ok: false, code: result.code as RunnerGraphFailureCode };
	}
	return { ok: false, code: "extractor_failed" };
}

/**
 * Reads the worker's artifact without following a symbolic link or blocking
 * on a FIFO, and never more than the limit plus one byte.
 */
function readArtifact(
	path: string,
	maxBytes: number,
): Buffer | "invalid_output" | "output_too_large" {
	let fd: number;
	try {
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch {
		return "invalid_output";
	}
	try {
		return readOpenArtifact(fd, maxBytes);
	} catch {
		return "invalid_output";
	} finally {
		closeSync(fd);
	}
}

function readOpenArtifact(
	fd: number,
	maxBytes: number,
): Buffer | "invalid_output" | "output_too_large" {
	const stat = fstatSync(fd);
	if (!stat.isFile()) return "invalid_output";
	if (stat.size > maxBytes) return "output_too_large";
	const buffer = Buffer.alloc(stat.size + 1);
	let length = 0;
	for (;;) {
		const read = readSync(fd, buffer, length, buffer.length - length, null);
		if (read === 0) break;
		length += read;
		if (length === buffer.length) return "output_too_large";
	}
	return buffer.subarray(0, length);
}

const positiveInteger = (
	value: number | undefined,
	max = Number.MAX_SAFE_INTEGER,
) =>
	value === undefined ||
	(Number.isSafeInteger(value) && value > 0 && value <= max);

export async function processGraphClaim(
	claim: RunnerGraphClaim,
	deps: ProcessGraphClaimDeps,
	options: ProcessGraphClaimOptions = {},
): Promise<"published" | RunnerGraphFailureCode> {
	if (
		!positiveInteger(options.leaseSeconds) ||
		!positiveInteger(options.buildTimeoutMs, MAX_TIMER_MS) ||
		!positiveInteger(options.maxArtifactBytes)
	) {
		throw new TypeError("Invalid graph build options");
	}
	const leaseSeconds = options.leaseSeconds ?? 90;
	const maxArtifactBytes =
		options.maxArtifactBytes ?? MAX_STRUCTURE_ARTIFACT_BYTES;
	const beat = async () => {
		const result = (await deps.api.heartbeatGraphBuild(
			claim,
			leaseSeconds,
		)) as { active?: unknown } | null;
		if (result?.active !== true) throw new Error("Graph build lease inactive");
	};
	const initialSentAt = Date.now();
	await beat();
	const watchdog = startLeaseWatchdog(
		beat,
		leaseSeconds,
		initialSentAt,
		LEASE_LOST,
	);
	// Lease loss, shutdown or the build deadline all stop the worker; the
	// first one decides the outcome.
	const stop = new AbortController();
	let stopCause: "lease" | "shutdown" | "deadline" | undefined;
	const halt = (cause: "lease" | "shutdown" | "deadline", reason: unknown) => {
		if (stopCause) return;
		stopCause = cause;
		stop.abort(reason);
	};
	const onLeaseLost = () => halt("lease", watchdog.signal.reason);
	const onShutdown = () => halt("shutdown", new Error(SHUTTING_DOWN));
	watchdog.signal.addEventListener("abort", onLeaseLost, { once: true });
	if (options.signal?.aborted) onShutdown();
	options.signal?.addEventListener("abort", onShutdown, { once: true });
	const deadline = setTimeout(
		() => halt("deadline", new Error("Graph build exceeded its time limit")),
		options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
	);
	// After lease loss or shutdown nothing is ever reported, whatever stopped
	// the build first: the lease expires and another Runner reclaims it.
	const fencedBy = (): unknown => {
		if (watchdog.signal.aborted) return watchdog.signal.reason;
		if (options.signal?.aborted) {
			return stopCause === "shutdown"
				? stop.signal.reason
				: new Error(SHUTTING_DOWN);
		}
		return undefined;
	};
	const fail = async (code: RunnerGraphFailureCode) => {
		const fence = fencedBy();
		if (fence !== undefined) throw fence;
		await deps.api.failGraphBuild(claim, code).catch(() => undefined);
		return code;
	};
	const stopped = async () => {
		if (stopCause === "deadline") return await fail("timeout");
		throw stop.signal.reason;
	};
	const base = options.workRootBase ?? defaultGraphWorkRoot();
	let workRoot: string | undefined;
	let terminationUnconfirmed = false;
	try {
		if (stopCause) return await stopped();
		// Build only what this Runner produces; never under another identity.
		if (
			claim.extractor !== STRUCTURE_INDEXER_ID ||
			claim.schema_version !== GRAPH_SCHEMA_VERSION ||
			claim.extractor_config_hash !== GRAPH_EXTRACTOR_CONFIG_HASH
		) {
			return await fail("extractor_unavailable");
		}
		let repositoryRoot: string;
		try {
			repositoryRoot = deps.repositoryRoot(claim);
		} catch {
			return await fail("checkout_failed");
		}
		mkdirSync(base, { recursive: true, mode: 0o700 });
		workRoot = mkdtempSync(join(base, "build-"));
		let result: GraphWorkerResult;
		try {
			result = workerResult(
				await deps.extract({ claim, repositoryRoot, workRoot }, stop.signal),
			);
		} catch (error) {
			if (error instanceof RunnerSupervisionError) {
				terminationUnconfirmed = true;
				options.onTerminationUnconfirmed?.();
				if (fencedBy() === undefined) {
					await deps.api
						.failGraphBuild(claim, "isolation_failed")
						.catch(() => undefined);
				}
				throw error;
			}
			if (stopCause) return await stopped();
			return await fail("extractor_failed");
		}
		if (stopCause) return await stopped();
		if (!result.ok) return await fail(result.code);
		const bytes = readArtifact(
			join(workRoot, GRAPH_ARTIFACT_FILE),
			maxArtifactBytes,
		);
		if (typeof bytes === "string") return await fail(bytes);
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (bytes.length !== result.bytes || digest !== result.sha256) {
			return await fail("invalid_output");
		}
		try {
			await deps.publish(claim, { bytes, sha256: digest }, stop.signal);
		} catch (error) {
			// An upload stopped by the deadline is a timeout like any other.
			if (stopCause) return await stopped();
			if (error instanceof GraphPublishRejected) return await fail(error.code);
			throw error;
		}
		return "published";
	} finally {
		clearTimeout(deadline);
		watchdog.stop();
		watchdog.signal.removeEventListener("abort", onLeaseLost);
		options.signal?.removeEventListener("abort", onShutdown);
		// A possibly surviving worker may still be writing in the work root.
		if (workRoot && !terminationUnconfirmed) {
			rmSync(workRoot, { recursive: true, force: true });
		}
	}
}

/**
 * The local clone for a graph claim: only an explicit repository binding for
 * the claimed repository in the claimed Project, never a Project-only
 * mapping (a Project may have several repositories).
 */
export function resolveGraphRepositoryRoot(
	config: RunnerDaemonConfig,
	claim: RunnerGraphClaim,
): string {
	const binding = config.repositoryBindings?.[claim.repository_id];
	if (!binding || binding.projectId !== claim.project_id) {
		throw new Error("No local repository is bound for this graph build");
	}
	return binding.path;
}

/** The Takonaut calls one daemon graph build makes. */
export type GraphBuildApi = Pick<
	RunnerApiClient,
	| "claimGraphBuild"
	| "heartbeatGraphBuild"
	| "failGraphBuild"
	| "uploadGraphArtifact"
>;

// While the server reports graph builds unavailable (feature off), claim
// again only after this, instead of failing on every poll.
const UNAVAILABLE_BACKOFF_MS = 10 * 60_000;
const unavailableUntil = new WeakMap<object, number>();

export interface RunGraphOnceOptions {
	signal?: AbortSignal;
	onTerminationUnconfirmed?: () => void;
	workRootBase?: string;
	/** Worker executable; defaults to this runtime. */
	workerCommand?: string;
	clock?: () => number;
}

/**
 * Claim and run at most one graph build. Returns whether there was work.
 * Build failures are reported to Takonaut by `processGraphClaim`; lease
 * loss, shutdown and unconfirmed termination propagate to the daemon.
 */
export async function runGraphOnce(
	config: RunnerDaemonConfig,
	api: GraphBuildApi,
	options: RunGraphOnceOptions = {},
): Promise<boolean> {
	const now = (options.clock ?? Date.now)();
	if ((unavailableUntil.get(api) ?? 0) > now) return false;
	let claim: RunnerGraphClaim | null;
	try {
		claim = await api.claimGraphBuild();
	} catch (error) {
		if (
			error instanceof Error &&
			/^Takonaut Runner API 404\b/.test(error.message)
		) {
			unavailableUntil.set(api, now + UNAVAILABLE_BACKOFF_MS);
			return false;
		}
		throw error;
	}
	if (!claim) return false;
	await processGraphClaim(
		claim,
		{
			api,
			repositoryRoot: (current) => resolveGraphRepositoryRoot(config, current),
			extract: (input, signal) =>
				runSupervisedGraphWorker(input, signal, {
					command: options.workerCommand,
				}),
			publish: async (current, artifact, signal) => {
				try {
					await api.uploadGraphArtifact(current, artifact, signal);
				} catch (error) {
					// A definitive refusal would repeat on every rebuild. A 409
					// (lease gone) or a temporary failure is left to the lease and
					// the server's attempt cap.
					const code = definitiveRefusal(error);
					if (code) throw new GraphPublishRejected(code);
					throw error;
				}
			},
		},
		{
			leaseSeconds: config.leaseSeconds,
			signal: options.signal,
			onTerminationUnconfirmed: options.onTerminationUnconfirmed,
			workRootBase: options.workRootBase,
		},
	);
	return true;
}

// Twice the build deadline: no live build is ever this old.
const STALE_WORK_ROOT_MS = 30 * 60_000;

/**
 * Remove `build-*` work roots left by a killed daemon (they hold staged
 * customer sources). Only old directories; links are never followed.
 * Call only when no supervision stop is set: a kept work root may still be
 * in use by a worker whose termination was not confirmed.
 */
export function sweepStaleGraphWorkRoots(
	base = defaultGraphWorkRoot(),
	options: { now?: number; olderThanMs?: number } = {},
): number {
	const cutoff =
		(options.now ?? Date.now()) - (options.olderThanMs ?? STALE_WORK_ROOT_MS);
	let names: string[];
	try {
		names = readdirSync(base);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		if (!name.startsWith("build-")) continue;
		const path = join(base, name);
		try {
			const stat = lstatSync(path);
			if (!stat.isDirectory() || stat.mtimeMs > cutoff) continue;
			rmSync(path, { recursive: true, force: true });
			removed += 1;
		} catch {
			// Gone already or not removable now; the next start tries again.
		}
	}
	return removed;
}

/** Count of stale work roots, for diagnostics (never their names). */
export function countStaleGraphWorkRoots(
	base = defaultGraphWorkRoot(),
	now = Date.now(),
): number {
	let names: string[];
	try {
		names = readdirSync(base);
	} catch {
		return 0;
	}
	return names.filter((name) => {
		if (!name.startsWith("build-")) return false;
		try {
			const stat = lstatSync(join(base, name));
			return stat.isDirectory() && stat.mtimeMs <= now - STALE_WORK_ROOT_MS;
		} catch {
			return false;
		}
	}).length;
}

function definitiveRefusal(error: unknown): RunnerGraphFailureCode | null {
	const status =
		error instanceof Error
			? /^Takonaut Runner API (\d{3})\b/.exec(error.message)?.[1]
			: undefined;
	if (status === "413") return "output_too_large";
	if (status === "422") return "invalid_output";
	return null;
}

/** Runs the graph worker in a separately killable process group. */
export async function runSupervisedGraphWorker(
	input: GraphWorkerInput,
	signal: AbortSignal,
	options: { command?: string } = {},
): Promise<GraphWorkerResult> {
	return workerResult(
		await runSupervisedWorker<unknown>({
			command: options.command ?? process.execPath,
			args: [RUNNER_CLI_PATH, "__graph-worker"],
			input,
			signal,
			label: "graph",
		}),
	);
}

function parseWorkerRequest(
	raw: string,
): { resultPath: string; input: GraphWorkerInput } | null {
	try {
		const { resultPath, input } = JSON.parse(raw) as Record<string, unknown>;
		const fields = (input ?? {}) as Record<string, unknown>;
		if (
			typeof resultPath !== "string" ||
			!isAbsolute(resultPath) ||
			typeof fields.repositoryRoot !== "string" ||
			!isAbsolute(fields.repositoryRoot) ||
			typeof fields.workRoot !== "string" ||
			!isAbsolute(fields.workRoot) ||
			(fields.artifactBudgetMs !== undefined &&
				!(
					Number.isSafeInteger(fields.artifactBudgetMs) &&
					(fields.artifactBudgetMs as number) > 0
				))
		) {
			return null;
		}
		return {
			resultPath,
			input: {
				claim: parseGraphClaim(fields.claim),
				repositoryRoot: fields.repositoryRoot,
				workRoot: fields.workRoot,
				artifactBudgetMs: fields.artifactBudgetMs as number | undefined,
			},
		};
	} catch {
		return null;
	}
}

async function buildInWorker({
	claim,
	repositoryRoot,
	workRoot,
	artifactBudgetMs,
}: GraphWorkerInput): Promise<GraphWorkerResult> {
	// One indexer (grammars loaded once) per worker process.
	const indexer = await createStructureIndexer();
	try {
		const stagingRoot = join(workRoot, "staging");
		const staged = await stageGraphSources({
			repositoryRoot,
			repository: {
				owner: claim.repository.owner,
				name: claim.repository.name,
				defaultBranch: claim.repository.default_branch,
			},
			commit: claim.commit_sha,
			allowlist: claim.path_allowlist,
			stagingRoot,
		});
		const built = await buildStructureArtifact({
			stagingRoot,
			staged,
			indexer,
			budgetMs: artifactBudgetMs,
		});
		writeFileSync(join(workRoot, GRAPH_ARTIFACT_FILE), built.json, {
			mode: 0o600,
			flag: "wx",
		});
		return {
			ok: true,
			sha256: built.sha256,
			bytes: Buffer.byteLength(built.json),
		};
	} finally {
		indexer.dispose();
	}
}

/**
 * Entry point of the supervised graph worker process: one request on stdin,
 * one result file; never the machine credential, never error text.
 */
export async function runGraphWorker(raw: string): Promise<number> {
	const request = parseWorkerRequest(raw);
	if (!request) {
		console.error("Invalid Runner graph worker request");
		return WORKER_BAD_REQUEST;
	}
	let result: GraphWorkerResult;
	try {
		result = await buildInWorker(request.input);
	} catch (error) {
		result = { ok: false, code: failureCode(error) };
	}
	writeFileSync(request.resultPath, JSON.stringify(result), {
		mode: 0o600,
		flag: "wx",
	});
	return 0;
}
