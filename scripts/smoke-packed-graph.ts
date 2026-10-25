#!/usr/bin/env bun
/**
 * Packed-install smoke test for graph builds. Installs a release archive the
 * way the Homebrew formula does, then runs one graph build end to end from
 * the installed copy: the hidden __graph-worker, the vendored grammars and
 * their pinned hashes. Local only: a temporary Git repository and an
 * in-process fake Takonaut API.
 *
 *   bun scripts/smoke-packed-graph.ts [path/to/tako-runner-x.y.z.tgz]
 */

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "tako-runner-smoke-"));
const run = (command: string, args: string[], cwd = root) =>
	execFileSync(command, args, { cwd, encoding: "utf8" }).trim();

try {
	let archive = process.argv[2] ? resolve(process.argv[2]) : undefined;
	if (!archive) {
		const dist = join(root, "dist");
		run("bun", ["pm", "pack", "--destination", dist, "--quiet"], packageRoot);
		const [packed] = readdirSync(dist).filter((name) => name.endsWith(".tgz"));
		if (!packed) throw new Error("bun pm pack produced no archive");
		archive = join(dist, packed);
	}
	const install = join(root, "install");
	mkdirSync(install);
	run("tar", ["-xzf", archive, "-C", install, "--strip-components=1"]);
	run("bun", ["install", "--production", "--frozen-lockfile"], install);

	const remote = join(root, "remote.git");
	const source = join(root, "source");
	run("git", ["init", "--quiet", "--bare", remote]);
	run("git", ["init", "--quiet", "-b", "main", source]);
	const git = (...args: string[]) => run("git", ["-C", source, ...args]);
	git("config", "user.name", "Runner Smoke");
	git("config", "user.email", "runner@smoke.invalid");
	git("config", "commit.gpgsign", "false");
	const files: Record<string, string> = {
		"src/a.ts":
			'import { b } from "./b";\nexport function a() { return b(); }\n',
		"src/b.ts": "export function b() {}\n",
		"src/c.js": "function c() {}\n",
		"src/d.py": "def d():\n    pass\n",
	};
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(source, path)), { recursive: true });
		writeFileSync(join(source, path), content);
	}
	git("add", "-A");
	git("commit", "--quiet", "-m", "smoke");
	git("remote", "add", "origin", "https://github.com/acme/widget.git");
	// Any fetch goes to the local bare repository, never the network.
	git(
		"config",
		`url.${remote}.insteadOf`,
		"https://github.com/acme/widget.git",
	);
	git("push", "--quiet", "origin", "HEAD:main");
	const commit = git("rev-parse", "HEAD");

	// Runs from the installed copy so imports resolve against its own files.
	const driver = join(install, "smoke-driver.ts");
	writeFileSync(
		driver,
		`import { GRAPH_EXTRACTOR_CONFIG_HASH, processGraphClaim, runSupervisedGraphWorker } from "./src/graph-build.ts";
const id = crypto.randomUUID();
const claim = {
	build_id: crypto.randomUUID(), project_id: crypto.randomUUID(),
	repository_id: id,
	repository: { id, owner: "acme", name: "widget", default_branch: "main" },
	commit_sha: ${JSON.stringify(commit)}, attempt_id: crypto.randomUUID(),
	lease_expires_at: new Date(Date.now() + 90_000).toISOString(),
	path_allowlist: ["src/**"], policy_revision: 1, access_epoch: 0,
	extractor: "tako-structure/1", extractor_config_hash: GRAPH_EXTRACTOR_CONFIG_HASH,
	schema_version: 1,
};
const failures = [];
let artifact;
const outcome = await processGraphClaim(claim, {
	api: {
		heartbeatGraphBuild: async () => ({ active: true }),
		failGraphBuild: async (_claim, code) => { failures.push(code); return null; },
	},
	repositoryRoot: () => ${JSON.stringify(source)},
	extract: (input, signal) => runSupervisedGraphWorker(input, signal),
	publish: async (_claim, file) => { artifact = JSON.parse(file.bytes.toString("utf8")); },
}, { workRootBase: ${JSON.stringify(join(root, "work"))} });
console.log(JSON.stringify({
	outcome, failures, indexer: artifact?.indexer, commit: artifact?.commit,
	coverage: artifact?.coverage.map((entry) => entry.path + ":" + entry.reason),
	edges: artifact?.edges.length ?? 0,
}));
`,
	);
	const result = JSON.parse(run("bun", [driver], install));
	const expected = {
		outcome: "published",
		failures: [],
		indexer: "tako-structure/1",
		commit,
		coverage: ["src/a.ts:ok", "src/b.ts:ok", "src/c.js:ok", "src/d.py:ok"],
	};
	for (const [key, value] of Object.entries(expected)) {
		if (JSON.stringify(result[key]) !== JSON.stringify(value)) {
			throw new Error(
				`Packed graph smoke failed on ${key}: ${JSON.stringify(result)}`,
			);
		}
	}
	if (!(result.edges > 0))
		throw new Error("Packed graph smoke produced no edges");
	console.log(`Packed graph smoke passed: ${JSON.stringify(result)}`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
