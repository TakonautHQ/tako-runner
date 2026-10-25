import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { normalizeGitHubRemote } from "./git";
import { isSensitiveSegment } from "./runner-paths";

/**
 * Stage the exact allowlisted source files of one commit for structural
 * extraction. Contents come straight from Git objects (`cat-file`), so no
 * worktree is checked out and no repository-controlled hooks, filters or
 * attributes run. Only regular, UTF-8 text files within the allowlist and the
 * size limits reach the staging directory.
 */

/** Graph build failure codes this stage can produce (server vocabulary). */
export type GraphSourceFailure =
	| "checkout_failed"
	| "isolation_failed"
	| "output_too_large"
	| "timeout";

export class GraphSourceError extends Error {
	constructor(
		readonly code: GraphSourceFailure,
		message: string,
	) {
		super(message);
		this.name = "GraphSourceError";
	}
}

export interface GraphSourceLimits {
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
	/** Raw `ls-tree` output for the whole commit. */
	maxListingBytes: number;
}

export const DEFAULT_GRAPH_SOURCE_LIMITS: Readonly<GraphSourceLimits> =
	Object.freeze({
		maxFiles: 5_000,
		maxFileBytes: 512 * 1024,
		maxTotalBytes: 32 * 1024 * 1024,
		maxListingBytes: 64 * 1024 * 1024,
	});

// Paths beyond these are counted as unsafe without being examined: they bound
// matching and collision cost, and longer names may not be writable anyway.
const MAX_PATH_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;
const MAX_PATH_DEPTH = 64;

export interface StagedGraphFile {
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
}

export type GraphSkipReason =
	| "binary"
	| "name_collision"
	| "not_utf8"
	| "oversize"
	| "submodule"
	| "symlink";

export interface StagedGraphSources {
	readonly commit: string;
	readonly files: readonly StagedGraphFile[];
	readonly skipped: readonly { path: string; reason: GraphSkipReason }[];
	/** Sensitive or unsafe paths are counted, never named. */
	readonly sensitiveSkipped: number;
	/**
	 * Paths over the length, depth or segment caps, or not writable safely,
	 * across the whole commit (including outside the allowlist).
	 */
	readonly unsafeSkipped: number;
}

export interface StageGraphSourcesOptions {
	repositoryRoot: string;
	repository: { owner: string; name: string; defaultBranch: string };
	commit: string;
	allowlist: readonly string[];
	/** Must not exist yet; created with mode 0700. */
	stagingRoot: string;
	limits?: Partial<GraphSourceLimits>;
	/** Per Git command; fetches may take longer on large repositories. */
	timeoutMs?: number;
	/** Total time for scanning and matching the tree listing. */
	scanBudgetMs?: number;
}

const MAX_ALLOWLIST_ENTRIES = 50;
const MAX_ALLOWLIST_ENTRY_LENGTH = 200;
const COMMIT = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;
// Never run repository-local hooks, an fsmonitor command or background
// maintenance that could outlive the timeout.
const GIT_SAFETY = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"gc.auto=0",
	"-c",
	"maintenance.auto=false",
];

function hasControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/** Mirrors the server's consent rules: positive-only relative POSIX globs. */
export function checkGraphAllowlist(
	entries: readonly string[],
): readonly string[] {
	const valid =
		Array.isArray(entries) &&
		entries.length > 0 &&
		entries.length <= MAX_ALLOWLIST_ENTRIES &&
		entries.every(
			(entry) =>
				typeof entry === "string" &&
				entry.length > 0 &&
				// Code points, like the server.
				[...entry].length <= MAX_ALLOWLIST_ENTRY_LENGTH &&
				!hasControlCharacter(entry) &&
				!"!~/".includes(entry[0] ?? "") &&
				!entry.includes("\\") &&
				!entry.includes(":") &&
				entry
					.split("/")
					.every((part) => part !== "" && part !== "." && part !== ".."),
		);
	if (!valid) {
		throw new GraphSourceError(
			"checkout_failed",
			"Invalid graph path allowlist",
		);
	}
	// UTF-8 byte order equals code-point order, matching the server's sort.
	return Object.freeze(
		[...new Set(entries)].sort((left, right) =>
			Buffer.compare(Buffer.from(left), Buffer.from(right)),
		),
	);
}

