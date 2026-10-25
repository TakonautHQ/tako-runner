/**
 * Takonaut structure indexer: deterministic, offline structural extraction
 * (definitions and references) from TypeScript, TSX, JavaScript and Python.
 *
 * Approach credit: the WebAssembly grammar + tags-query design follows the
 * generic extractor of Graft (Context Graph Engine contributors, MIT). No
 * Graft code is copied. Grammars and their `tags.scm` queries are vendored
 * from the tree-sitter grammar packages (MIT); see `grammars/*\/LICENSE` and
 * THIRD_PARTY_NOTICES.md.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Language,
	type Node as SyntaxNode,
	Parser,
	Query,
} from "web-tree-sitter";

export const STRUCTURE_INDEXER_ID = "tako-structure/1";

export type StructureLanguage = "typescript" | "tsx" | "javascript" | "python";

export class StructureIndexError extends Error {
	constructor(
		readonly code:
			| "extractor_unavailable"
			| "extractor_failed"
			| "oversize"
			| "timeout",
		message: string,
	) {
		super(message);
		this.name = "StructureIndexError";
	}
}

export interface StructureSymbol {
	readonly kind: string;
	readonly name: string;
	/** 1-based, inclusive. */
	readonly startLine: number;
	readonly endLine: number;
	/**
	 * Offsets into the UTF-8 encoding of the extracted `source`. Decode files
	 * with `ignoreBOM: true` so these match the file's own bytes.
	 */
	readonly startByte: number;
	readonly endByte: number;
}

export interface StructureReference {
	/**
	 * "call", "class" (construction), "type", "import", or "binding" (a
	 * parameter or type parameter name, which shadows outer names).
	 */
	readonly kind: string;
	/** Called name, referenced type, or import specifier. */
	readonly name: string;
	readonly line: number;
	/** UTF-8 offset of the name (or specifier), like symbol offsets. */
	readonly startByte: number;
	/**
	 * For calls: "self" for `this.f()`, `self.f()` or `cls.f()`, "other" for
	 * any other receiver (`x.f()`), whose target the name cannot tell, and
	 * "none" for a plain call.
	 */
	readonly receiver: "none" | "self" | "other";
}

export interface FileStructure {
	readonly language: StructureLanguage;
	readonly hasError: boolean;
	readonly symbols: readonly StructureSymbol[];
	readonly references: readonly StructureReference[];
}

export interface StructureIndexer {
	extract(path: string, source: string): FileStructure;
	/**
	 * Frees the parsers and queries. Grammar modules stay loaded (web-tree-sitter
	 * cannot unload them): keep one indexer per process.
	 */
	dispose(): void;
}

export interface StructureIndexerOptions {
	grammarRoot?: string;
	/** UTF-8 size limit per file; larger sources fail as `oversize`. */
	maxSourceBytes?: number;
	/** Parse and query time per file; slower files fail as `timeout`. */
	parseBudgetMs?: number;
}

/** SHA-256 of every vendored grammar input; anything else refuses to load. */
const PINNED_GRAMMAR_FILES: Readonly<Record<string, string>> = Object.freeze({
	"javascript/tags.scm":
		"6ef988cce5a428a15b5460e3ee96f1478705f965fc6e848a91a18bfa6c6f0212",
	"javascript/tree-sitter-javascript.wasm":
		"4a378293fe7853cbee2836023be072dafa0e53b3b5edb245920838ca834ed121",
	"python/tags.scm":
		"d0f3e577878167bfabc30e526e497bce58d1699b9bcabf8ab3a50698efb5ca3e",
	"python/tree-sitter-python.wasm":
		"8c93692fb368e288a5824cee55773c9b3602804f513bda48c97661e52e9c2da2",
	"typescript/tags.scm":
		"b391288bcc71b513a5df7c9bb232d8bc7418d7e274b125aa0aa4bdd6121a0338",
	"typescript/tree-sitter-tsx.wasm":
		"79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8",
	"typescript/tree-sitter-typescript.wasm":
		"778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d",
});

