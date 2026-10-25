import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	stageGraphSources,
	type StagedGraphSources,
} from "../src/graph-sources";
import {
	STRUCTURE_ARTIFACT_SCHEMA,
	StructureArtifactError,
	buildStructureArtifact,
	structureEdges,
	structureUnresolved,
	type StructureArtifact,
	type StructureArtifactLimitsInput,
} from "../src/structure-artifact";
import {
	createStructureIndexer,
	type StructureIndexer,
} from "../src/structure-index";

// Local files and vendored grammars only: no network, provider or AI runtime.
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
let indexer: StructureIndexer;
beforeAll(async () => {
	indexer = await createStructureIndexer();
});
afterAll(() => indexer.dispose());

const COMMIT = "c".repeat(40);
const sha256 = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");

/** A staging directory and manifest shaped like stageGraphSources output. */
function staging(
	files: Record<string, string | Buffer>,
	extras: Partial<StagedGraphSources> = {},
	order: "sorted" | "reversed" = "sorted",
): { stagingRoot: string; staged: StagedGraphSources } {
	const stagingRoot = mkdtempSync(join(tmpdir(), "takonaut-artifact-"));
	roots.push(stagingRoot);
	const entries = Object.entries(files).map(([path, content]) => {
		const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
		const target = join(stagingRoot, ...path.split("/"));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, bytes);
		return { path, size: bytes.length, sha256: sha256(bytes) };
	});
	entries.sort((a, b) => (a.path < b.path ? -1 : 1));
	if (order === "reversed") entries.reverse();
	return {
		stagingRoot,
		staged: {
			commit: COMMIT,
			files: entries,
			skipped: [],
			sensitiveSkipped: 0,
			unsafeSkipped: 0,
			...extras,
		},
	};
}

async function build(
	files: Record<string, string | Buffer>,
	options: {
		extras?: Partial<StagedGraphSources>;
		order?: "sorted" | "reversed";
		indexer?: StructureIndexer;
		budgetMs?: number;
		maxArtifactBytes?: number;
		limits?: StructureArtifactLimitsInput;
	} = {},
) {
	const { stagingRoot, staged } = staging(files, options.extras, options.order);
	return buildStructureArtifact({
		stagingRoot,
		staged,
		indexer: options.indexer ?? indexer,
		budgetMs: options.budgetMs,
		maxArtifactBytes: options.maxArtifactBytes,
		limits: options.limits,
	});
}

const symbolNamed = (artifact: StructureArtifact, name: string) => {
	const found = artifact.symbols.filter((symbol) => symbol.name === name);
	expect(found).toHaveLength(1);
	return found[0] as StructureArtifact["symbols"][number];
};

const edge = (
	artifact: StructureArtifact,
	kind: string,
	from: string,
	to: string,
) =>
	structureEdges(artifact).some(
		(item) => item.kind === kind && item.source === from && item.target === to,
	);

describe("files and coverage", () => {
	it("indexes supported files and records every other outcome", async () => {
		const { artifact } = await build(
			{
				"src/a.ts": "export function a() {}\n",
				"src/b.js": "function b() {}\n",
				"pkg/c.py": "def c():\n    pass\n",
				"docs/readme.md": "# hi\n",
				"src/broken.ts": "export function ok() {}\nfunction broken( {\n",
			},
			{
				extras: {
					skipped: [{ path: "src/logo.ts", reason: "binary" }],
					sensitiveSkipped: 2,
					unsafeSkipped: 1,
				},
			},
		);
		expect(artifact.schema).toBe(STRUCTURE_ARTIFACT_SCHEMA);
		expect(artifact.indexer).toBe("tako-structure/1");
		expect(artifact.commit).toBe(COMMIT);
		expect(artifact.files.map((file) => [file.path, file.language])).toEqual([
			["pkg/c.py", "python"],
			["src/a.ts", "typescript"],
			["src/b.js", "javascript"],
			["src/broken.ts", "typescript"],
		]);
		expect(
			artifact.coverage.map((entry) => [entry.path, entry.state, entry.reason]),
		).toEqual([
			["docs/readme.md", "skipped", "unsupported_language"],
			["pkg/c.py", "indexed", "ok"],
			["src/a.ts", "indexed", "ok"],
			["src/b.js", "indexed", "ok"],
			["src/broken.ts", "partial", "parse_error"],
			["src/logo.ts", "skipped", "binary"],
		]);
		expect(artifact.withheld).toEqual({ sensitive: 2, unsafe: 1 });
	});

	it("records an oversize or slow file without failing the snapshot", async () => {
		const small = await createStructureIndexer({ maxSourceBytes: 64 });
		try {
			const { artifact } = await build(
				{
					"src/big.ts": `export const big = "${"x".repeat(100)}";\n`,
					"src/ok.ts": "export function ok() {}\n",
				},
				{ indexer: small },
			);
			expect(
				artifact.coverage.map((entry) => [
					entry.path,
					entry.state,
					entry.reason,
				]),
			).toEqual([
				["src/big.ts", "skipped", "oversize"],
				["src/ok.ts", "indexed", "ok"],
			]);
			// Known from the manifest even without symbols; coverage says why.
			expect(artifact.files.map((file) => file.path)).toEqual([
				"src/big.ts",
				"src/ok.ts",
			]);
		} finally {
			small.dispose();
		}
	});

	it("marks files left after the snapshot budget as skipped", async () => {
		const { artifact } = await build(
			{
				"src/a.ts": "export function a() {}\n",
				"src/b.ts": "function b() {}\n",
			},
			{ budgetMs: 0 },
		);
		expect(artifact.coverage.map((entry) => entry.reason)).toEqual([
			"budget_exhausted",
			"budget_exhausted",
		]);
		expect(artifact.symbols).toEqual([]);
	});
});

