/**
 * Build one commit's structure artifact from staged sources: files, symbols
 * with stable IDs and body hashes, resolved edges, unresolved references with
 * reasons, and per-file coverage. Deterministic canonical JSON plus SHA-256.
 *
 * Resolution is syntactic and conservative. A plain name links only to a
 * unique candidate in the same language family, same file first, unless a
 * parameter or another same-file definition shadows it. `this`/`self` calls
 * link only to a method of the enclosing class; other receivers never link.
 * Everything else is recorded as unresolved with a reason.
 *
 * Output is bounded: nesting depth, qualified-name length, symbols and
 * references per file and per snapshot are capped, and a file over a cap is
 * marked partial or skipped instead of failing the snapshot.
 *
 * Edges and unresolved references are tuples over node positions: position
 * `i < files.length` is `files[i]`, otherwise `symbols[i - files.length]`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { StagedGraphSources } from "./graph-sources";
import { isSensitiveSegment } from "./runner-paths";
import {
	STRUCTURE_INDEXER_ID,
	StructureIndexError,
	type StructureIndexer,
	type StructureLanguage,
	type StructureReference,
	type StructureSymbol,
	languageForPath,
} from "./structure-index";

export const STRUCTURE_ARTIFACT_SCHEMA = "takonaut-structure-artifact/v1";
const DEFAULT_BUDGET_MS = 120_000;
/** Uncompressed canonical JSON; twice the staging input limit. */
export const MAX_STRUCTURE_ARTIFACT_BYTES = 64 * 1024 * 1024;

export class StructureArtifactError extends Error {
	constructor(
		readonly code: "invalid_output" | "output_too_large",
		message: string,
	) {
		super(message);
		this.name = "StructureArtifactError";
	}
}

export interface StructureArtifactLimits {
	/** Nested definitions kept per chain; deeper ones are dropped. */
	maxDepth: number;
	maxQualifiedNameBytes: number;
	maxFileSymbols: number;
	maxFileReferences: number;
	maxSnapshotSymbols: number;
	maxSnapshotReferences: number;
	/** Estimated output bytes for symbols and references (an upper bound). */
	maxSnapshotBytes: number;
}
export type StructureArtifactLimitsInput = Partial<StructureArtifactLimits>;

// The byte budget keeps a capped snapshot under MAX_STRUCTURE_ARTIFACT_BYTES,
// with room for file and coverage entries.
export const DEFAULT_STRUCTURE_ARTIFACT_LIMITS: Readonly<StructureArtifactLimits> =
	Object.freeze({
		maxDepth: 32,
		maxQualifiedNameBytes: 512,
		maxFileSymbols: 5_000,
		maxFileReferences: 20_000,
		maxSnapshotSymbols: 100_000,
		maxSnapshotReferences: 600_000,
		maxSnapshotBytes: 48 * 1024 * 1024,
	});

/** References with longer names are skipped (identifiers, not prose). */
const MAX_REFERENCE_NAME_BYTES = 256;
// Upper bounds on serialized size: a symbol with its containment edge, a
// reference as an edge or unresolved entry, and a file with its coverage.
const SYMBOL_BYTES = 360;
const REFERENCE_BYTES = 64;
const FILE_BYTES = 300;

export type CoverageState = "indexed" | "partial" | "skipped" | "error";
export type EdgeKind =
	| "contains"
	| "imports"
	| "calls"
	| "constructs"
	| "references_type";
export type EdgeResolution =
	| "structural"
	| "module_path"
	/** The only candidate in the same file. */
	| "same_file"
	/** `this.f()`/`self.f()` to the enclosing class's only method `f`. */
	| "same_class"
	/** The only candidate in the snapshot; name-only, not scope-checked. */
	| "unique_name";
export type UnresolvedReason =
	| "not_found"
	| "ambiguous"
	/** A non-relative import that matched no staged file. */
	| "non_relative"
	/** A method call whose receiver's type is unknown (`x.f()`). */
	| "receiver_unknown"
	/** A parameter or another same-file definition binds the name. */
	| "shadowed";

