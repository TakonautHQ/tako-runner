import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
	GraphSourceError,
	checkGraphAllowlist,
	compileGraphAllowlist,
	matchesGraphAllowlist,
	stageGraphSources,
} from "../src/graph-sources";

// Real Git repositories; no network, extractor, provider or AI runtime.
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function write(root: string, path: string, content: string | Buffer) {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), content);
}

const sha256 = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");

/** A repository whose origin rewrites to a local bare remote. */
function repository(files: Record<string, string | Buffer>) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "takonaut-graph-src-")));
	roots.push(root);
	const remote = join(root, "remote.git");
	const source = join(root, "source");
	execFileSync("git", ["init", "--quiet", "--bare", remote]);
	execFileSync("git", ["init", "--quiet", "-b", "main", source]);
	git(source, "config", "user.name", "Runner Test");
	git(source, "config", "user.email", "runner@test.invalid");
	git(source, "config", "commit.gpgsign", "false");
	for (const [path, content] of Object.entries(files))
		write(source, path, content);
	git(source, "add", "-A");
	git(source, "commit", "--quiet", "-m", "first");
	git(source, "remote", "add", "origin", "https://github.com/acme/widget.git");
	git(
		source,
		"config",
		`url.${remote}.insteadOf`,
		"https://github.com/acme/widget.git",
	);
	git(source, "push", "--quiet", "origin", "HEAD:main");
	return { root, source, remote, commit: git(source, "rev-parse", "HEAD") };
}

const identity = { owner: "acme", name: "widget", defaultBranch: "main" };

function stage(
	repo: ReturnType<typeof repository>,
	overrides: Partial<Parameters<typeof stageGraphSources>[0]> = {},
) {
	return stageGraphSources({
		repositoryRoot: repo.source,
		repository: identity,
		commit: repo.commit,
		allowlist: ["src/**"],
		stagingRoot: join(repo.root, "staging"),
		...overrides,
	});
}

describe("graph allowlist", () => {
	it.each([
		[[]],
		[["/etc/**"]],
		[["../x"]],
		[["src/../secrets/**"]],
		[["src\\win"]],
		[["!src/**"]],
		[["~/src"]],
		[["C:/src"]],
		[["src/\u0001"]],
		[["./src"]],
		[["src//lib"]],
		[["src/"]],
		[["a".repeat(201)]],
		[Array.from({ length: 51 }, (_, i) => `d${i}/**`)],
	])("rejects the unsafe allowlist %j", (allowlist) => {
		expect(() => checkGraphAllowlist(allowlist)).toThrow(
			"Invalid graph path allowlist",
		);
	});

	it.each([
		["src/**", "src/a.ts", true],
		["src/**", "src/deep/b.py", true],
		["src/**", "srcx/a.ts", false],
		["src/**", "lib/src/a.ts", false],
		["src/*.ts", "src/a.ts", true],
		["src/*.ts", "src/deep/a.ts", false],
		["**/*.py", "a.py", true],
		["**/*.py", "pkg/mod/a.py", true],
		["lib", "lib/a.ts", true],
		["lib", "lib", true],
		["lib", "library/a.ts", false],
		["src/?.ts", "src/a.ts", true],
		["src/?.ts", "src/ab.ts", false],
		["src/[ab].ts", "src/a.ts", false],
		["src/[ab].ts", "src/[ab].ts", true],
		["a/**/b", "a/b", true],
		["a/**/b", "a/x/y/b", true],
		["a/**/b", "a/x/c", false],
		["**/**/x", "x", true],
		["**/**/x", "a/x", true],
		["**", "any/path.ts", true],
		["src/*x*x*", "src/axbxc", true],
		["src/*x*x*", "src/axb", false],
		// A literal star in a name must not consume the pattern's wildcard.
		["src/*a.ts", "src/*ba.ts", true],
		["x*y", "x*zy", true],
		["x*y", "x*z", false],
	])("pattern %s matching %s is %s", (pattern, path, expected) => {
		expect(matchesGraphAllowlist(path, [pattern])).toBe(expected);
	});
});