/**
 * One segment with `*` (any run) and `?` (one code point). Greedy two-pointer
 * matching with a single backtrack point: O(pattern x name), never
 * exponential, unlike a backtracking regular expression.
 */
function matchSegment(
	pattern: readonly string[],
	name: readonly string[],
): boolean {
	let p = 0;
	let n = 0;
	let star = -1;
	let resume = 0;
	while (n < name.length) {
		// The wildcard test comes first: a literal '*' in a name must not
		// consume the pattern's '*' as if it were a plain character.
		if (p < pattern.length && pattern[p] === "*") {
			star = p;
			p += 1;
			resume = n;
		} else if (
			p < pattern.length &&
			(pattern[p] === "?" || pattern[p] === name[n])
		) {
			p += 1;
			n += 1;
		} else if (star >= 0) {
			p = star + 1;
			resume += 1;
			n = resume;
		} else {
			return false;
		}
	}
	while (p < pattern.length && pattern[p] === "*") p += 1;
	return p === pattern.length;
}

type CompiledPattern =
	| { kind: "subtree"; prefix: string }
	| { kind: "glob"; segments: readonly ("**" | readonly string[])[] };

function compilePattern(pattern: string): CompiledPattern {
	if (!/[*?]/.test(pattern)) return { kind: "subtree", prefix: pattern };
	const segments: ("**" | readonly string[])[] = [];
	for (const part of pattern.split("/")) {
		if (part === "**") {
			// Consecutive globstars are one globstar.
			if (segments.at(-1) !== "**") segments.push("**");
			continue;
		}
		// Runs of stars are one star.
		segments.push([...part.replace(/\*+/g, "*")]);
	}
	return { kind: "glob", segments };
}

function matchGlob(
	segments: readonly ("**" | readonly string[])[],
	path: readonly (readonly string[])[],
): boolean {
	// Memoized over (pattern segment, path segment): O(P x S) segment checks.
	const memo = new Map<number, boolean>();
	const visit = (s: number, p: number): boolean => {
		const key = s * (path.length + 1) + p;
		const cached = memo.get(key);
		if (cached !== undefined) return cached;
		let result: boolean;
		if (s === segments.length) {
			result = p === path.length;
		} else if (segments[s] === "**") {
			result = visit(s + 1, p) || (p < path.length && visit(s, p + 1));
		} else {
			const segment = segments[s] as readonly string[];
			result =
				p < path.length &&
				matchSegment(segment, path[p] ?? []) &&
				visit(s + 1, p + 1);
		}
		memo.set(key, result);
		return result;
	};
	return visit(0, 0);
}

export interface GraphPathMatcher {
	matches(path: string): boolean;
}

/**
 * Glob grammar: `**` is any number of whole path segments, `*` is any run of
 * characters within one segment, `?` is one such character; everything else
 * is literal. A pattern without wildcards matches that path and everything
 * below it. Compile once per build; matching cost is bounded per path.
 */
export function compileGraphAllowlist(
	entries: readonly string[],
): GraphPathMatcher {
	const patterns = checkGraphAllowlist(entries).map(compilePattern);
	return {
		matches(path: string): boolean {
			let split: (readonly string[])[] | undefined;
			return patterns.some((pattern) => {
				if (pattern.kind === "subtree") {
					return (
						path === pattern.prefix || path.startsWith(`${pattern.prefix}/`)
					);
				}
				split ??= path.split("/").map((segment) => [...segment]);
				return matchGlob(pattern.segments, split);
			});
		},
	};
}

/** Convenience for a single check; prefer compiling once. */
export function matchesGraphAllowlist(
	path: string,
	patterns: readonly string[],
): boolean {
	return compileGraphAllowlist(patterns).matches(path);
}

function safeRelativePath(path: string): boolean {
	return (
		path.length > 0 &&
		!hasControlCharacter(path) &&
		!path.includes("\\") &&
		path
			.split("/")
			.every((part) => part !== "" && part !== "." && part !== "..")
	);
}

