import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	StructureIndexError,
	createStructureIndexer,
	languageForPath,
	type StructureIndexer,
} from "../src/structure-index";

// Vendored WebAssembly grammars only: no network, provider or AI runtime.
const grammarRoot = fileURLToPath(new URL("../grammars", import.meta.url));
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

let indexer: StructureIndexer;
beforeAll(async () => {
	indexer = await createStructureIndexer();
});

const symbols = (path: string, source: string) =>
	indexer
		.extract(path, source)
		.symbols.map((s) => `${s.kind} ${s.name} ${s.startLine}-${s.endLine}`);

const references = (path: string, source: string) =>
	indexer
		.extract(path, source)
		.references.filter((r) => r.kind !== "binding")
		.map((r) => `${r.kind} ${r.name}@${r.line}`);

describe("language detection", () => {
	it.each([
		["src/a.ts", "typescript"],
		["src/a.mts", "typescript"],
		["src/a.cts", "typescript"],
		["src/a.d.ts", "typescript"],
		["src/a.tsx", "tsx"],
		["src/a.js", "javascript"],
		["src/a.mjs", "javascript"],
		["src/a.cjs", "javascript"],
		["src/a.jsx", "javascript"],
		["pkg/a.py", "python"],
		["README.md", null],
		["Makefile", null],
		["src/a.TS", null],
	])("%s is %s", (path, language) => {
		expect(languageForPath(path)).toBe(language);
	});
});

describe("TypeScript structure", () => {
	const source = [
		'import { b } from "./b";',
		'export { c } from "./c";',
		"export interface Shape {",
		"  area(): number;",
		"}",
		"export class Greeter implements Shape {",
		"  area() { return 1; }",
		"  greet(name: string) {",
		"    return b(name);",
		"  }",
		"}",
		"export function hello() {",
		'  new Greeter().greet("x");',
		"}",
		"const arrow = () => hello();",
		"",
	].join("\n");

	it("finds definitions with kinds and 1-based line spans", () => {
		expect(symbols("src/greeter.ts", source)).toEqual([
			"interface Shape 3-5",
			"method area 4-4",
			"class Greeter 6-11",
			"method area 7-7",
			"method greet 8-10",
			"function hello 12-14",
			"function arrow 15-15",
		]);
	});

	it("finds imports, re-exports, calls and constructions once each", () => {
		expect(references("src/greeter.ts", source)).toEqual([
			"import ./b@1",
			"import ./c@2",
			"call b@9",
			"class Greeter@13",
			"call greet@13",
			"call hello@15",
		]);
	});

	it("parses TSX", () => {
		const tsx = "export const App = () => <div>{label()}</div>;\n";
		const result = indexer.extract("src/app.tsx", tsx);
		expect(result.language).toBe("tsx");
		expect(result.hasError).toBe(false);
		expect(symbols("src/app.tsx", tsx)).toEqual(["function App 1-1"]);
		expect(references("src/app.tsx", tsx)).toEqual(["call label@1"]);
	});
});

describe("JavaScript structure", () => {
	it("finds functions, classes, methods, calls and imports", () => {
		const source = [
			'import { b } from "./b.js";',
			"function run() { return b(); }",
			"class K { m() { run(); } }",
			"",
		].join("\n");
		expect(symbols("src/run.js", source)).toEqual([
			"function run 2-2",
			"class K 3-3",
			"method m 3-3",
		]);
		expect(references("src/run.js", source)).toEqual([
			"import ./b.js@1",
			"call b@2",
			"call run@3",
		]);
	});
});

describe("Python structure", () => {
	it("distinguishes methods from functions and records imports", () => {
		const source = [
			"import os.path",
			"from pkg import util",
			"from . import sibling",
			"class Box:",
			"    def open(self):",
			"        return util()",
			"def main():",
			"    Box().open()",
			"",
		].join("\n");
		expect(symbols("pkg/box.py", source)).toEqual([
			"class Box 4-6",
			"method open 5-6",
			"function main 7-8",
		]);
		expect(references("pkg/box.py", source)).toEqual([
			"import os.path@1",
			"import pkg@2",
			"import .@3",
			"call util@6",
			"call Box@8",
			"call open@8",
		]);
	});
});