describe("symbols", () => {
	it("hashes each symbol's exact bytes, including non-ASCII and BOM files", async () => {
		const files = {
			"src/u.ts":
				'// caf\u00e9 \u{1F600}\nexport function f() { return "\u00e9"; }\n',
			"src/bom.ts": "\uFEFFexport function g() {}\n",
		};
		const { artifact } = await build(files);
		// The definition itself: `export` (like decorators) is outside the span.
		expect(symbolNamed(artifact, "f").sha256).toBe(
			sha256('function f() { return "\u00e9"; }'),
		);
		expect(symbolNamed(artifact, "g").sha256).toBe(sha256("function g() {}"));
	});

	it("keeps IDs stable when unrelated lines above change", async () => {
		const before = await build({ "src/a.ts": "export function a() {}\n" });
		const after = await build({
			"src/a.ts": "// a new comment\n\nexport function a() {}\n",
		});
		expect(symbolNamed(after.artifact, "a").id).toBe(
			symbolNamed(before.artifact, "a").id,
		);
		expect(symbolNamed(after.artifact, "a").startLine).toBe(3);
	});

	it("keeps member IDs when a same-named member is added in another class", async () => {
		const before = await build({
			"src/a.ts": "class A { m() {} }\nclass B { m() {} }\n",
		});
		const after = await build({
			"src/a.ts":
				"class C { m() {} }\nclass A { m() {} }\nclass B { m() {} }\n",
		});
		const ids = (artifact: StructureArtifact) =>
			Object.fromEntries(
				artifact.symbols.map((symbol) => [symbol.qualifiedName, symbol.id]),
			);
		expect(ids(after.artifact)).toMatchObject(ids(before.artifact));
		expect(Object.keys(ids(after.artifact)).sort()).toEqual([
			"A",
			"A.m",
			"B",
			"B.m",
			"C",
			"C.m",
		]);
	});

	it("gives repeated names in one file distinct IDs", async () => {
		const { artifact } = await build({
			"src/g.ts": [
				"export class K {",
				"  get v() { return 1; }",
				"  set v(x: number) {}",
				"}",
				"",
			].join("\n"),
		});
		const ids = artifact.symbols
			.filter((symbol) => symbol.name === "v")
			.map((symbol) => symbol.id);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});
});

