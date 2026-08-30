import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let parsedPackage: unknown;
try {
	parsedPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
} catch (error) {
	throw new Error("package.json must contain valid JSON", { cause: error });
}
if (typeof parsedPackage !== "object" || parsedPackage === null) {
	throw new Error("package.json must contain an object");
}
const pkg = parsedPackage as Record<string, any>;
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const path of temporaryRoots.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("standalone package", () => {
	it("is a standalone Runner, not a Pi extension package", () => {
		expect(pkg.name).toBe("@takonaut/tako-runner");
		expect(pkg.pi).toBeUndefined();
		expect(pkg.license).toBe("Apache-2.0");
		expect(pkg.bin).toEqual({
			"tako-runner": "./src/runner-cli.ts",
			"takonaut-runner": "./src/runner-cli.ts",
		});
	});

	it("publishes version flags and service guidance as v0.2.3", () => {
		expect(pkg.version).toBe("0.2.3");
	});

	it.each(["--version", "-V"])(
		"prints the package version for %s without loading Runner configuration",
		(flag) => {
			const temporaryRoot = mkdtempSync(join(tmpdir(), "tako-runner-version-"));
			temporaryRoots.push(temporaryRoot);
			const result = spawnSync(
				"bun",
				[join(root, "src", "runner-cli.ts"), flag],
				{
					cwd: root,
					encoding: "utf8",
					env: {
						...process.env,
						TAKONAUT_RUNNER_CONFIG: join(temporaryRoot, "missing.json"),
						TAKONAUT_RUNNER_CREDENTIALS: join(
							temporaryRoot,
							"missing-credentials.json",
						),
					},
				},
			);

			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe(`tako-runner ${pkg.version}`);
			expect(result.stderr).toBe("");
		},
	);

	it("accepts machine credentials only through the environment", () => {
		const temporaryRoot = mkdtempSync(join(tmpdir(), "tako-runner-token-"));
		temporaryRoots.push(temporaryRoot);
		const configPath = join(temporaryRoot, "runner.json");
		const credentialPath = join(temporaryRoot, "runner-credentials.json");
		const baseEnv: NodeJS.ProcessEnv = {
			...process.env,
			TAKONAUT_RUNNER_CONFIG: configPath,
			TAKONAUT_RUNNER_CREDENTIALS: credentialPath,
		};
		delete baseEnv.TAKONAUT_RUNNER_TOKEN;
		const argumentSecret = ["tkr", "argument", "secret"].join("_");
		const environmentSecret = ["tkr", "environment", "secret"].join("_");

		const argumentResult = spawnSync(
			"bun",
			[
				join(root, "src", "runner-cli.ts"),
				"configure",
				"--url",
				"https://takonaut.app",
				"--org",
				"org-1",
				"--token",
				argumentSecret,
			],
			{ cwd: root, env: baseEnv, encoding: "utf8" },
		);
		expect(argumentResult.status).toBe(2);
		expect(argumentResult.stderr).not.toContain("--token");
		expect(argumentResult.stderr).not.toContain(argumentSecret);
		expect(existsSync(credentialPath)).toBe(false);

		const environmentResult = spawnSync(
			"bun",
			[
				join(root, "src", "runner-cli.ts"),
				"configure",
				"--url",
				"https://takonaut.app",
				"--org",
				"org-1",
			],
			{
				cwd: root,
				env: { ...baseEnv, TAKONAUT_RUNNER_TOKEN: environmentSecret },
				encoding: "utf8",
			},
		);
		expect(environmentResult.status).toBe(0);
		expect(environmentResult.stdout).not.toContain(environmentSecret);
		expect(readFileSync(credentialPath, "utf8")).toContain(environmentSecret);
	}, 15_000);

	it("pins the compatible Pi runtime suite", () => {
		for (const name of [
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
		]) {
			expect(pkg.dependencies[name]).toBe("0.84.0");
		}
	});

	it("publishes signed-off tag assets as a public GitHub release", () => {
		const releaseWorkflow = readFileSync(
			join(root, ".github", "workflows", "release.yml"),
			"utf8",
		);
		expect(releaseWorkflow).toContain("contents: write");
		expect(releaseWorkflow).toContain("GH_TOKEN: ${{ github.token }}");
		expect(releaseWorkflow).toContain('gh release create "$GITHUB_REF_NAME"');
		expect(releaseWorkflow).toContain("--notes-from-tag");
	});

	it("runs from a production-only packed installation", () => {
		const temporaryRoot = mkdtempSync(join(tmpdir(), "tako-runner-pack-"));
		temporaryRoots.push(temporaryRoot);
		const packed = join(temporaryRoot, "packed");
		const extracted = join(temporaryRoot, "extracted");
		mkdirSync(packed);
		mkdirSync(extracted);
		execFileSync("bun", ["pm", "pack", "--destination", packed, "--quiet"], {
			cwd: root,
			stdio: "pipe",
		});
		const archive = readdirSync(packed).find((name) => name.endsWith(".tgz"));
		expect(archive).toBeDefined();
		execFileSync("tar", ["-xzf", join(packed, archive!), "-C", extracted]);
		const installed = join(extracted, "package");
		execFileSync("bun", ["install", "--production", "--frozen-lockfile"], {
			cwd: installed,
			stdio: "pipe",
		});
		const result = spawnSync("bun", [join(installed, "src", "runner-cli.ts")], {
			cwd: installed,
			encoding: "utf8",
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("tako-runner setup");
		expect(result.stderr).toContain("tako-runner configure");
		expect(result.stderr).toContain("tako-runner enroll");
		expect(result.stderr).toContain("tako-runner login");
		expect(result.stderr).toContain(
			"tako-runner map PROJECT_ID REPOSITORY_ROOT --repository-id REPOSITORY_ID",
		);
	}, 90_000);
});