function git(
	cwd: string,
	args: string[],
	timeoutMs: number,
	encoding: "utf8" | "buffer" = "utf8",
	maxBuffer = 64 * 1024 * 1024,
): Promise<string | Buffer> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			"git",
			[...GIT_SAFETY, ...args],
			{
				cwd,
				encoding,
				timeout: timeoutMs,
				killSignal: "SIGKILL",
				maxBuffer,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			},
			(error, stdout) => {
				if (error) {
					const failure = error as { killed?: boolean; code?: unknown };
					if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
						reject(
							new GraphSourceError("output_too_large", "Git output too large"),
						);
					} else if (failure.killed === true) {
						reject(new GraphSourceError("timeout", "Git command timed out"));
					} else {
						reject(
							new GraphSourceError("checkout_failed", `git ${args[0]} failed`),
						);
					}
					return;
				}
				resolvePromise(stdout);
			},
		);
	});
}

async function commitExists(
	root: string,
	commit: string,
	timeoutMs: number,
): Promise<boolean> {
	try {
		await git(root, ["cat-file", "-e", `${commit}^{commit}`], timeoutMs);
		return true;
	} catch (error) {
		if (error instanceof GraphSourceError && error.code === "timeout")
			throw error;
		return false;
	}
}

/** Read many blobs in one `cat-file --batch` call; returns them in order. */
function readBlobs(
	root: string,
	objects: readonly string[],
	expectedBytes: number,
	timeoutMs: number,
): Promise<Buffer[]> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", [...GIT_SAFETY, "cat-file", "--batch"], {
			cwd: root,
			stdio: ["pipe", "pipe", "ignore"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		const limit = expectedBytes + objects.length * 128;
		const chunks: Buffer[] = [];
		let received = 0;
		let failure: GraphSourceError | undefined;
		const timer = setTimeout(() => {
			failure = new GraphSourceError("timeout", "Git command timed out");
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			received += chunk.length;
			if (received > limit) {
				failure ??= new GraphSourceError(
					"output_too_large",
					"Git returned more data than expected",
				);
				child.kill("SIGKILL");
				return;
			}
			chunks.push(chunk);
		});
		child.on("error", () => {
			failure ??= new GraphSourceError(
				"checkout_failed",
				"git cat-file failed",
			);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (failure) return reject(failure);
			if (code !== 0) {
				return reject(
					new GraphSourceError("checkout_failed", "git cat-file failed"),
				);
			}
			const output = Buffer.concat(chunks);
			const blobs: Buffer[] = [];
			let offset = 0;
			for (const object of objects) {
				const newline = output.indexOf(0x0a, offset);
				const header = output.subarray(offset, newline).toString("utf8");
				const [name, type, sizeText] = header.split(" ");
				const size = Number(sizeText);
				if (
					newline < 0 ||
					name !== object ||
					type !== "blob" ||
					!Number.isSafeInteger(size)
				) {
					return reject(
						new GraphSourceError("checkout_failed", "Unexpected git object"),
					);
				}
				blobs.push(output.subarray(newline + 1, newline + 1 + size));
				offset = newline + 1 + size + 1;
			}
			resolvePromise(blobs);
		});
		child.stdin.on("error", () => undefined);
		child.stdin.end(`${objects.join("\n")}\n`);
	});
}

function byteOrder(left: { path: string }, right: { path: string }): number {
	return Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
}

/** Defaults for omitted or explicitly undefined limits; rejects the rest. */
function resolveLimits(
	overrides: Partial<GraphSourceLimits> = {},
): GraphSourceLimits {
	const limits = { ...DEFAULT_GRAPH_SOURCE_LIMITS };
	for (const name of Object.keys(limits) as (keyof GraphSourceLimits)[]) {
		const value = overrides[name];
		if (value === undefined) continue;
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new TypeError("Invalid graph source limits");
		}
		limits[name] = value;
	}
	return limits;
}