describe("edges", () => {
	const files = {
		"src/a.ts": [
			'import { helper } from "./util";',
			'import { thing } from "./lib.js";',
			'import React from "react";',
			"export class Greeter {",
			"  greet() { return helper(); }",
			"}",
			"export function run() {",
			"  new Greeter().greet();",
			"  local();",
			"  shared();",
			"  console.log(thing);",
			"}",
			"function local() {}",
			"",
		].join("\n"),
		"src/util/index.ts": "export function helper() {}\n",
		"src/lib.ts": "export const thing = 1;\nexport function shared() {}\n",
		"src/other.ts": "export function shared() {}\n",
	};

	it("links containment, calls, constructions and imports", async () => {
		const { artifact } = await build(files);
		const file = (path: string) => {
			const found = artifact.files.find((entry) => entry.path === path);
			expect(found).toBeDefined();
			return found?.id ?? "";
		};
		const greeter = symbolNamed(artifact, "Greeter").id;
		const greet = symbolNamed(artifact, "greet").id;
		const run = symbolNamed(artifact, "run").id;
		const helper = symbolNamed(artifact, "helper").id;
		expect(edge(artifact, "contains", file("src/a.ts"), greeter)).toBe(true);
		expect(edge(artifact, "contains", greeter, greet)).toBe(true);
		expect(edge(artifact, "calls", greet, helper)).toBe(true);
		expect(edge(artifact, "constructs", run, greeter)).toBe(true);
		// `new Greeter().greet()`: the receiver is not `this`, so no edge.
		expect(edge(artifact, "calls", run, greet)).toBe(false);
		expect(
			edge(artifact, "calls", run, symbolNamed(artifact, "local").id),
		).toBe(true);
		expect(
			edge(artifact, "imports", file("src/a.ts"), file("src/util/index.ts")),
		).toBe(true);
		expect(
			edge(artifact, "imports", file("src/a.ts"), file("src/lib.ts")),
		).toBe(true);
		const local = structureEdges(artifact).find(
			(item) =>
				item.kind === "calls" &&
				item.source === run &&
				item.target === symbolNamed(artifact, "local").id,
		);
		expect(local?.resolution).toBe("same_file");
		const toHelper = structureEdges(artifact).find(
			(item) => item.kind === "calls" && item.target === helper,
		);
		expect(toHelper?.resolution).toBe("unique_name");
	});

	it("attributes references by position, even on one minified line", async () => {
		const { artifact } = await build({
			"src/min.js": "function f(){g()}function g(){h()}function h(){}\n",
		});
		const id = (name: string) => symbolNamed(artifact, name).id;
		const calls = structureEdges(artifact)
			.filter((item) => item.kind === "calls")
			.map((item) => [item.source, item.target]);
		expect(calls).toEqual(
			expect.arrayContaining([
				[id("f"), id("g")],
				[id("g"), id("h")],
			]),
		);
		expect(calls).toHaveLength(2);
	});

	it("attributes a top-level call after a definition to the file", async () => {
		const { artifact } = await build({
			"src/a.ts": "function f() {}\nf();\n",
		});
		const file = artifact.files[0]?.id;
		expect(
			structureEdges(artifact).filter((item) => item.kind === "calls"),
		).toEqual([
			{
				source: file,
				target: symbolNamed(artifact, "f").id,
				kind: "calls",
				resolution: "same_file",
			},
		]);
	});

	it("resolves heavy name fan-out in roughly linear time", async () => {
		// 60,000 same-named definitions, each calling that name, within the
		// default caps: quadratic resolution would take minutes.
		const body = "def a():\n    a()\n".repeat(5_000);
		const files = Object.fromEntries(
			Array.from({ length: 12 }, (_, index) => [`pkg/m${index}.py`, body]),
		);
		const started = performance.now();
		const { artifact, json } = await build(files);
		expect(artifact.symbols).toHaveLength(60_000);
		expect(performance.now() - started).toBeLessThan(30_000);
		expect(json.length).toBeLessThan(64 * 1024 * 1024);
	}, 90_000);

	it("never links across languages", async () => {
		const { artifact } = await build({
			"pkg/m.py": "def use():\n    return render()\n",
			"src/view.tsx": "export function render() { return null; }\n",
		});
		expect(
			structureEdges(artifact).filter((item) => item.kind === "calls"),
		).toEqual([]);
		expect(structureUnresolved(artifact)).toEqual([
			expect.objectContaining({ name: "render", reason: "not_found" }),
		]);
	});

	it("links this/self calls only to a method of the enclosing class", async () => {
		const { artifact } = await build({
			"src/a.ts": [
				"class Box { open() {} use(o: any) { this.open(); o.open(); } }",
				"class Queue { append(x: number) {} }",
				"export function go(x: any, out: number[]) {",
				"  x.render(); out.append(1); close();",
				"}",
				"",
			].join("\n"),
			"src/b.ts": "export class View { render() {} close() {} }\n",
			"pkg/m.py": [
				"class A:",
				"    def helper(self):",
				"        pass",
				"    def run(self):",
				"        self.helper()",
				"        self.other()",
				"class B:",
				"    def other(self):",
				"        pass",
				"",
			].join("\n"),
		});
		const calls = structureEdges(artifact).filter(
			(item) => item.kind === "calls",
		);
		const method = (qualifiedName: string) =>
			artifact.symbols.find((symbol) => symbol.qualifiedName === qualifiedName)
				?.id;
		expect(calls).toEqual(
			expect.arrayContaining([
				{
					kind: "calls",
					source: method("Box.use"),
					target: method("Box.open"),
					resolution: "same_class",
				},
				{
					kind: "calls",
					source: method("A.run"),
					target: method("A.helper"),
					resolution: "same_class",
				},
			]),
		);
		expect(calls).toHaveLength(2);
		const reasons = Object.fromEntries(
			structureUnresolved(artifact).map((item) => [item.name, item.reason]),
		);
		// Other receivers are unknown even with a same-file method of that name
		// (`out.append` is not `Queue.append`); `self.other` is not in class A;
		// a plain call never resolves to a method.
		expect(reasons).toMatchObject({
			render: "receiver_unknown",
			append: "receiver_unknown",
			open: "receiver_unknown",
			other: "not_found",
			close: "not_found",
		});
	});

	it("never links a name shadowed by a parameter or a same-file definition", async () => {
		const { artifact } = await build({
			"src/a.ts": [
				"export function run(cb: () => void) { cb(); }",
				"export function id<T>(x: T): T { return x; }",
				"function Foo() {}",
				"export function make() { return new Foo(); }",
				"",
			].join("\n"),
			"src/b.ts": [
				"export function cb() {}",
				"export interface T {}",
				"export class Foo {}",
				"",
			].join("\n"),
		});
		const fromA = structureEdges(artifact).filter(
			(item) =>
				item.kind !== "contains" &&
				artifact.symbols.find((symbol) => symbol.id === item.target)?.file ===
					1,
		);
		expect(fromA).toEqual([]);
		const reasons = structureUnresolved(artifact)
			.filter((item) => item.kind !== "imports")
			.map((item) => [item.name, item.reason]);
		expect(reasons).toEqual(
			expect.arrayContaining([
				["cb", "shadowed"],
				["T", "shadowed"],
				["Foo", "shadowed"],
			]),
		);
	});

	it("never links a name bound by a destructured or rest parameter", async () => {
		const { artifact } = await build({
			"src/a.tsx":
				"export function Button({ render }: any, ...cbs: any[]) { render(); cbs(); }\n",
			"src/b.ts": "export function render() {}\nexport function cbs() {}\n",
		});
		expect(
			structureEdges(artifact).filter((item) => item.kind === "calls"),
		).toEqual([]);
		expect(
			structureUnresolved(artifact).map((item) => [item.name, item.reason]),
		).toEqual(
			expect.arrayContaining([
				["render", "shadowed"],
				["cbs", "shadowed"],
			]),
		);
	});

	it("keeps `this` in a nested function apart from the class", async () => {
		const { artifact } = await build({
			"src/k.ts":
				"class K { f() {} g() { [1].forEach(function () { this.f(); }); } }\n",
		});
		expect(
			structureEdges(artifact).filter((item) => item.kind === "calls"),
		).toEqual([]);
		expect(
			structureUnresolved(artifact).find((item) => item.name === "f"),
		).toMatchObject({ reason: "receiver_unknown" });
	});

	it("keeps a real nested definition with its parent's name", async () => {
		const { artifact } = await build({
			"src/w.js":
				"function walk(n) { function walk(m) { visit(m); } walk(n); }\nfunction visit() {}\n",
		});
		const walks = artifact.symbols.filter((s) => s.name === "walk");
		expect(walks.map((s) => s.qualifiedName)).toEqual(["walk", "walk.walk"]);
		// `walk(n)` names two same-file functions, and `visit` is called by
		// the inner one.
		expect(
			edge(
				artifact,
				"calls",
				walks[1]?.id ?? "",
				symbolNamed(artifact, "visit").id,
			),
		).toBe(true);
	});

	it("lets definitions dropped by a cap still shadow names", async () => {
		const remote = { "src/b.js": "export function helper() {}\n" };
		const deep = await build(
			{
				...remote,
				"src/a.js":
					"function a() { function b() { function helper() {} } helper(); }\n",
			},
			{ limits: { maxDepth: 2 } },
		);
		const many = await build(
			{
				...remote,
				"src/a.js": "function a() { helper(); }\nfunction helper() {}\n",
			},
			{ limits: { maxFileSymbols: 1 } },
		);
		for (const { artifact } of [deep, many]) {
			expect(
				structureEdges(artifact).filter((item) => item.kind === "calls"),
			).toEqual([]);
			expect(structureUnresolved(artifact)).toEqual([
				expect.objectContaining({ name: "helper", reason: "shadowed" }),
			]);
		}
	});

	it("records calling a class as a construction", async () => {
		const { artifact } = await build({
			"pkg/m.py": "class Foo:\n    pass\ndef make():\n    return Foo()\n",
		});
		expect(
			edge(
				artifact,
				"constructs",
				symbolNamed(artifact, "make").id,
				symbolNamed(artifact, "Foo").id,
			),
		).toBe(true);
	});

	it("attributes a one-character name at the end of a definition to it", async () => {
		const { artifact } = await build({
			"src/a.ts": "interface T {}\nexport function f(x: number): T\n",
		});
		expect(
			edge(
				artifact,
				"references_type",
				symbolNamed(artifact, "f").id,
				symbolNamed(artifact, "T").id,
			),
		).toBe(true);
	});

	it("keeps one symbol for a named function assigned to the same name", async () => {
		const { artifact } = await build({
			"src/a.js":
				"module.exports.foo = function foo() {};\nconst o = { baz: function baz() {} };\n",
		});
		expect(artifact.symbols.filter((s) => s.name === "foo")).toHaveLength(1);
		expect(artifact.symbols.filter((s) => s.name === "baz")).toHaveLength(1);
	});

	it("records unresolved references with a reason instead of guessing", async () => {
		const { artifact } = await build(files);
		const run = symbolNamed(artifact, "run").id;
		const unresolved = (name: string) =>
			structureUnresolved(artifact).find((item) => item.name === name);
		expect(unresolved("shared")).toMatchObject({
			source: run,
			kind: "calls",
			reason: "ambiguous",
		});
		// A method call on an unknown receiver is never linked by name alone.
		expect(unresolved("log")).toMatchObject({
			kind: "calls",
			reason: "receiver_unknown",
		});
		expect(unresolved("greet")).toMatchObject({
			kind: "calls",
			reason: "receiver_unknown",
		});
		expect(unresolved("react")).toMatchObject({
			kind: "imports",
			reason: "non_relative",
		});
	});

	it("prefers a same-file definition over one elsewhere", async () => {
		const { artifact } = await build({
			"src/a.ts": "export function run() { util(); }\nfunction util() {}\n",
			"src/b.ts": "export function util() {}\n",
		});
		const [local] = artifact.symbols.filter(
			(symbol) =>
				symbol.name === "util" &&
				artifact.files[symbol.file]?.path === "src/a.ts",
		);
		const link = structureEdges(artifact).find(
			(item) =>
				item.kind === "calls" &&
				item.source === symbolNamed(artifact, "run").id,
		);
		expect(link).toEqual({
			source: symbolNamed(artifact, "run").id,
			target: local?.id,
			kind: "calls",
			resolution: "same_file",
		});
	});

	it("names only package-like imports it cannot resolve", async () => {
		const { artifact, json } = await build({
			"src/a.ts": [
				'import "react";',
				'import "@scope/pkg/sub";',
				'import "node:fs";',
				'import "/Users/alice/secret/config";',
				'import "https://user:tok3n@deno.land/x/mod.ts";',
				'import "./.env.local";',
				'import "../../../etc/passwd";',
				'import "aws-credentials/.env";',
				'import "config/secrets";',
				"",
			].join("\n"),
			"pkg/m.py": "import os.path\nfrom ..missing import x\n",
		});
		const imports = structureUnresolved(artifact)
			.filter((item) => item.kind === "imports")
			.map((item) => [item.name, item.reason]);
		expect(imports).toEqual(
			expect.arrayContaining([
				["react", "non_relative"],
				["@scope/pkg/sub", "non_relative"],
				["node:fs", "non_relative"],
				["os.path", "non_relative"],
				[null, "non_relative"],
				[null, "not_found"],
			]),
		);
		for (const secret of [
			"alice",
			"tok3n",
			".env",
			"passwd",
			"missing",
			"secrets",
		]) {
			expect(json).not.toContain(secret);
		}
	});

	it("resolves absolute Python imports from an enclosing package root", async () => {
		const { artifact } = await build({
			"backend/src/__init__.py": "",
			"backend/src/core/__init__.py": "",
			"backend/src/core/db.py": "def connect():\n    pass\n",
			"backend/src/api/x.py":
				"from src.core.db import connect\nimport requests\n",
		});
		const id = (path: string) =>
			artifact.files.find((entry) => entry.path === path)?.id ?? "";
		expect(
			edge(
				artifact,
				"imports",
				id("backend/src/api/x.py"),
				id("backend/src/core/db.py"),
			),
		).toBe(true);
		expect(
			structureUnresolved(artifact).map((item) => [item.name, item.reason]),
		).toEqual([["requests", "non_relative"]]);
	});

	it("does not resolve an absolute import to a sibling inside a package", async () => {
		const { artifact } = await build({
			"backend/src/__init__.py": "",
			"backend/src/utils/__init__.py": "",
			"backend/src/utils/logging.py": "def log():\n    pass\n",
			"backend/src/utils/helpers.py":
				"import logging\nfrom typing import Any\n",
		});
		expect(
			structureEdges(artifact).filter((item) => item.kind === "imports"),
		).toEqual([]);
		expect(
			structureUnresolved(artifact).map((item) => [item.name, item.reason]),
		).toEqual([
			["logging", "non_relative"],
			["typing", "non_relative"],
		]);
	});

	it("keeps distinct reasons for unnamed imports from one file", async () => {
		const { artifact } = await build({
			"src/a.ts": 'import "@/lib/b";\nimport "/abs/x";\nimport "./missing";\n',
		});
		expect(
			structureUnresolved(artifact).map((item) => [item.name, item.reason]),
		).toEqual([
			[null, "non_relative"],
			[null, "not_found"],
		]);
	});

	it("resolves Python absolute and relative imports", async () => {
		const { artifact } = await build({
			"pkg/__init__.py": "",
			"pkg/util.py": "def util():\n    pass\n",
			"pkg/sub/__init__.py": "",
			"pkg/sub/mod.py": [
				"from . import sibling",
				"from .. import util",
				"from ..util import util",
				"import pkg.util",
				"import os",
				"",
			].join("\n"),
			"pkg/sub/sibling.py": "",
		});
		const id = (path: string) =>
			artifact.files.find((entry) => entry.path === path)?.id ?? "";
		const mod = id("pkg/sub/mod.py");
		expect(edge(artifact, "imports", mod, id("pkg/sub/__init__.py"))).toBe(
			true,
		);
		expect(edge(artifact, "imports", mod, id("pkg/__init__.py"))).toBe(true);
		expect(edge(artifact, "imports", mod, id("pkg/util.py"))).toBe(true);
		expect(
			structureUnresolved(artifact).find((item) => item.name === "os"),
		).toMatchObject({ kind: "imports", reason: "non_relative" });
	});
});