// Module specifiers; the vendored tags queries do not capture imports.
// CommonJS `require` and dynamic `import()` count only with a literal string.
const JS_IMPORTS = `
(import_statement source: (string) @import.source)
(export_statement source: (string) @import.source)
(call_expression
  function: (identifier) @_require
  arguments: (arguments . (string) @import.source)
  (#eq? @_require "require"))
(call_expression
  function: (import)
  arguments: (arguments . (string) @import.source))
`;
// TypeScript-only syntax (these node types do not exist in JavaScript).
const TS_EXTRA = `
(import_require_clause source: (string) @import.source)
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(internal_module name: (identifier) @name) @definition.module
`;
// Parameter and type parameter names: local bindings that shadow outer names.
// Destructured parameters: shorthand, renamed and defaulted properties,
// array elements and rest parameters.
const patternBindings = (parameter: string) => `
(${parameter} (object_pattern (shorthand_property_identifier_pattern) @name @reference.binding))
(${parameter} (object_pattern (pair_pattern value: (identifier) @name @reference.binding)))
(${parameter} (object_pattern (object_assignment_pattern left: (shorthand_property_identifier_pattern) @name @reference.binding)))
(${parameter} (array_pattern (identifier) @name @reference.binding))
(${parameter} (rest_pattern (identifier) @name @reference.binding))
`;
const JS_BINDINGS = `
(formal_parameters (identifier) @name @reference.binding)
(formal_parameters (assignment_pattern left: (identifier) @name @reference.binding))
(arrow_function parameter: (identifier) @name @reference.binding)
${patternBindings("formal_parameters")}
`;
const TS_BINDINGS = `
(required_parameter pattern: (identifier) @name @reference.binding)
(optional_parameter pattern: (identifier) @name @reference.binding)
(arrow_function parameter: (identifier) @name @reference.binding)
(type_parameter name: (type_identifier) @name @reference.binding)
${patternBindings("required_parameter pattern:")}
${patternBindings("optional_parameter pattern:")}
`;
const PY_BINDINGS = `
(parameters (identifier) @name @reference.binding)
(lambda_parameters (identifier) @name @reference.binding)
(default_parameter name: (identifier) @name @reference.binding)
(typed_parameter (identifier) @name @reference.binding)
(typed_default_parameter name: (identifier) @name @reference.binding)
(parameters (list_splat_pattern (identifier) @name @reference.binding))
(parameters (dictionary_splat_pattern (identifier) @name @reference.binding))
(lambda_parameters (list_splat_pattern (identifier) @name @reference.binding))
(lambda_parameters (dictionary_splat_pattern (identifier) @name @reference.binding))
`;
const PY_IMPORTS = `
(import_statement name: (dotted_name) @import.source)
(import_statement name: (aliased_import name: (dotted_name) @import.source))
(import_from_statement module_name: (dotted_name) @import.source)
(import_from_statement module_name: (relative_import) @import.source)
(future_import_statement) @import.source
`;
const DEFAULT_MAX_SOURCE_BYTES = 512 * 1024;
const DEFAULT_PARSE_BUDGET_MS = 5_000;

const EXTENSIONS: ReadonlyArray<[string, StructureLanguage]> = [
	[".tsx", "tsx"],
	[".ts", "typescript"],
	[".mts", "typescript"],
	[".cts", "typescript"],
	[".jsx", "javascript"],
	[".js", "javascript"],
	[".mjs", "javascript"],
	[".cjs", "javascript"],
	[".py", "python"],
];

// A non-arrow function rebinds `this`; arrow functions do not.
const THIS_REBINDING = new Set([
	"function_declaration",
	"function_expression",
	"function",
	"generator_function",
	"generator_function_declaration",
]);
const CLASS_MEMBERS = new Set([
	"method_definition",
	"public_field_definition",
	"field_definition",
	"class_static_block",
]);

/** `this` inside a class member, not inside a nested non-arrow function. */
function thisIsTheClass(node: SyntaxNode): boolean {
	for (let current = node.parent; current; current = current.parent) {
		if (CLASS_MEMBERS.has(current.type)) return true;
		if (THIS_REBINDING.has(current.type)) return false;
	}
	return false;
}

/**
 * How a call's name node is reached: plainly, through `this` (JS/TS) or
 * `self`/`cls` (Python), or through any other receiver.
 */
function receiverOf(nameNode: SyntaxNode): "none" | "self" | "other" {
	const parent = nameNode.parent;
	if (parent?.type === "member_expression") {
		return parent.childForFieldName("object")?.type === "this" &&
			thisIsTheClass(parent)
			? "self"
			: "other";
	}
	if (parent?.type === "attribute") {
		const object = parent.childForFieldName("object");
		return object?.type === "identifier" &&
			(object.text === "self" || object.text === "cls")
			? "self"
			: "other";
	}
	return "none";
}

export function languageForPath(path: string): StructureLanguage | null {
	for (const [extension, language] of EXTENSIONS) {
		if (path.endsWith(extension)) return language;
	}
	return null;
}

const DEFAULT_GRAMMAR_ROOT = fileURLToPath(
	new URL("../grammars", import.meta.url),
);

function pinned(root: string, file: string): Uint8Array {
	const expected = PINNED_GRAMMAR_FILES[file];
	let bytes: Buffer;
	try {
		bytes = readFileSync(join(root, file));
	} catch {
		throw new StructureIndexError(
			"extractor_unavailable",
			`Grammar file is missing: ${file}`,
		);
	}
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (!expected || actual !== expected) {
		throw new StructureIndexError(
			"extractor_unavailable",
			`Grammar file does not match its pinned hash: ${file}`,
		);
	}
	return bytes;
}