/** [kind, source node, target node, resolution] */
export type StructureEdgeTuple = [EdgeKind, number, number, EdgeResolution];
/**
 * [kind, source node, name, reason]. The name is the called or referenced
 * name; for imports only a package-like specifier, otherwise null (paths and
 * URLs are never shared).
 */
export type StructureUnresolvedTuple = [
	Exclude<EdgeKind, "contains">,
	number,
	string | null,
	UnresolvedReason,
];

export interface StructureArtifact {
	schema: typeof STRUCTURE_ARTIFACT_SCHEMA;
	indexer: typeof STRUCTURE_INDEXER_ID;
	commit: string;
	files: {
		id: string;
		path: string;
		language: StructureLanguage;
		size: number;
		sha256: string;
	}[];
	symbols: {
		id: string;
		/** Position in `files`. */
		file: number;
		kind: string;
		name: string;
		/** Enclosing definitions' names and this one, joined by ".". */
		qualifiedName: string;
		startLine: number;
		endLine: number;
		startByte: number;
		endByte: number;
		/**
		 * SHA-256 of the file bytes [startByte, endByte): the definition itself.
		 * `export` modifiers and decorators are outside it. Null for constants,
		 * whose short values could be confirmed by guessing.
		 */
		sha256: string | null;
	}[];
	edges: StructureEdgeTuple[];
	unresolved: StructureUnresolvedTuple[];
	coverage: { path: string; state: CoverageState; reason: string }[];
	/** Paths the staging step counted but never named. */
	withheld: { sensitive: number; unsafe: number };
}

const nodeId = (artifact: StructureArtifact, node: number) =>
	node < artifact.files.length
		? artifact.files[node]?.id
		: artifact.symbols[node - artifact.files.length]?.id;

/** Edges with node IDs, for readers that do not need the compact form. */
export function structureEdges(artifact: StructureArtifact): {
	kind: EdgeKind;
	source: string | undefined;
	target: string | undefined;
	resolution: EdgeResolution;
}[] {
	return artifact.edges.map(([kind, source, target, resolution]) => ({
		kind,
		source: nodeId(artifact, source),
		target: nodeId(artifact, target),
		resolution,
	}));
}

/** Unresolved references with node IDs. */
export function structureUnresolved(artifact: StructureArtifact): {
	kind: StructureUnresolvedTuple[0];
	source: string | undefined;
	name: string | null;
	reason: UnresolvedReason;
}[] {
	return artifact.unresolved.map(([kind, source, name, reason]) => ({
		kind,
		source: nodeId(artifact, source),
		name,
		reason,
	}));
}

export interface BuildStructureArtifactOptions {
	/** Staging directory; files are read only by their manifest path. */
	stagingRoot: string;
	staged: StagedGraphSources;
	indexer: StructureIndexer;
	/** Extraction time for the whole snapshot. */
	budgetMs?: number;
	maxArtifactBytes?: number;
	limits?: StructureArtifactLimitsInput;
}

const sha256 = (value: string | Uint8Array) =>
	createHash("sha256").update(value).digest("hex");

const byteOrder = (left: string, right: string) =>
	Buffer.compare(Buffer.from(left), Buffer.from(right));

const fileId = (path: string) =>
	sha256(`${STRUCTURE_INDEXER_ID}\0file\0${path}`);

/**
 * Stable across edits elsewhere in the file and across same-named members of
 * other containers; the ordinal only separates true repeats in one container
 * (getter/setter pairs, overloads, functions in anonymous callbacks).
 */
const symbolId = (
	path: string,
	kind: string,
	qualifiedName: string,
	ordinal: number,
) =>
	sha256(
		`${STRUCTURE_INDEXER_ID}\0symbol\0${path}\0${kind}\0${qualifiedName}\0${ordinal}`,
	);

function resolveLimits(
	overrides: StructureArtifactLimitsInput = {},
): StructureArtifactLimits {
	const limits = { ...DEFAULT_STRUCTURE_ARTIFACT_LIMITS };
	for (const name of Object.keys(limits) as (keyof StructureArtifactLimits)[]) {
		const value = overrides[name];
		if (value === undefined) continue;
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new TypeError("Invalid structure artifact limits");
		}
		limits[name] = value;
	}
	return limits;
}