describe("bounds and privacy", () => {
	it("caps definition nesting and marks the file partial", async () => {
		let source = "";
		for (let depth = 0; depth < 40; depth += 1)
			source += `function f${depth}() {`;
		source += "}".repeat(40) + "\n";
		const { artifact, json } = await build({ "src/deep.js": source });
		expect(artifact.symbols).toHaveLength(32);
		expect(
			Math.max(...artifact.symbols.map((s) => s.qualifiedName.length)),
		).toBeLessThan(512);
		expect(artifact.coverage).toEqual([
			{ path: "src/deep.js", state: "partial", reason: "depth_limit" },
		]);
		expect(json.length).toBeLessThan(64 * 1024);
	});

	it("caps symbols and references per file", async () => {
		const { artifact } = await build(
			{ "pkg/m.py": "def a():\n    a()\n".repeat(30) },
			{ limits: { maxFileSymbols: 10, maxFileReferences: 1000 } },
		);
		expect(artifact.symbols).toHaveLength(10);
		expect(artifact.coverage[0]).toMatchObject({
			state: "partial",
			reason: "symbol_limit",
		});
		const calls = Array.from({ length: 30 }, (_, n) => `    f${n}()\n`);
		const refs = await build(
			{ "pkg/m.py": `def a():\n${calls.join("")}` },
			{ limits: { maxFileReferences: 5 } },
		);
		// Thirty distinct unknown names; only the first five references count.
		expect(refs.artifact.unresolved).toHaveLength(5);
		expect(refs.artifact.coverage[0]).toMatchObject({
			state: "partial",
			reason: "reference_limit",
		});
	});

	it("skips files once the snapshot caps are reached, without failing", async () => {
		const { artifact } = await build(
			{
				"src/a.ts": "function a1() {}\nfunction a2() {}\n",
				"src/b.ts": "function b1() {}\nfunction b2() {}\n",
			},
			{ limits: { maxSnapshotSymbols: 3 } },
		);
		expect(artifact.symbols.map((s) => s.name)).toEqual(["a1", "a2"]);
		expect(artifact.coverage).toEqual([
			{ path: "src/a.ts", state: "indexed", reason: "ok" },
			{ path: "src/b.ts", state: "skipped", reason: "snapshot_limit" },
		]);
	});

	it("keeps the estimated output within the snapshot byte budget", async () => {
		// Long qualified names: counts stay within their caps, bytes do not.
		const longName = `K${"x".repeat(400)}`;
		const file = `class ${longName} {\n${Array.from({ length: 200 }, (_, n) => `  m${n}() {}\n`).join("")}}\n`;
		const files = Object.fromEntries(
			Array.from({ length: 10 }, (_, n) => [`src/f${n}.ts`, file]),
		);
		const { artifact, json } = await build(files, {
			limits: { maxSnapshotBytes: 400 * 1024 },
		});
		expect(json.length).toBeLessThanOrEqual(400 * 1024);
		expect(artifact.coverage.map((entry) => entry.reason)).toContain(
			"snapshot_limit",
		);
		expect(artifact.coverage.map((entry) => entry.reason)).toContain("ok");
	});

	it("skips references whose names exceed the name limit", async () => {
		const long = "x".repeat(300);
		const { json } = await build({
			"src/a.ts": `export function f() { ${long}(); g(); }\n`,
		});
		expect(json).not.toContain(long);
		expect(json).toContain('"g"');
	});

	it("never hashes constants, whose short values could be guessed", async () => {
		const { artifact, json } = await build({
			"pkg/settings.py": 'DB_PASSWORD = "hunter2"\ndef f():\n    pass\n',
		});
		expect(symbolNamed(artifact, "DB_PASSWORD").sha256).toBeNull();
		expect(json).not.toContain(sha256('DB_PASSWORD = "hunter2"'));
		expect(symbolNamed(artifact, "f").sha256).toBe(
			sha256("def f():\n    pass"),
		);
	});
});