interface LoadedLanguage {
	parser: Parser;
	query: Query;
}

let runtime: Promise<void> | undefined;

async function initRuntime(): Promise<void> {
	runtime ??= Parser.init();
	const attempt = runtime;
	try {
		await attempt;
	} catch {
		// Do not cache a failed initialisation, but never clear a newer retry.
		if (runtime === attempt) runtime = undefined;
		throw new StructureIndexError(
			"extractor_unavailable",
			"Parser runtime failed to load",
		);
	}
}

async function loadLanguage(
	root: string,
	wasm: string,
	querySource: string,
): Promise<LoadedLanguage> {
	const bytes = pinned(root, wasm);
	try {
		const language = await Language.load(bytes);
		const parser = new Parser();
		parser.setLanguage(language);
		return { parser, query: new Query(language, querySource) };
	} catch {
		throw new StructureIndexError(
			"extractor_unavailable",
			`Grammar failed to load: ${wasm}`,
		);
	}
}

/** UTF-16 index -> UTF-8 byte offset for every position in `source`. */
function byteOffsets(source: string): (index: number) => number {
	if (/^[\u0000-\u007f]*$/.test(source)) return (index) => index;
	const offsets = new Uint32Array(source.length + 1);
	for (let index = 0; index < source.length; index += 1) {
		const unit = source.charCodeAt(index);
		const next = source.charCodeAt(index + 1);
		let width: number;
		if (unit < 0x80) width = 1;
		else if (unit < 0x800) width = 2;
		else if (
			unit >= 0xd800 &&
			unit <= 0xdbff &&
			next >= 0xdc00 &&
			next <= 0xdfff
		)
			width = 4; // A pair; its low half then adds nothing.
		else if (
			unit >= 0xdc00 &&
			unit <= 0xdfff &&
			index > 0 &&
			source.charCodeAt(index - 1) >= 0xd800 &&
			source.charCodeAt(index - 1) <= 0xdbff
		)
			width = 0;
		else width = 3; // BMP, or a lone surrogate (encoded as U+FFFD).
		offsets[index + 1] = (offsets[index] ?? 0) + width;
	}
	return (index) => offsets[index] ?? 0;
}

/** The class a construction names; other constructor shapes are skipped. */
function constructedClass(node: SyntaxNode): string | null {
	if (node.type === "identifier") return node.text;
	if (node.type === "member_expression") {
		return node.childForFieldName("property")?.text ?? null;
	}
	return null;
}

/** The first enclosing definition decides whether a Python def is a method. */
function isPythonMethod(node: SyntaxNode): boolean {
	let cursor = node.parent;
	while (cursor) {
		if (cursor.type === "class_definition") return true;
		if (cursor.type === "function_definition") return false;
		cursor = cursor.parent;
	}
	return false;
}

function importName(node: SyntaxNode): string {
	if (node.type === "future_import_statement") return "__future__";
	if (node.type === "string") {
		const fragment = node.namedChildren.find(
			(child) => child?.type === "string_fragment",
		);
		return fragment?.text ?? "";
	}
	return node.text;
}