type ReferenceRule = "call" | "class" | "type";

/** Edge kind and target symbol kinds for plain-name references. */
const REFERENCE_RULES: Readonly<
	Record<
		ReferenceRule,
		{
			edge: Exclude<EdgeKind, "contains" | "imports">;
			targets: ReadonlySet<string>;
		}
	>
> = {
	// A plain call never targets a method.
	call: { edge: "calls", targets: new Set(["function", "class"]) },
	class: { edge: "constructs", targets: new Set(["class"]) },
	type: {
		edge: "references_type",
		targets: new Set(["interface", "type", "class", "enum"]),
	},
};

/** Names resolve only within one language family. */
const languageFamily = (language: StructureLanguage | null) =>
	language === "python" ? "python" : "script";

// Package or module names only: never a path, URL or credential.
const SCRIPT_PACKAGE =
	/^(?:node:)?(?:@[A-Za-z0-9_-][A-Za-z0-9._-]*\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const PYTHON_MODULE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const MAX_IMPORT_NAME = 214;

function shareableImportName(
	language: StructureLanguage | null,
	specifier: string,
): string | null {
	const python = language === "python";
	if (
		specifier.length > MAX_IMPORT_NAME ||
		!(python ? PYTHON_MODULE : SCRIPT_PACKAGE).test(specifier)
	) {
		return null;
	}
	const segments = specifier
		.replace(/^node:/, "")
		.replace(/^@/, "")
		.split(python ? "." : "/");
	return segments.some(isSensitiveSegment) ? null : specifier;
}

const JS_EXTENSIONS = [
	".ts",
	".tsx",
	".mts",
	".cts",
	".d.ts",
	".js",
	".jsx",
	".mjs",
	".cjs",
];

/** Relative JS/TS specifiers only; the TS `.js` -> `.ts` convention applies. */
function resolveScriptImport(
	from: string,
	specifier: string,
	files: ReadonlySet<string>,
): string | "non_relative" | null {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
		return "non_relative";
	}
	const base = posix.normalize(posix.join(posix.dirname(from), specifier));
	if (base.startsWith("../") || base === "..") return null;
	const candidates: string[] = [base];
	const scriptExt = /\.(?:[mc]?js|jsx)$/.exec(base);
	if (scriptExt) {
		const stem = base.slice(0, -scriptExt[0].length);
		candidates.push(
			...[".ts", ".tsx", ".mts", ".cts"].map((ext) => stem + ext),
		);
	}
	candidates.push(...JS_EXTENSIONS.map((ext) => base + ext));
	candidates.push(...JS_EXTENSIONS.map((ext) => `${base}/index${ext}`));
	return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function pythonModule(
	base: string,
	dotted: string,
	files: ReadonlySet<string>,
) {
	const path = [base, ...(dotted ? dotted.split(".") : [])]
		.filter(Boolean)
		.join("/");
	const candidates = dotted
		? [`${path}.py`, `${path}/__init__.py`]
		: [`${path ? `${path}/` : ""}__init__.py`];
	return candidates.find((candidate) => files.has(candidate)) ?? null;
}

/**
 * Relative imports from the importing package. Absolute ones only from
 * directories that are not packages themselves (no `__init__.py`), nearest
 * first, the way Python 3 import roots work: `src.core.db` from
 * `backend/src/api/x.py` resolves under `backend/`, while `import logging`
 * inside a package never resolves to a sibling `logging.py`.
 */
function resolvePythonImport(
	from: string,
	specifier: string,
	files: ReadonlySet<string>,
): string | "non_relative" | null {
	if (specifier === "__future__") return "non_relative";
	const dots = /^\.*/.exec(specifier)?.[0].length ?? 0;
	if (dots === 0) {
		let base = posix.dirname(from);
		for (;;) {
			const root = base === "." ? "" : base;
			if (!files.has(`${root ? `${root}/` : ""}__init__.py`)) {
				const found = pythonModule(root, specifier, files);
				if (found) return found;
			}
			if (!root) return "non_relative";
			base = posix.dirname(base);
		}
	}
	let base = posix.dirname(from);
	for (let level = 1; level < dots; level += 1) {
		if (base === "." || base === "") return null;
		base = posix.dirname(base);
	}
	if (base === ".") base = "";
	return pythonModule(base, specifier.slice(dots), files);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort(byteOrder)
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

type SymbolRecord = Omit<StructureArtifact["symbols"][number], "file"> & {
	path: string;
};

interface ExtractedFile {
	path: string;
	language: StructureLanguage;
	symbols: SymbolRecord[];
	references: readonly StructureReference[];
	/** Every extracted non-method definition's name, kept or not. */
	definedNames: ReadonlySet<string>;
}

/** Sort by start, longest first: spans nest or are disjoint. */
const byOpening = (
	a: { startByte: number; endByte: number; id: string },
	b: { startByte: number; endByte: number; id: string },
) =>
	a.startByte - b.startByte || b.endByte - a.endByte || byteOrder(a.id, b.id);

type FileLimit = "depth_limit" | "symbol_limit" | null;

/** Qualified names, IDs and hashes for one file's symbols, within caps. */
function fileSymbols(
	path: string,
	bytes: Buffer,
	symbols: readonly StructureSymbol[],
	limits: StructureArtifactLimits,
): { symbols: SymbolRecord[]; limit: FileLimit } {
	const opened = [...symbols].sort(
		(a, b) =>
			a.startByte - b.startByte ||
			b.endByte - a.endByte ||
			byteOrder(a.kind, b.kind) ||
			byteOrder(a.name, b.name),
	);
	// Open spans. A null name marks a dropped subtree; an alias continues its
	// parent (a named function assigned to the same name) without nesting.
	const stack: {
		endByte: number;
		kind: string;
		name: string;
		qualifiedName: string | null;
		alias: boolean;
	}[] = [];
	const ordinals = new Map<string, number>();
	const records: SymbolRecord[] = [];
	let limit: FileLimit = null;
	for (const symbol of opened) {
		while ((stack[stack.length - 1]?.endByte ?? Infinity) <= symbol.startByte) {
			stack.pop();
		}
		const parent = stack[stack.length - 1];
		if (parent && parent.qualifiedName === null) {
			stack.push({ ...symbol, qualifiedName: null, alias: false });
			continue;
		}
		// `x = function x() {}`: the named function ends with its assignment.
		if (
			parent &&
			parent.name === symbol.name &&
			parent.kind === symbol.kind &&
			parent.endByte === symbol.endByte &&
			!parent.alias
		) {
			stack.push({ ...parent, endByte: symbol.endByte, alias: true });
			continue;
		}
		const depth = stack.filter((open) => !open.alias).length + 1;
		const qualifiedName = parent?.qualifiedName
			? `${parent.qualifiedName}.${symbol.name}`
			: symbol.name;
		if (
			depth > limits.maxDepth ||
			Buffer.byteLength(qualifiedName) > limits.maxQualifiedNameBytes
		) {
			limit ??= "depth_limit";
			stack.push({ ...symbol, qualifiedName: null, alias: false });
			continue;
		}
		stack.push({ ...symbol, qualifiedName, alias: false });
		if (records.length >= limits.maxFileSymbols) {
			limit ??= "symbol_limit";
			continue;
		}
		const key = `${symbol.kind}\0${qualifiedName}`;
		const ordinal = ordinals.get(key) ?? 0;
		ordinals.set(key, ordinal + 1);
		records.push({
			id: symbolId(path, symbol.kind, qualifiedName, ordinal),
			path,
			kind: symbol.kind,
			name: symbol.name,
			qualifiedName,
			startLine: symbol.startLine,
			endLine: symbol.endLine,
			startByte: symbol.startByte,
			endByte: symbol.endByte,
			sha256:
				symbol.kind === "constant"
					? null
					: sha256(bytes.subarray(symbol.startByte, symbol.endByte)),
		});
	}
	return { symbols: records, limit };
}

function unresolvedReason(hasCandidates: boolean): UnresolvedReason {
	return hasCandidates ? "ambiguous" : "not_found";
}

export async function buildStructureArtifact(
	options: BuildStructureArtifactOptions,
): Promise<{ artifact: StructureArtifact; json: string; sha256: string }> {
	const { staged, indexer } = options;
	const limits = resolveLimits(options.limits);
	const deadline = performance.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	const manifest = [...staged.files].sort((a, b) => byteOrder(a.path, b.path));

	const files: StructureArtifact["files"] = [];
	const coverage: StructureArtifact["coverage"] = staged.skipped.map(
		(entry) => ({
			path: entry.path,
			state: "skipped" as const,
			reason: entry.reason,
		}),
	);
	const extracted: ExtractedFile[] = [];
	let snapshotSymbols = 0;
	let snapshotReferences = 0;
	let snapshotBytes = 0;

	for (const entry of manifest) {
		// Read strictly by manifest path and re-verify against the manifest.
		let bytes: Buffer;
		try {
			bytes = readFileSync(join(options.stagingRoot, ...entry.path.split("/")));
		} catch {
			throw new StructureArtifactError(
				"invalid_output",
				"Staged file is missing",
			);
		}
		if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
			throw new StructureArtifactError(
				"invalid_output",
				"Staged file differs from its manifest",
			);
		}
		const language = languageForPath(entry.path);
		if (!language) {
			coverage.push({
				path: entry.path,
				state: "skipped",
				reason: "unsupported_language",
			});
			continue;
		}
		files.push({
			id: fileId(entry.path),
			path: entry.path,
			language,
			size: entry.size,
			sha256: entry.sha256,
		});
		if (performance.now() >= deadline) {
			coverage.push({
				path: entry.path,
				state: "skipped",
				reason: "budget_exhausted",
			});
			continue;
		}
		let source: string;
		try {
			source = decoder.decode(bytes);
		} catch {
			coverage.push({ path: entry.path, state: "error", reason: "not_utf8" });
			continue;
		}
		try {
			const structure = indexer.extract(entry.path, source);
			const kept = fileSymbols(entry.path, bytes, structure.symbols, limits);
			const references = structure.references
				.filter(
					(reference) =>
						reference.kind === "import" ||
						Buffer.byteLength(reference.name) <= MAX_REFERENCE_NAME_BYTES,
				)
				.sort((a, b) => a.startByte - b.startByte);
			const referenceLimited = references.length > limits.maxFileReferences;
			if (referenceLimited) references.length = limits.maxFileReferences;
			const estimate =
				FILE_BYTES +
				2 * Buffer.byteLength(entry.path) +
				kept.symbols.reduce(
					(sum, symbol) =>
						sum +
						SYMBOL_BYTES +
						Buffer.byteLength(symbol.name) +
						Buffer.byteLength(symbol.qualifiedName),
					0,
				) +
				references.reduce(
					(sum, reference) =>
						sum + REFERENCE_BYTES + Buffer.byteLength(reference.name),
					0,
				);
			if (
				snapshotSymbols + kept.symbols.length > limits.maxSnapshotSymbols ||
				snapshotReferences + references.length > limits.maxSnapshotReferences ||
				snapshotBytes + estimate > limits.maxSnapshotBytes
			) {
				coverage.push({
					path: entry.path,
					state: "skipped",
					reason: "snapshot_limit",
				});
				continue;
			}
			snapshotSymbols += kept.symbols.length;
			snapshotReferences += references.length;
			snapshotBytes += estimate;
			extracted.push({
				path: entry.path,
				language,
				symbols: kept.symbols,
				references,
				definedNames: new Set(
					structure.symbols
						.filter((symbol) => symbol.kind !== "method")
						.map((symbol) => symbol.name),
				),
			});
			const reason = structure.hasError
				? "parse_error"
				: (kept.limit ?? (referenceLimited ? "reference_limit" : null));
			coverage.push({
				path: entry.path,
				state: reason ? "partial" : "indexed",
				reason: reason ?? "ok",
			});
		} catch (error) {
			if (!(error instanceof StructureIndexError)) throw error;
			if (error.code === "extractor_unavailable") throw error;
			coverage.push({
				path: entry.path,
				state: error.code === "oversize" ? "skipped" : "error",
				reason: error.code,
			});
		}
		// Let the event loop breathe between files.
		await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
	}

	files.sort((a, b) => byteOrder(a.path, b.path));
	const filePaths = new Set(files.map((file) => file.path));
	const fileNode = new Map(files.map((file, index) => [file.path, index]));
	const allSymbols = extracted
		.flatMap((file) => file.symbols)
		.sort(
			(a, b) =>
				byteOrder(a.path, b.path) ||
				a.startByte - b.startByte ||
				a.endByte - b.endByte ||
				byteOrder(a.id, b.id),
		);
	const symbolNode = new Map(
		allSymbols.map((symbol, index) => [symbol.id, files.length + index]),
	);
	const nodeOf = (id: string) => symbolNode.get(id) ?? -1;

	// Candidate counts so each lookup is constant time however many symbols
	// share a name: per rule, family and name snapshot-wide; per rule and name
	// in each file; methods per qualified name in each file.
	type Candidates = { count: number; first: SymbolRecord };
	const count = (
		table: Map<string, Candidates>,
		key: string,
		symbol: SymbolRecord,
	) => {
		const entry = table.get(key);
		if (entry) entry.count += 1;
		else table.set(key, { count: 1, first: symbol });
	};
	const snapshotCandidates = new Map<string, Candidates>();
	const fileCandidates = new Map<string, Candidates>();
	const classMethods = new Map<string, Candidates>();
	for (const file of extracted) {
		const family = languageFamily(file.language);
		for (const symbol of file.symbols) {
			if (symbol.kind === "method") {
				count(classMethods, `${file.path}\0${symbol.qualifiedName}`, symbol);
			}
			for (const [rule, { targets }] of Object.entries(REFERENCE_RULES)) {
				if (!targets.has(symbol.kind)) continue;
				count(snapshotCandidates, `${family}\0${rule}\0${symbol.name}`, symbol);
				count(fileCandidates, `${file.path}\0${rule}\0${symbol.name}`, symbol);
			}
		}
	}

	const edges = new Map<string, StructureEdgeTuple>();
	const unresolved = new Map<string, StructureUnresolvedTuple>();
	const addEdge = (edge: StructureEdgeTuple) => {
		edges.set(edge.slice(0, 3).join("\0"), edge);
	};
	const addUnresolved = (item: StructureUnresolvedTuple) => {
		unresolved.set(
			`${item[0]}\0${item[1]}\0${item[2] ?? ""}\0${item[3]}`,
			item,
		);
	};

	for (const file of extracted) {
		const owner = fileNode.get(file.path) ?? -1;
		const family = languageFamily(file.language);
		// Same-file definitions other than methods bind their names here,
		// including any dropped by a cap.
		const fileNames = file.definedNames;
		// Parameter names bound in each scope (a symbol, or "" for the file).
		const bindings = new Map<string, Set<string>>();
		// A stack of open spans gives containment and, for references, the
		// innermost definition around each reference's byte offset.
		const ordered = [...file.symbols].sort(byOpening);
		const stack: SymbolRecord[] = [];
		const closeBefore = (offset: number) => {
			while ((stack[stack.length - 1]?.endByte ?? Infinity) <= offset) {
				stack.pop();
			}
		};
		const innermost = () => {
			const top = stack[stack.length - 1];
			return top ? nodeOf(top.id) : owner;
		};
		let next = 0;
		const openThrough = (offset: number) => {
			for (; next < ordered.length; next += 1) {
				const symbol = ordered[next];
				if (!symbol || symbol.startByte > offset) break;
				closeBefore(symbol.startByte);
				addEdge(["contains", innermost(), nodeOf(symbol.id), "structural"]);
				stack.push(symbol);
			}
		};
		const enclosingClass = () => {
			for (let index = stack.length - 1; index >= 0; index -= 1) {
				if (stack[index]?.kind === "class") return stack[index];
			}
			return undefined;
		};
		const bound = (name: string) =>
			bindings.get("")?.has(name) ||
			stack.some((open) => bindings.get(open.id)?.has(name));
		for (const reference of file.references) {
			if (reference.kind === "import") {
				const target =
					file.language === "python"
						? resolvePythonImport(file.path, reference.name, filePaths)
						: resolveScriptImport(file.path, reference.name, filePaths);
				if (target && target !== "non_relative") {
					addEdge([
						"imports",
						owner,
						fileNode.get(target) ?? -1,
						"module_path",
					]);
				} else {
					addUnresolved([
						"imports",
						owner,
						shareableImportName(file.language, reference.name),
						target === "non_relative" ? "non_relative" : "not_found",
					]);
				}
				continue;
			}
			openThrough(reference.startByte);
			closeBefore(reference.startByte);
			const source = innermost();
			if (reference.kind === "binding") {
				const scope = stack[stack.length - 1]?.id ?? "";
				const names = bindings.get(scope) ?? new Set<string>();
				names.add(reference.name);
				bindings.set(scope, names);
				continue;
			}
			if (reference.kind === "call" && reference.receiver !== "none") {
				// Only `this`/`self` inside a class says where the method is.
				const owningClass =
					reference.receiver === "self" ? enclosingClass() : undefined;
				const method = owningClass
					? classMethods.get(
							`${file.path}\0${owningClass.qualifiedName}.${reference.name}`,
						)
					: undefined;
				if (method?.count === 1) {
					addEdge(["calls", source, nodeOf(method.first.id), "same_class"]);
				} else {
					addUnresolved([
						"calls",
						source,
						reference.name,
						owningClass
							? unresolvedReason(method !== undefined)
							: "receiver_unknown",
					]);
				}
				continue;
			}
			const rule = reference.kind as ReferenceRule;
			if (!Object.hasOwn(REFERENCE_RULES, rule)) continue;
			const { edge } = REFERENCE_RULES[rule];
			const resolved = (target: SymbolRecord, resolution: EdgeResolution) =>
				addEdge([
					// Calling a class constructs it.
					edge === "calls" && target.kind === "class" ? "constructs" : edge,
					source,
					nodeOf(target.id),
					resolution,
				]);
			if (bound(reference.name)) {
				addUnresolved([edge, source, reference.name, "shadowed"]);
				continue;
			}
			const local = fileCandidates.get(
				`${file.path}\0${rule}\0${reference.name}`,
			);
			if (local) {
				if (local.count === 1) resolved(local.first, "same_file");
				else addUnresolved([edge, source, reference.name, "ambiguous"]);
				continue;
			}
			if (fileNames.has(reference.name)) {
				addUnresolved([edge, source, reference.name, "shadowed"]);
				continue;
			}
			const remote = snapshotCandidates.get(
				`${family}\0${rule}\0${reference.name}`,
			);
			if (remote?.count === 1) resolved(remote.first, "unique_name");
			else {
				addUnresolved([
					edge,
					source,
					reference.name,
					unresolvedReason(remote !== undefined),
				]);
			}
		}
		// Containment for definitions after the last reference.
		openThrough(Infinity);
	}

	const artifact: StructureArtifact = {
		schema: STRUCTURE_ARTIFACT_SCHEMA,
		indexer: STRUCTURE_INDEXER_ID,
		commit: staged.commit,
		files,
		symbols: allSymbols.map(({ path, ...symbol }) => ({
			...symbol,
			file: fileNode.get(path) ?? -1,
		})),
		edges: [...edges.values()].sort(
			(a, b) => byteOrder(a[0], b[0]) || a[1] - b[1] || a[2] - b[2],
		),
		unresolved: [...unresolved.values()].sort(
			(a, b) =>
				byteOrder(a[0], b[0]) ||
				a[1] - b[1] ||
				byteOrder(a[2] ?? "", b[2] ?? "") ||
				byteOrder(a[3], b[3]),
		),
		coverage: coverage.sort((a, b) => byteOrder(a.path, b.path)),
		withheld: {
			sensitive: staged.sensitiveSkipped,
			unsafe: staged.unsafeSkipped,
		},
	};
	const json = canonicalJson(artifact);
	if (
		Buffer.byteLength(json) >
		(options.maxArtifactBytes ?? MAX_STRUCTURE_ARTIFACT_BYTES)
	) {
		throw new StructureArtifactError(
			"output_too_large",
			"Structure artifact exceeds its size limit",
		);
	}
	return { artifact, json, sha256: sha256(json) };
}