describe("compact format", () => {
	it("encodes edges and unresolved references as tuples over node positions", async () => {
		const { artifact } = await build({
			"src/a.ts":
				'import "react";\nexport function a() { b(); }\nfunction b() {}\n',
		});
		const nodes = artifact.files.length + artifact.symbols.length;
		expect(artifact.edges.length).toBeGreaterThan(0);
		for (const [kind, source, target, resolution] of artifact.edges) {
			expect(typeof kind).toBe("string");
			expect(typeof resolution).toBe("string");
			for (const node of [source, target]) {
				expect(Number.isInteger(node) && node >= 0 && node < nodes).toBe(true);
			}
		}
		for (const [kind, source, name, reason] of artifact.unresolved) {
			expect([kind, name, reason]).toEqual([
				"imports",
				"react",
				"non_relative",
			]);
			expect(source).toBe(0);
		}
		expect(artifact.symbols.every((symbol) => symbol.file === 0)).toBe(true);
	});
});

describe("integrity and determinism", () => {
	const files = {
		"src/a.ts":
			'import { b } from "./b";\nexport function a() { return b(); }\n',
		"src/b.ts": "export function b() {}\n",
		"pkg/m.py": "class M:\n    def run(self):\n        return helper()\n",
	};

	it("produces identical bytes and hash across staging roots and input order", async () => {
		const first = await build(files);
		const second = await build(files, { order: "reversed" });
		expect(second.json).toBe(first.json);
		expect(second.sha256).toBe(first.sha256);
		expect(first.sha256).toBe(sha256(first.json));
	});

	it("never includes the local staging path", async () => {
		const { stagingRoot, staged } = staging(files);
		const result = await buildStructureArtifact({
			stagingRoot,
			staged,
			indexer,
		});
		expect(result.json).not.toContain(stagingRoot);
		expect(result.json).not.toContain(tmpdir());
	});

	it("refuses staged bytes that differ from the manifest", async () => {
		const { stagingRoot, staged } = staging(files);
		writeFileSync(join(stagingRoot, "src", "b.ts"), "export function c() {}\n");
		await expect(
			buildStructureArtifact({ stagingRoot, staged, indexer }),
		).rejects.toMatchObject({ code: "invalid_output" });
	});

	it("fails as output_too_large past the artifact size limit", async () => {
		await expect(
			build(files, { maxArtifactBytes: 256 }),
		).rejects.toBeInstanceOf(StructureArtifactError);
		await expect(build(files, { maxArtifactBytes: 256 })).rejects.toMatchObject(
			{
				code: "output_too_large",
			},
		);
	});
});