describe("graph allowlist matching cost", () => {
	it("stays fast on adversarial wildcard patterns and long names", () => {
		// The regular-expression matcher grew steeply: 648 ms already for a
		// 28-character single-segment name; 250 characters would never finish.
		const matcher = compileGraphAllowlist([
			"**********x",
			`src/${"*-".repeat(60)}.ts`,
		]);
		const started = performance.now();
		expect(matcher.matches("a".repeat(250))).toBe(false);
		expect(matcher.matches(`src/${"-a".repeat(120)}`)).toBe(false);
		expect(performance.now() - started).toBeLessThan(250);
	});

	it("matches a large tree against many patterns quickly", () => {
		const matcher = compileGraphAllowlist(
			Array.from({ length: 50 }, (_, i) => `pkg${i}/**/*.ts`),
		);
		const started = performance.now();
		let matched = 0;
		for (let i = 0; i < 100_000; i += 1)
			if (matcher.matches(`pkg${i % 60}/deep/dir/file${i}.ts`)) matched += 1;
		expect(matched).toBeGreaterThan(0);
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("checks entry length in code points like the server", () => {
		expect(checkGraphAllowlist(["\u{1F600}".repeat(150)])).toHaveLength(1);
	});
});

describe("graph source staging", () => {
	it("stages only allowlisted text files from the exact commit", async () => {
		const repo = repository({
			"src/app.ts": "export const app = 1;\n",
			"src/pkg/util.py": "def util():\n    return 1\n",
			"docs/readme.md": "outside the allowlist\n",
		});
		// Later commits and working-tree edits must not leak into the snapshot.
		write(repo.source, "src/app.ts", "export const app = 2;\n");
		git(repo.source, "commit", "--quiet", "-am", "second");
		write(repo.source, "src/app.ts", "uncommitted\n");
		write(repo.source, "src/untracked.ts", "untracked\n");

		const staged = await stage(repo);
		expect(staged.commit).toBe(repo.commit);
		expect(staged.files).toEqual([
			{
				path: "src/app.ts",
				size: 22,
				sha256: sha256("export const app = 1;\n"),
			},
			{
				path: "src/pkg/util.py",
				size: 25,
				sha256: sha256("def util():\n    return 1\n"),
			},
		]);
		expect(staged.skipped).toEqual([]);
		const stagingRoot = join(repo.root, "staging");
		expect(readFileSync(join(stagingRoot, "src/app.ts"), "utf8")).toBe(
			"export const app = 1;\n",
		);
		expect(existsSync(join(stagingRoot, "docs"))).toBe(false);
		expect(existsSync(join(stagingRoot, "src/untracked.ts"))).toBe(false);
		expect(statSync(stagingRoot).mode & 0o777).toBe(0o700);
		expect(statSync(join(stagingRoot, "src/app.ts")).mode & 0o777).toBe(0o600);
	});

	it("skips symlinks, binary, oversize, non-UTF-8 and sensitive files", async () => {
		const repo = repository({
			"src/ok.ts": "export {};\n",
			"src/blob.bin.ts": Buffer.from([0x61, 0x00, 0x62]),
			"src/huge.ts": "x".repeat(2048),
			"src/latin1.ts": Buffer.from([0x63, 0xe9, 0x0a]),
			"src/.env": "SECRET=1\n",
			"src/keys/server.pem": "-----BEGIN-----\n",
		});
		symlinkSync("ok.ts", join(repo.source, "src/link.ts"));
		git(repo.source, "add", "-A");
		git(repo.source, "commit", "--quiet", "-m", "link");
		const staged = await stage(
			{ ...repo, commit: git(repo.source, "rev-parse", "HEAD") },
			{ limits: { maxFileBytes: 1024 } },
		);
		expect(staged.files.map((file) => file.path)).toEqual(["src/ok.ts"]);
		expect(staged.skipped).toEqual([
			{ path: "src/blob.bin.ts", reason: "binary" },
			{ path: "src/huge.ts", reason: "oversize" },
			{ path: "src/latin1.ts", reason: "not_utf8" },
			{ path: "src/link.ts", reason: "symlink" },
		]);
		// Sensitive files are counted, never named.
		expect(staged.sensitiveSkipped).toBe(2);
		expect(existsSync(join(repo.root, "staging/src/link.ts"))).toBe(false);
	});

	it("reads raw blobs, never checking out (so filters and checkout hooks cannot run)", async () => {
		const repo = repository({
			"src/app.ts": "raw content\n",
			".gitattributes": "*.ts filter=evil\n",
		});
		const marker = join(repo.root, "hook-ran");
		git(
			repo.source,
			"config",
			"filter.evil.smudge",
			`touch ${marker}; tr a-z A-Z`,
		);
		git(repo.source, "config", "filter.evil.clean", "cat");
		const hook = join(repo.source, ".git/hooks/post-checkout");
		writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
		chmodSync(hook, 0o755);
		const staged = await stage(repo);
		expect(readFileSync(join(repo.root, "staging/src/app.ts"), "utf8")).toBe(
			"raw content\n",
		);
		expect(staged.files).toHaveLength(1);
		expect(existsSync(marker)).toBe(false);
	});

	it("fetches the default branch when the commit is not local", async () => {
		const repo = repository({ "src/app.ts": "one\n" });
		const other = join(repo.root, "other");
		execFileSync("git", ["clone", "--quiet", "-b", "main", repo.remote, other]);
		git(other, "config", "user.name", "Other");
		git(other, "config", "user.email", "other@test.invalid");
		git(other, "config", "commit.gpgsign", "false");
		write(other, "src/app.ts", "two\n");
		git(other, "commit", "--quiet", "-am", "remote only");
		git(other, "push", "--quiet", "origin", "HEAD:main");
		const remoteOnly = git(other, "rev-parse", "HEAD");
		// Fetch updates refs, which would run this repository-local hook.
		const marker = join(repo.root, "fetch-hook-ran");
		const hook = join(repo.source, ".git/hooks/reference-transaction");
		writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
		chmodSync(hook, 0o755);
		const staged = await stage(repo, { commit: remoteOnly });
		expect(staged.files[0]?.sha256).toBe(sha256("two\n"));
		expect(existsSync(marker)).toBe(false);
	});

	it("enforces file count and total size limits", async () => {
		const repo = repository({
			"src/a.ts": "a\n",
			"src/b.ts": "b\n",
			"src/c.ts": "c\n",
		});
		await expect(
			stage(repo, { limits: { maxFiles: 2 } }),
		).rejects.toMatchObject({
			code: "output_too_large",
		});
		await expect(
			stage(repo, {
				stagingRoot: join(repo.root, "staging-2"),
				limits: { maxTotalBytes: 4 },
			}),
		).rejects.toMatchObject({ code: "output_too_large" });
	});

	it("refuses a repository whose origin does not match", async () => {
		const repo = repository({ "src/app.ts": "x\n" });
		await expect(
			stage(repo, { repository: { ...identity, name: "other" } }),
		).rejects.toMatchObject({ code: "checkout_failed" });
	});

	it("refuses an unknown commit", async () => {
		const repo = repository({ "src/app.ts": "x\n" });
		await expect(stage(repo, { commit: "f".repeat(40) })).rejects.toMatchObject(
			{
				code: "checkout_failed",
			},
		);
	});

	it.each(["abc", "A".repeat(40), `${"a".repeat(40)}\n`])(
		"refuses the malformed commit %j without creating staging",
		async (commit) => {
			const repo = repository({ "src/app.ts": "x\n" });
			await expect(stage(repo, { commit })).rejects.toBeInstanceOf(
				GraphSourceError,
			);
			expect(existsSync(join(repo.root, "staging"))).toBe(false);
		},
	);

	it("refuses an existing staging directory", async () => {
		const repo = repository({ "src/app.ts": "x\n" });
		mkdirSync(join(repo.root, "staging"));
		await expect(stage(repo)).rejects.toThrow(
			"Graph staging directory already exists",
		);
	});
});

describe("graph source staging limit overrides", () => {
	it("treats an explicit undefined limit as the default", async () => {
		const repo = repository({
			"src/a.ts": "a\n",
			// Over the default per-file limit (512 KiB).
			"src/big.ts": "x".repeat(600 * 1024),
		});
		const staged = await stage(repo, {
			limits: {
				maxFiles: undefined,
				maxFileBytes: undefined,
				maxTotalBytes: undefined,
				maxListingBytes: undefined,
			},
		});
		expect(staged.files.map((file) => file.path)).toEqual(["src/a.ts"]);
		expect(staged.skipped).toEqual([
			{ path: "src/big.ts", reason: "oversize" },
		]);
	});

	it.each([
		["zero", { maxFiles: 0 }],
		["negative", { maxFileBytes: -1 }],
		["fractional", { maxTotalBytes: 1.5 }],
		["NaN", { maxListingBytes: Number.NaN }],
		["infinite", { maxFiles: Number.POSITIVE_INFINITY }],
	])(
		"rejects a %s limit before reading the repository",
		async (_label, limits) => {
			const repo = repository({ "src/a.ts": "a\n" });
			const stagingRoot = join(repo.root, "staging");
			await expect(stage(repo, { limits })).rejects.toThrow(
				"Invalid graph source limits",
			);
			expect(existsSync(stagingRoot)).toBe(false);
		},
	);
});

describe("graph source staging hardening", () => {
	it("does not fetch submodules while fetching the commit", async () => {
		const sub = repository({ "lib.ts": "one\n" });
		const repo = repository({ "src/app.ts": "x\n" });
		// Allow file transport so recursion would succeed if it were attempted.
		git(repo.source, "config", "protocol.file.allow", "always");
		git(
			repo.source,
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"--quiet",
			"-b",
			"main",
			sub.remote,
			"vendor/sub",
		);
		git(repo.source, "commit", "--quiet", "-m", "submodule");
		git(repo.source, "push", "--quiet", "origin", "HEAD:main");
		// A newer submodule commit, referenced only by a remote-only parent commit.
		write(sub.source, "lib.ts", "two\n");
		git(sub.source, "commit", "--quiet", "-am", "two");
		git(sub.source, "push", "--quiet", "origin", "HEAD:main");
		const newSub = git(sub.source, "rev-parse", "HEAD");
		const other = join(repo.root, "other");
		execFileSync("git", ["clone", "--quiet", "-b", "main", repo.remote, other]);
		git(other, "config", "user.name", "Other");
		git(other, "config", "user.email", "other@test.invalid");
		git(other, "config", "commit.gpgsign", "false");
		git(
			other,
			"update-index",
			"--add",
			"--cacheinfo",
			`160000,${newSub},vendor/sub`,
		);
		git(other, "commit", "--quiet", "-m", "bump");
		git(other, "push", "--quiet", "origin", "HEAD:main");
		const staged = await stage(repo, {
			commit: git(other, "rev-parse", "HEAD"),
			allowlist: ["src/**", "vendor/**"],
		});
		expect(staged.skipped).toEqual([
			{ path: "vendor/sub", reason: "submodule" },
		]);
		expect(() =>
			git(
				join(repo.source, "vendor/sub"),
				"cat-file",
				"-e",
				`${newSub}^{commit}`,
			),
		).toThrow();
	});

	it("skips names that collide on case-insensitive or normalizing filesystems", async () => {
		const repo = repository({ "src/ok.ts": "ok\n" });
		// Keep both Unicode forms in the tree (macOS Git precomposes by default).
		git(repo.source, "config", "core.precomposeUnicode", "false");
		const blob = execFileSync(
			"git",
			["-C", repo.source, "hash-object", "-w", "--stdin"],
			{
				input: "x\n",
				encoding: "utf8",
			},
		).trim();
		for (const path of [
			"src/Name.ts",
			"src/name.ts",
			"src/caf\u00e9.ts",
			"src/cafe\u0301.ts",
		])
			git(
				repo.source,
				"update-index",
				"--add",
				"--cacheinfo",
				`100644,${blob},${path}`,
			);
		git(repo.source, "commit", "--quiet", "-m", "collisions");
		const staged = await stage(repo, {
			commit: git(repo.source, "rev-parse", "HEAD"),
		});
		expect(staged.files.map((file) => file.path)).toEqual(["src/ok.ts"]);
		expect(staged.skipped.map((entry) => entry.reason)).toEqual([
			"name_collision",
			"name_collision",
			"name_collision",
			"name_collision",
		]);
	});

	it("counts paths with control characters without naming them", async () => {
		const repo = repository({ "src/ok.ts": "ok\n" });
		const blob = execFileSync(
			"git",
			["-C", repo.source, "hash-object", "-w", "--stdin"],
			{
				input: "x\n",
				encoding: "utf8",
			},
		).trim();
		git(
			repo.source,
			"update-index",
			"--add",
			"--cacheinfo",
			`100644,${blob},src/tab\there.ts`,
		);
		git(repo.source, "commit", "--quiet", "-m", "tab");
		const staged = await stage(repo, {
			commit: git(repo.source, "rev-parse", "HEAD"),
		});
		expect(staged.files.map((file) => file.path)).toEqual(["src/ok.ts"]);
		expect(staged.unsafeSkipped).toBe(1);
	});

	it("refuses an origin with more than one URL", async () => {
		const repo = repository({ "src/app.ts": "x\n" });
		git(
			repo.source,
			"config",
			"--add",
			"remote.origin.url",
			"https://gitlab.com/evil/x.git",
		);
		await expect(stage(repo)).rejects.toMatchObject({
			code: "checkout_failed",
		});
	});

	it("refuses a root that is not the repository top level", async () => {
		const repo = repository({ "src/app.ts": "x\n" });
		await expect(
			stage(repo, { repositoryRoot: join(repo.source, "src") }),
		).rejects.toMatchObject({ code: "checkout_failed" });
	});

	it.each(["../main", "main branch", "-delete"])(
		"refuses the unsafe default branch %j",
		async (defaultBranch) => {
			const repo = repository({ "src/app.ts": "x\n" });
			await expect(
				stage(repo, { repository: { ...identity, defaultBranch } }),
			).rejects.toMatchObject({ code: "checkout_failed" });
		},
	);

	it("reports a missing staging parent as an isolation failure", async () => {
		const repo = repository({ "src/app.ts": "x\n" });
		await expect(
			stage(repo, { stagingRoot: join(repo.root, "missing", "staging") }),
		).rejects.toMatchObject({ code: "isolation_failed" });
	});
});

describe("graph source staging limits on hostile trees", () => {
	function blobOf(repo: ReturnType<typeof repository>, content: string) {
		return execFileSync(
			"git",
			["-C", repo.source, "hash-object", "-w", "--stdin"],
			{
				input: content,
				encoding: "utf8",
			},
		).trim();
	}
	function mktree(repo: ReturnType<typeof repository>, entries: string) {
		return execFileSync("git", ["-C", repo.source, "mktree"], {
			input: entries,
			encoding: "utf8",
		}).trim();
	}
	function commitTree(repo: ReturnType<typeof repository>, tree: string) {
		return execFileSync(
			"git",
			["-C", repo.source, "commit-tree", tree, "-m", "hostile"],
			{
				encoding: "utf8",
			},
		).trim();
	}

	it("counts over-deep paths as unsafe and stays fast on wide, deep trees", async () => {
		const repo = repository({ "src/ok.ts": "ok\n" });
		const blob = blobOf(repo, "x\n");
		// A 300-level chain of directories (deduplicated by Git), reused 200 times.
		let tree = mktree(repo, `100644 blob ${blob}\tleaf.ts\n`);
		for (let depth = 0; depth < 300; depth += 1)
			tree = mktree(repo, `040000 tree ${tree}\td\n`);
		const wide = Array.from(
			{ length: 200 },
			(_, i) => `040000 tree ${tree}\tw${i}`,
		);
		const okTree = mktree(repo, `100644 blob ${blob}\tok.ts\n`);
		const src = mktree(
			repo,
			`${wide.join("\n")}\n040000 tree ${okTree}\tkeep\n`,
		);
		const root = mktree(repo, `040000 tree ${src}\tsrc\n`);
		const started = performance.now();
		const staged = await stage(repo, { commit: commitTree(repo, root) });
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(staged.files.map((file) => file.path)).toEqual(["src/keep/ok.ts"]);
		expect(staged.unsafeSkipped).toBe(200);
	}, 30_000); // About 300 git mktree calls build the tree; staging is timed separately.

	it("counts names too long to write as unsafe", async () => {
		const repo = repository({ "src/ok.ts": "ok\n" });
		const blob = blobOf(repo, "x\n");
		const src = mktree(
			repo,
			`100644 blob ${blob}\t${"n".repeat(300)}.ts\n100644 blob ${blob}\tok.ts\n`,
		);
		const staged = await stage(repo, {
			commit: commitTree(repo, mktree(repo, `040000 tree ${src}\tsrc\n`)),
		});
		expect(staged.files.map((file) => file.path)).toEqual(["src/ok.ts"]);
		expect(staged.unsafeSkipped).toBe(1);
	});

	it("counts paths that are not valid UTF-8 as unsafe", async () => {
		const repo = repository({ "src/ok.ts": "ok\n" });
		const blob = blobOf(repo, "x\n");
		const entries = Buffer.concat([
			Buffer.from(`100644 blob ${blob}\t`),
			Buffer.from([0xfe]),
			Buffer.from(".ts\n"),
			Buffer.from(`100644 blob ${blob}\tok.ts\n`),
		]);
		const src = execFileSync("git", ["-C", repo.source, "mktree"], {
			input: entries,
			encoding: "utf8",
		}).trim();
		const staged = await stage(repo, {
			commit: commitTree(repo, mktree(repo, `040000 tree ${src}\tsrc\n`)),
		});
		expect(staged.files.map((file) => file.path)).toEqual(["src/ok.ts"]);
		expect(staged.unsafeSkipped).toBe(1);
	});

	it.each([
		["\u00b5.ts", "\u03bc.ts"],
		["\u017f/a.ts", "s/b.ts"],
		["\u03c2.ts", "\u03c3.ts"],
		["\u03d0.ts", "\u03b2.ts"],
		["\u1e9e/a.ts", "\u00df/b.ts"],
	])("skips %s and %s, which collide on macOS", async (first, second) => {
		const repo = repository({ "src/ok.ts": "ok\n" });
		git(repo.source, "config", "core.precomposeUnicode", "false");
		const blob = blobOf(repo, "x\n");
		for (const path of [`src/${first}`, `src/${second}`])
			git(
				repo.source,
				"update-index",
				"--add",
				"--cacheinfo",
				`100644,${blob},${path}`,
			);
		git(repo.source, "commit", "--quiet", "-m", "fold");
		const staged = await stage(repo, {
			commit: git(repo.source, "rev-parse", "HEAD"),
		});
		expect(staged.files.map((file) => file.path)).toEqual(["src/ok.ts"]);
		expect(staged.skipped.map((entry) => entry.reason)).toEqual([
			"name_collision",
			"name_collision",
		]);
	});

	it("maps an oversized tree listing to output_too_large", async () => {
		const repo = repository({ "src/a.ts": "a\n", "src/b.ts": "b\n" });
		await expect(
			stage(repo, { limits: { maxListingBytes: 16 } }),
		).rejects.toMatchObject({ code: "output_too_large" });
	});
});

describe("graph source staging edge limits", () => {
	function blobOf(repo: ReturnType<typeof repository>, content: string) {
		return execFileSync(
			"git",
			["-C", repo.source, "hash-object", "-w", "--stdin"],
			{
				input: content,
				encoding: "utf8",
			},
		).trim();
	}
	function mktree(repo: ReturnType<typeof repository>, entries: string) {
		return execFileSync("git", ["-C", repo.source, "mktree"], {
			input: entries,
			encoding: "utf8",
		}).trim();
	}
	function commitTree(repo: ReturnType<typeof repository>, tree: string) {
		return execFileSync(
			"git",
			["-C", repo.source, "commit-tree", tree, "-m", "edge"],
			{
				encoding: "utf8",
			},
		).trim();
	}
	function nested(
		repo: ReturnType<typeof repository>,
		segments: string[],
		leaf: string,
	) {
		const blob = blobOf(repo, "x\n");
		let tree = mktree(repo, `100644 blob ${blob}\t${leaf}\n`);
		for (const segment of [...segments].reverse())
			tree = mktree(repo, `040000 tree ${tree}\t${segment}\n`);
		return tree;
	}

	it("counts a path over 1,024 bytes as unsafe even with short segments", async () => {
		const repo = repository({ "src/ok.ts": "ok\n" });
		const deep = nested(
			repo,
			Array.from({ length: 5 }, (_, i) => `${i}${"d".repeat(219)}`),
			"f.ts",
		);
		const okBlob = blobOf(repo, "ok\n");
		const src = mktree(
			repo,
			`040000 tree ${deep}\tlong\n100644 blob ${okBlob}\tok.ts\n`,
		);
		const staged = await stage(repo, {
			commit: commitTree(repo, mktree(repo, `040000 tree ${src}\tsrc\n`)),
			// The cap must reject it before it counts as a candidate, on every OS.
			limits: { maxFiles: 1 },
		});
		expect(staged.files.map((file) => file.path)).toEqual(["src/ok.ts"]);
		expect(staged.unsafeSkipped).toBe(1);
	});

	it("applies file limits before skipping colliding names", async () => {
		const repo = repository({ "src/b.ts": "b\n" });
		const blob = blobOf(repo, "x\n");
		git(
			repo.source,
			"update-index",
			"--add",
			"--cacheinfo",
			`100644,${blob},src/A.ts`,
		);
		git(
			repo.source,
			"update-index",
			"--add",
			"--cacheinfo",
			`100644,${blob},src/a.ts`,
		);
		git(repo.source, "commit", "--quiet", "-m", "pair");
		await expect(
			stage(repo, {
				commit: git(repo.source, "rev-parse", "HEAD"),
				limits: { maxFiles: 2 },
			}),
		).rejects.toMatchObject({ code: "output_too_large" });
	});

	it("skips a file whose parent is also a file in the same tree", async () => {
		const repo = repository({ "src/ok.ts": "ok\n" });
		const blob = blobOf(repo, "x\n");
		const inner = mktree(repo, `100644 blob ${blob}\tc.ts\n`);
		const src = execFileSync(
			"git",
			["-C", repo.source, "mktree", "--missing"],
			{
				input: `100644 blob ${blob}\tb\n040000 tree ${inner}\tb\n100644 blob ${blob}\tok.ts\n`,
				encoding: "utf8",
			},
		).trim();
		const staged = await stage(repo, {
			commit: commitTree(repo, mktree(repo, `040000 tree ${src}\tsrc\n`)),
			allowlist: ["src/**"],
		});
		expect(staged.skipped).toContainEqual({
			path: "src/b/c.ts",
			reason: "name_collision",
		});
		expect(staged.files.map((file) => file.path)).toContain("src/b");
	});

	it("counts a name the filesystem cannot write as unsafe", async () => {
		const repo = repository({ "src/ok.ts": "ok\n" });
		// 3 x 255-byte directories plus a long name: within the 1,024-byte
		// relative cap, beyond PATH_MAX once the staging root is prefixed.
		const segments = Array.from(
			{ length: 3 },
			(_, i) => `${i}${"p".repeat(254)}`,
		);
		const deep = nested(repo, segments, `${"n".repeat(200)}.ts`);
		const okBlob = blobOf(repo, "ok\n");
		const src = mktree(
			repo,
			`040000 tree ${deep}\tl\n100644 blob ${okBlob}\tok.ts\n`,
		);
		const parent = join(repo.root, "x".repeat(200));
		mkdirSync(parent);
		const staged = await stage(repo, {
			commit: commitTree(repo, mktree(repo, `040000 tree ${src}\tsrc\n`)),
			stagingRoot: join(parent, "staging"),
		});
		expect(staged.files.map((file) => file.path)).toContain("src/ok.ts");
		if (process.platform === "darwin") expect(staged.unsafeSkipped).toBe(1);
	});

	it("stops scanning the tree listing at its time budget", async () => {
		const repo = repository({ "src/a.ts": "a\n" });
		await expect(stage(repo, { scanBudgetMs: 0 })).rejects.toMatchObject({
			code: "timeout",
		});
	});
});