export async function stageGraphSources(
	options: StageGraphSourcesOptions,
): Promise<StagedGraphSources> {
	const { commit, repository } = options;
	if (
		typeof commit !== "string" ||
		!COMMIT.test(commit) ||
		commit.length !== 40
	) {
		throw new GraphSourceError("checkout_failed", "Invalid graph build commit");
	}
	if (
		!BRANCH.test(repository.defaultBranch) ||
		repository.defaultBranch.split("/").includes("..")
	) {
		throw new GraphSourceError("checkout_failed", "Invalid default branch");
	}
	const matcher = compileGraphAllowlist(options.allowlist);
	const limits = resolveLimits(options.limits);
	const timeoutMs = options.timeoutMs ?? 120_000;
	const stagingRoot = resolve(options.stagingRoot);
	if (existsSync(stagingRoot)) {
		throw new GraphSourceError(
			"isolation_failed",
			"Graph staging directory already exists",
		);
	}

	let root: string;
	try {
		root = realpathSync(options.repositoryRoot);
	} catch {
		throw new GraphSourceError(
			"checkout_failed",
			"Repository root is unavailable",
		);
	}
	if (root.split(sep).filter(Boolean).some(isSensitiveSegment)) {
		throw new GraphSourceError(
			"checkout_failed",
			"Repository root is sensitive",
		);
	}
	const topLevel = String(
		await git(root, ["rev-parse", "--show-toplevel"], timeoutMs),
	).trim();
	if (realpathSync(topLevel) !== root) {
		throw new GraphSourceError(
			"checkout_failed",
			"Repository root is not the Git top level",
		);
	}
	// Exactly one origin URL: fetch uses the first, a check of the last
	// would verify a different repository.
	const remotes = String(
		await git(root, ["config", "--get-all", "remote.origin.url"], timeoutMs),
	)
		.split("\n")
		.filter(Boolean);
	const expected = `github.com/${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
	if (
		remotes.length !== 1 ||
		normalizeGitHubRemote(remotes[0] ?? "") !== expected
	) {
		throw new GraphSourceError(
			"checkout_failed",
			"Repository remote does not match",
		);
	}
	if (!(await commitExists(root, commit, timeoutMs))) {
		const branch = repository.defaultBranch;
		await git(
			root,
			[
				"fetch",
				"--no-tags",
				"--no-recurse-submodules",
				"--no-write-fetch-head",
				"origin",
				`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
			],
			timeoutMs,
		);
		if (!(await commitExists(root, commit, timeoutMs))) {
			throw new GraphSourceError("checkout_failed", "Commit is not available");
		}
	}

	const listing = (await git(
		root,
		["ls-tree", "-r", "-z", "-l", "--full-tree", commit],
		timeoutMs,
		"buffer",
		limits.maxListingBytes,
	)) as Buffer;
	const pathDecoder = new TextDecoder("utf-8", { fatal: true });
	const candidates: { path: string; object: string; size: number }[] = [];
	const skipped: { path: string; reason: GraphSkipReason }[] = [];
	let sensitiveSkipped = 0;
	let unsafeSkipped = 0;
	// Matching is synchronous: bound its total time, not only each path.
	const scanDeadline = performance.now() + (options.scanBudgetMs ?? 30_000);
	let records = 0;
	let start = 0;
	while (start < listing.length) {
		if (records % 256 === 0 && performance.now() >= scanDeadline) {
			throw new GraphSourceError(
				"timeout",
				"Scanning the tree listing exceeded its time budget",
			);
		}
		records += 1;
		let end = listing.indexOf(0, start);
		if (end < 0) end = listing.length;
		const record = listing.subarray(start, end);
		start = end + 1;
		const tab = record.indexOf(0x09);
		if (tab < 0) continue;
		const [mode, type, object, sizeText] = record
			.subarray(0, tab)
			.toString("latin1")
			.split(" ")
			.filter(Boolean);
		const rawPath = record.subarray(tab + 1);
		let depth = 1;
		let segmentStart = 0;
		let oversizedSegment = false;
		for (let index = 0; index <= rawPath.length; index += 1) {
			if (index === rawPath.length || rawPath[index] === 0x2f) {
				if (index - segmentStart > MAX_SEGMENT_BYTES) oversizedSegment = true;
				if (index < rawPath.length) depth += 1;
				segmentStart = index + 1;
			}
		}
		if (
			rawPath.length > MAX_PATH_BYTES ||
			depth > MAX_PATH_DEPTH ||
			oversizedSegment
		) {
			unsafeSkipped += 1;
			continue;
		}
		let path: string;
		try {
			path = pathDecoder.decode(rawPath);
		} catch {
			// Not valid UTF-8: a lossy name could alias another path.
			if (matcher.matches(rawPath.toString("utf8"))) unsafeSkipped += 1;
			continue;
		}
		if (!safeRelativePath(path)) {
			if (matcher.matches(path)) unsafeSkipped += 1;
			continue;
		}
		if (!matcher.matches(path)) continue;
		if (path.split("/").some(isSensitiveSegment)) {
			sensitiveSkipped += 1;
			continue;
		}
		if (mode === "120000") {
			skipped.push({ path, reason: "symlink" });
			continue;
		}
		if (type === "commit") {
			skipped.push({ path, reason: "submodule" });
			continue;
		}
		if (type !== "blob" || !object) continue;
		const size = Number(sizeText);
		if (!Number.isSafeInteger(size) || size > limits.maxFileBytes) {
			skipped.push({ path, reason: "oversize" });
			continue;
		}
		candidates.push({ path, object, size });
	}
	const totalBytes = candidates.reduce((sum, file) => sum + file.size, 0);
	if (
		candidates.length > limits.maxFiles ||
		totalBytes > limits.maxTotalBytes
	) {
		throw new GraphSourceError(
			"output_too_large",
			"Allowlisted sources exceed the graph limits",
		);
	}

	// Names that coincide on a case- or normalization-insensitive filesystem
	// (the macOS default) cannot both be staged faithfully; skip them all.
	// One trie node per (parent, folded segment): linear in total segments.
	const fold = (value: string) =>
		value
			.normalize("NFD")
			.toLowerCase()
			.toUpperCase()
			.toLowerCase()
			.normalize("NFD");
	const nodes = new Map<string, { id: number; originals: Set<string> }>();
	const walks = candidates.map((file) => {
		let parent = 0;
		return file.path.split("/").map((segment) => {
			const key = `${parent}\0${fold(segment)}`;
			let node = nodes.get(key);
			if (!node) {
				node = { id: nodes.size + 1, originals: new Set() };
				nodes.set(key, node);
			}
			node.originals.add(segment);
			parent = node.id;
			return node;
		});
	});
	const staging = candidates.filter((file, index) => {
		if (!(walks[index] ?? []).some((node) => node.originals.size > 1))
			return true;
		skipped.push({ path: file.path, reason: "name_collision" });
		return false;
	});
	candidates.length = 0;
	candidates.push(...staging);

	const blobs =
		candidates.length === 0
			? []
			: await readBlobs(
					root,
					candidates.map((file) => file.object),
					candidates.reduce((sum, file) => sum + file.size, 0),
					timeoutMs,
				);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const files: StagedGraphFile[] = [];
	try {
		mkdirSync(stagingRoot, { mode: 0o700 });
	} catch {
		throw new GraphSourceError(
			"isolation_failed",
			"Could not create graph staging directory",
		);
	}
	try {
		candidates.forEach((file, index) => {
			const bytes = blobs[index] ?? Buffer.alloc(0);
			if (bytes.includes(0)) {
				skipped.push({ path: file.path, reason: "binary" });
				return;
			}
			try {
				decoder.decode(bytes);
			} catch {
				skipped.push({ path: file.path, reason: "not_utf8" });
				return;
			}
			const target = join(stagingRoot, ...file.path.split("/"));
			try {
				mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
				writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
			} catch (error) {
				// A collision the fold did not predict: skip, never overwrite.
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "EEXIST" || code === "ENOTDIR") {
					skipped.push({ path: file.path, reason: "name_collision" });
					return;
				}
				// Within the relative cap but beyond the OS limit once the
				// staging root is prefixed (PATH_MAX is 1024 on macOS).
				if (code === "ENAMETOOLONG") {
					unsafeSkipped += 1;
					return;
				}
				throw error;
			}
			files.push({
				path: file.path,
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			});
		});
	} catch {
		rmSync(stagingRoot, { recursive: true, force: true });
		throw new GraphSourceError(
			"isolation_failed",
			"Could not write graph staging",
		);
	}
	return Object.freeze({
		commit,
		files: Object.freeze(files.sort(byteOrder)),
		skipped: Object.freeze(skipped.sort(byteOrder)),
		sensitiveSkipped,
		unsafeSkipped,
	});
}