function byPosition<T extends { line: number; column: number; key: string }>(
	left: T,
	right: T,
): number {
	return (
		left.line - right.line ||
		left.column - right.column ||
		(left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
	);
}

export async function createStructureIndexer(
	options: StructureIndexerOptions = {},
): Promise<StructureIndexer> {
	const root = options.grammarRoot ?? DEFAULT_GRAMMAR_ROOT;
	const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
	const parseBudgetMs = options.parseBudgetMs ?? DEFAULT_PARSE_BUDGET_MS;
	// Verify every pinned input before loading any of them.
	const tags = {
		javascript: new TextDecoder().decode(pinned(root, "javascript/tags.scm")),
		typescript: new TextDecoder().decode(pinned(root, "typescript/tags.scm")),
		python: new TextDecoder().decode(pinned(root, "python/tags.scm")),
	};
	for (const file of Object.keys(PINNED_GRAMMAR_FILES)) pinned(root, file);
	await initRuntime();
	const typescriptQuery = `${tags.javascript}\n${tags.typescript}\n${JS_IMPORTS}\n${TS_EXTRA}\n${TS_BINDINGS}`;
	const languages: Record<StructureLanguage, LoadedLanguage> = {
		typescript: await loadLanguage(
			root,
			"typescript/tree-sitter-typescript.wasm",
			typescriptQuery,
		),
		tsx: await loadLanguage(
			root,
			"typescript/tree-sitter-tsx.wasm",
			typescriptQuery,
		),
		javascript: await loadLanguage(
			root,
			"javascript/tree-sitter-javascript.wasm",
			`${tags.javascript}\n${JS_IMPORTS}\n${JS_BINDINGS}`,
		),
		python: await loadLanguage(
			root,
			"python/tree-sitter-python.wasm",
			`${tags.python}\n${PY_IMPORTS}\n${PY_BINDINGS}`,
		),
	};

	let disposed = false;
	return {
		dispose(): void {
			if (disposed) return;
			disposed = true;
			for (const loaded of Object.values(languages)) {
				loaded.query.delete();
				loaded.parser.delete();
			}
		},
		extract(path: string, source: string): FileStructure {
			if (disposed) {
				throw new StructureIndexError(
					"extractor_unavailable",
					"Structure indexer was disposed",
				);
			}
			const language = languageForPath(path);
			if (!language) {
				throw new StructureIndexError(
					"extractor_failed",
					"Unsupported language",
				);
			}
			// TextEncoder, not Buffer.byteLength: Bun counts lone surrogates as 2.
			if (new TextEncoder().encode(source).length > maxSourceBytes) {
				throw new StructureIndexError("oversize", "Source is too large");
			}
			const { parser, query } = languages[language];
			// Bound parse and query time per file.
			const deadline = performance.now() + parseBudgetMs;
			let cancelled = false;
			const overBudget = () => {
				cancelled ||= performance.now() > deadline;
				return cancelled;
			};
			// A cancelled parse leaves resumable state in the parser; without a
			// reset the next file would continue that parse over its own text.
			parser.reset();
			const tree = parser.parse(source, null, {
				progressCallback: overBudget,
			});
			if (!tree) {
				throw new StructureIndexError(
					cancelled ? "timeout" : "extractor_failed",
					cancelled ? "Parse exceeded its time budget" : "Parse failed",
				);
			}
			const toByte = byteOffsets(source);
			try {
				const symbols = new Map<
					string,
					StructureSymbol & { line: number; column: number; key: string }
				>();
				const references = new Map<
					string,
					StructureReference & { column: number; key: string }
				>();
				const matches = query.matches(tree.rootNode, {
					progressCallback: overBudget,
				});
				if (cancelled) {
					throw new StructureIndexError(
						"timeout",
						"Query exceeded its time budget",
					);
				}
				for (const match of matches) {
					const main = match.captures.find(
						(capture) =>
							capture.name.startsWith("definition.") ||
							capture.name.startsWith("reference.") ||
							capture.name === "import.source",
					);
					if (!main) continue;
					const nameNode =
						match.captures.find((capture) => capture.name === "name")?.node ??
						main.node;
					if (main.name === "import.source") {
						const name = importName(main.node);
						if (!name) continue;
						const line = main.node.startPosition.row + 1;
						const column = main.node.startPosition.column;
						const key = `import\0${name}`;
						references.set(`${line}:${column}:${key}`, {
							kind: "import",
							name,
							line,
							startByte: toByte(main.node.startIndex),
							receiver: "none",
							column,
							key,
						});
						continue;
					}
					const [role, rawKind] = main.name.split(".");
					const name =
						role === "reference" && rawKind === "class"
							? constructedClass(nameNode)
							: nameNode.text;
					if (!name || !rawKind) continue;
					if (role === "definition") {
						const kind =
							language === "python" &&
							rawKind === "function" &&
							isPythonMethod(main.node)
								? "method"
								: rawKind;
						const node = main.node;
						const key = `${kind}\0${name}`;
						symbols.set(`${node.startIndex}:${node.endIndex}:${key}`, {
							kind,
							name,
							startLine: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
							startByte: toByte(node.startIndex),
							endByte: toByte(node.endIndex),
							line: node.startPosition.row + 1,
							column: node.startPosition.column,
							key,
						});
					} else {
						const line = nameNode.startPosition.row + 1;
						const column = nameNode.startPosition.column;
						const key = `${rawKind}\0${name}`;
						references.set(`${line}:${column}:${key}`, {
							kind: rawKind,
							name,
							line,
							startByte: toByte(nameNode.startIndex),
							receiver: rawKind === "call" ? receiverOf(nameNode) : "none",
							column,
							key,
						});
					}
				}
				return Object.freeze({
					language,
					hasError: tree.rootNode.hasError,
					symbols: Object.freeze(
						[...symbols.values()]
							.sort(byPosition)
							.map(({ kind, name, startLine, endLine, startByte, endByte }) =>
								Object.freeze({
									kind,
									name,
									startLine,
									endLine,
									startByte,
									endByte,
								}),
							),
					),
					references: Object.freeze(
						[...references.values()]
							.sort(byPosition)
							.map(({ kind, name, line, startByte, receiver }) =>
								Object.freeze({ kind, name, line, startByte, receiver }),
							),
					),
				});
			} finally {
				// Trees live in WebAssembly memory and must be freed explicitly.
				tree.delete();
			}
		},
	};
}