describe("end to end with Git staging", () => {
	it("builds an artifact from a real commit staged by stageGraphSources", async () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-artifact-git-"));
		roots.push(root);
		const source = join(root, "source");
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
		execFileSync("git", ["init", "--quiet", "-b", "main", source]);
		git("config", "user.name", "Runner Test");
		git("config", "user.email", "runner@test.invalid");
		git("config", "commit.gpgsign", "false");
		for (const [path, content] of Object.entries({
			"src/a.ts":
				'import { b } from "./b";\nexport function a() { return b(); }\n',
			"src/b.ts": "export function b() {}\n",
			"src/.env": "SECRET=1\n",
			"docs/x.md": "outside the allowlist\n",
		})) {
			mkdirSync(dirname(join(source, path)), { recursive: true });
			writeFileSync(join(source, path), content);
		}
		git("add", "-A");
		git("commit", "--quiet", "-m", "first");
		git("remote", "add", "origin", "https://github.com/acme/widget.git");
		const commit = git("rev-parse", "HEAD");
		const stagingRoot = join(root, "staging");
		const staged = await stageGraphSources({
			repositoryRoot: source,
			repository: { owner: "acme", name: "widget", defaultBranch: "main" },
			commit,
			allowlist: ["src/**"],
			stagingRoot,
		});
		const { artifact } = await buildStructureArtifact({
			stagingRoot,
			staged,
			indexer,
		});
		expect(artifact.commit).toBe(commit);
		expect(artifact.files.map((file) => file.path)).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
		expect(artifact.withheld).toEqual({ sensitive: 1, unsafe: 0 });
		const a = artifact.files[0]?.id ?? "";
		const b = artifact.files[1]?.id ?? "";
		expect(edge(artifact, "imports", a, b)).toBe(true);
		expect(
			edge(
				artifact,
				"calls",
				symbolNamed(artifact, "a").id,
				symbolNamed(artifact, "b").id,
			),
		).toBe(true);
	});
});