describe("spans and lines", () => {
	const sliceBytes = (source: string, start: number, end: number) =>
		Buffer.from(source, "utf8").subarray(start, end).toString("utf8");

	it.each([
		[
			"non-ASCII text before it",
			'const s = "h\u00e9llo \u{1F600}";\nfunction f() {}\n',
		],
		["a byte-order mark", "\uFEFFfunction f() {}\n"],
	])("reports UTF-8 byte offsets with %s", (_label, source) => {
		const [symbol] = indexer
			.extract("src/x.ts", source)
			.symbols.filter((s) => s.name === "f");
		expect(symbol).toBeDefined();
		if (!symbol) return;
		expect(sliceBytes(source, symbol.startByte, symbol.endByte)).toBe(
			"function f() {}",
		);
	});

	it("places each reference at the UTF-8 offset of its name", () => {
		const source =
			'const s = "\u00e9\u{1F600}"; function f() { g(); new K(); }\n';
		const found = indexer
			.extract("src/x.ts", source)
			.references.map((r) => [
				r.name,
				sliceBytes(source, r.startByte, r.startByte + r.name.length),
			]);
		expect(found).toEqual([
			["g", "g"],
			["K", "K"],
		]);
	});

	it("classifies each call's receiver", () => {
		const calls = (path: string, source: string) =>
			indexer
				.extract(path, source)
				.references.filter((r) => r.kind === "call")
				.map((r) => [r.name, r.receiver]);
		expect(
			calls("src/x.ts", "class Q { m() { this.a(); x.b(); c(); d?.e(); } }\n"),
		).toEqual([
			["a", "self"],
			["b", "other"],
			["c", "none"],
			["e", "other"],
		]);
		expect(calls("pkg/x.py", "self.a()\nx.b()\nc()\ncls.d()\n")).toEqual([
			["a", "self"],
			["b", "other"],
			["c", "none"],
			["d", "self"],
		]);
	});

	it("records parameter and type parameter names as local bindings", () => {
		const bindings = (path: string, source: string) =>
			indexer
				.extract(path, source)
				.references.filter((r) => r.kind === "binding")
				.map((r) => r.name);
		expect(
			bindings(
				"src/x.ts",
				"function f<T>(a: T, b?: number, c = 1) {}\nconst g = (d) => d;\nconst h = e => e;\n",
			),
		).toEqual(["T", "a", "b", "c", "d", "e"]);
		expect(
			bindings("src/x.js", "function f(a, b = 1) {}\nconst g = c => c;\n"),
		).toEqual(["a", "b", "c"]);
		expect(
			bindings(
				"pkg/x.py",
				"def f(a, b=1, *, c: int, d: int = 2):\n    pass\ng = lambda e: e\n",
			),
		).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("records destructured and rest parameters as bindings", () => {
		const bindings = (path: string, source: string) =>
			indexer
				.extract(path, source)
				.references.filter((r) => r.kind === "binding")
				.map((r) => r.name);
		expect(
			bindings(
				"src/x.tsx",
				"function B({ render, onClick: click, size = 1 }: any, [x]: any[], ...cbs: any[]) {}\n",
			),
		).toEqual(["render", "click", "size", "x", "cbs"]);
		expect(
			bindings("src/x.js", "const C = ({ render }, [y], ...rest) => 0;\n"),
		).toEqual(["render", "y", "rest"]);
		expect(
			bindings("pkg/x.py", "def f(*handler, **hook):\n    pass\n"),
		).toEqual(["handler", "hook"]);
	});

	it("does not treat `this` inside a nested function as the class", () => {
		const receivers = indexer
			.extract(
				"src/x.ts",
				"class K { g() { [1].forEach(function () { this.a(); }); [1].forEach(() => this.b()); } }\n",
			)
			.references.filter((r) => r.kind === "call")
			.map((r) => [r.name, r.receiver]);
		expect(receivers).toEqual(
			expect.arrayContaining([
				["a", "other"],
				["b", "self"],
			]),
		);
	});

	it("matches TextEncoder for lone surrogates", () => {
		for (const source of [
			"// \ud800 x\nfunction f() {}\n",
			"// \udc00 x\nfunction f() {}\n",
		]) {
			const [symbol] = indexer.extract("src/x.ts", source).symbols;
			// TextEncoder is the WHATWG reference (lone surrogate -> U+FFFD, 3 bytes);
			// Bun's Buffer.byteLength counts 2 for it, Node's 3.
			expect(symbol?.endByte).toBe(new TextEncoder().encode(source).length - 1);
		}
	});

	it("counts lines correctly with CRLF endings", () => {
		const source = "function a() {}\r\n\r\nfunction b() {\r\n}\r\n";
		expect(symbols("src/crlf.ts", source)).toEqual([
			"function a 1-1",
			"function b 3-4",
		]);
	});
});

describe("module and declaration coverage", () => {
	it("records CommonJS, dynamic and TypeScript require imports", () => {
		const source = [
			'import x = require("y");',
			'const a = require("b");',
			'import("c");',
			"",
		].join("\n");
		expect(references("src/mods.ts", source)).toEqual([
			"import y@1",
			"import b@2",
			"import c@3",
		]);
		expect(references("src/mods.js", 'const a = require("b");\n')).toEqual([
			"import b@1",
		]);
	});

	it("records Python __future__ imports", () => {
		expect(
			references("pkg/f.py", "from __future__ import annotations\n"),
		).toEqual(["import __future__@1"]);
	});

	it("records type aliases, enums and namespaces", () => {
		const source = "type T = string;\nenum E { A }\nnamespace N {}\n";
		expect(symbols("src/decl.ts", source)).toEqual([
			"type T 1-1",
			"enum E 2-2",
			"module N 3-3",
		]);
	});

	it("names constructions by their class, not the expression text", () => {
		expect(
			references("src/new.ts", "new ns.Klass();\nnew (f())();\nnew Plain();\n"),
		).toEqual(["class Klass@1", "call f@2", "class Plain@3"]);
	});
});

describe("limits", () => {
	it("refuses a source over the size limit", async () => {
		const small = await createStructureIndexer({ maxSourceBytes: 64 });
		try {
			expect(() =>
				small.extract("src/big.ts", `// ${"x".repeat(100)}\n`),
			).toThrow(expect.objectContaining({ code: "oversize" }));
		} finally {
			small.dispose();
		}
	});

	it("stops a parse that exceeds its time budget", async () => {
		const hurried = await createStructureIndexer({ parseBudgetMs: 50 });
		try {
			// A parse longer than the budget is cancelled promptly.
			const source = "function f( {".repeat(20_000);
			const started = performance.now();
			expect(() => hurried.extract("src/slow.ts", source)).toThrow(
				expect.objectContaining({ code: "timeout" }),
			);
			expect(performance.now() - started).toBeLessThan(2_000);
		} finally {
			hurried.dispose();
		}
	});

	it("returns correct results for the next file after a timeout", async () => {
		// A cancelled parse must not leak its state into the next file.
		const hurried = await createStructureIndexer({ parseBudgetMs: 20 });
		const fresh = await createStructureIndexer();
		try {
			const large = Array.from(
				{ length: 9_000 },
				(_, i) => `export function f${i}(a: number) { return a + ${i}; }`,
			).join("\n");
			const followUps = [
				"function alpha() {}\nconst x = 1;\n",
				"import { y } from 'y';\nexport class K { m() {} }\n",
				"export const z = () => alpha();\n",
			];
			for (let round = 0; round < 4; round += 1) {
				for (const small of followUps) {
					// The parse stage, specifically: that is where state could leak.
					expect(() => hurried.extract("src/large.ts", large)).toThrow(
						expect.objectContaining({
							code: "timeout",
							message: "Parse exceeded its time budget",
						}),
					);
					expect(hurried.extract("src/small.ts", small)).toEqual(
						fresh.extract("src/small.ts", small),
					);
				}
			}
		} finally {
			hurried.dispose();
			fresh.dispose();
		}
	});

	it("cannot be used after dispose", async () => {
		const disposable = await createStructureIndexer();
		disposable.dispose();
		expect(() => disposable.extract("src/a.ts", "")).toThrow(
			StructureIndexError,
		);
	});
});

describe("robustness", () => {
	it("reports a syntax error and keeps what it could parse", () => {
		const result = indexer.extract(
			"src/broken.ts",
			"export function ok() {}\nexport function broken( {\n",
		);
		expect(result.hasError).toBe(true);
		expect(result.symbols.map((s) => s.name)).toContain("ok");
	});

	it("refuses an unsupported language", () => {
		expect(() => indexer.extract("README.md", "# hi\n")).toThrow(
			StructureIndexError,
		);
	});

	it("is deterministic across repeated runs and fresh indexers", async () => {
		const source = "export function a() { b(); }\nexport function b() {}\n";
		const fresh = await createStructureIndexer();
		try {
			expect(indexer.extract("src/x.ts", source)).toEqual(
				indexer.extract("src/x.ts", source),
			);
			expect(fresh.extract("src/x.ts", source)).toEqual(
				indexer.extract("src/x.ts", source),
			);
		} finally {
			fresh.dispose();
		}
	});

	it("loads an unmodified copy of the grammars", async () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-grammars-"));
		roots.push(root);
		cpSync(grammarRoot, root, { recursive: true });
		const copy = await createStructureIndexer({ grammarRoot: root });
		copy.dispose();
	});

	it.each([
		[
			"a modified query",
			(root: string) => {
				const tags = join(root, "javascript", "tags.scm");
				writeFileSync(tags, `${readFileSync(tags, "utf8")}\n; changed\n`);
			},
		],
		[
			"a missing grammar",
			(root: string) => {
				rmSync(join(root, "typescript", "tree-sitter-tsx.wasm"));
			},
		],
	])("refuses %s", async (_label, damage) => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-grammars-"));
		roots.push(root);
		cpSync(grammarRoot, root, { recursive: true });
		damage(root);
		await expect(
			createStructureIndexer({ grammarRoot: root }),
		).rejects.toMatchObject({
			code: "extractor_unavailable",
			message: expect.stringMatching(
				/Grammar file (is missing|does not match)/,
			),
		});
	});

	it("refuses a grammar whose bytes do not match the pinned hash", async () => {
		const root = mkdtempSync(join(tmpdir(), "takonaut-grammars-"));
		roots.push(root);
		cpSync(grammarRoot, root, { recursive: true });
		const wasm = join(root, "python", "tree-sitter-python.wasm");
		const bytes = readFileSync(wasm);
		bytes[bytes.length - 1] ^= 0xff;
		writeFileSync(wasm, bytes);
		await expect(
			createStructureIndexer({ grammarRoot: root }),
		).rejects.toMatchObject({ code: "extractor_unavailable" });
	});
});