describe("golden artifact", () => {
	it("keeps a pinned hash for a fixed input", async () => {
		// Change detector for format, ordering, IDs and hashing. If this moves on
		// purpose, bump the schema or indexer version and re-pin deliberately.
		const { sha256: hash, artifact } = await build({
			"src/a.ts":
				'import { b } from "./b";\nexport class A {\n  run() { return b(); }\n}\n',
			"src/b.ts": "export function b() {}\n",
			"pkg/m.py": "import os\nclass M:\n    def go(self):\n        return 1\n",
			"README.md": "# fixture\n",
		});
		expect(artifact.symbols.map((symbol) => symbol.name)).toEqual([
			"M",
			"go",
			"A",
			"run",
			"b",
		]);
		expect(hash).toBe(
			"5f42faf8288ddefb707d45581f4412d18a4c707cbe6661038664ba405155bc45",
		);
	});
});

describe("server contract fixture", () => {
	// The backend validator is tested against exactly this artifact
	// (backend/tests/fixtures/project_context/structure-artifact-v1.json),
	// pinned by the same hash on both sides. Regenerate deliberately with
	// CONTRACT_FIXTURE_OUT=<path> when the format changes on purpose.
	const files = {
		"src/app.ts": [
			'import { helper } from "./util";',
			'import React from "react";',
			'import "./missing";',
			"export interface Shape { area(): number }",
			"export class Box implements Shape {",
			"  area() { return this.size(); }",
			"  size() { return 1; }",
			"}",
			"export function run(cb: () => void, { render }: any) {",
			"  const b = new Box();",
			"  b.area(); cb(); render(); helper(); local();",
			"  const s: Shape = b;",
			"}",
			"function local() {}",
			"",
		].join("\n"),
		"src/util/index.ts": "export function helper() { return shared(); }\n",
		"src/a.js": "export function shared() {}\n",
		"src/b.js": "export function shared() {}\n",
		"src/broken.ts": "export function ok() {}\nfunction broken( {\n",
		"pkg/__init__.py": "",
		"pkg/settings.py": 'API_TOKEN = "x"\n',
		"pkg/core.py": [
			"import os",
			"from . import settings",
			"class Engine:",
			"    def start(self, *args):",
			"        self.stop()",
			"        args.go()",
			"        return Engine()",
			"    def stop(self):",
			"        pass",
			"",
		].join("\n"),
		"src/README.md": "# not indexed\n",
	};

	it("matches the artifact the backend validator is tested against", async () => {
		const { json, sha256: hash } = await build(files, {
			extras: {
				skipped: [{ path: "src/logo.ts", reason: "binary" }],
				sensitiveSkipped: 1,
				unsafeSkipped: 2,
			},
		});
		if (process.env.CONTRACT_FIXTURE_OUT) {
			writeFileSync(process.env.CONTRACT_FIXTURE_OUT, json);
		}
		expect(hash).toBe(
			"9dc0298c995963b190c69324b1a8f23e0ee8dbb25b1e2ce13fcd0ea035a685dc",
		);
	});
});
