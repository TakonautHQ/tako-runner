import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyRunnerSetupSelection,
	assertRunnerSetupRepositoryOrigin,
	detectRunnerRepository,
	matchRunnerSetupRepository,
	promptRunnerSetupLine,
	selectRunnerSetupTrustedNative,
	type RunnerSetupCatalog,
	verifyRunnerRepositoryFetch,
} from "../src/runner-setup";
import type { RunnerDaemonConfig } from "../src/runner";

const catalog: RunnerSetupCatalog = {
	organization: { id: "org-1", name: "Acme" },
	runner: { id: "runner-1", name: "Build Mac", capacity: 2 },
	projects: [
		{
			id: "project-1",
			name: "Widget",
			key: "WID",
			repositories: [
				{
					id: "repo-1",
					owner: "Acme",
					name: "Widget",
					default_branch: "main",
				},
			],
		},
		{
			id: "project-2",
			name: "Other",
			key: "OTH",
			repositories: [
				{
					id: "repo-2",
					owner: "Acme",
					name: "Other",
					default_branch: "main",
				},
			],
		},
	],
};

const config: RunnerDaemonConfig = {
	serverUrl: "https://takonaut.test",
	organizationId: "org-1",
	credential: "tkr_secret",
	pollIntervalMs: 2_000,
	leaseSeconds: 90,
	repositories: {},
};

describe("interactive Runner setup", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	it("checks for origin before browser enrollment creates a Runner", () => {
		const repository = mkdtempSync(join(tmpdir(), "tako-runner-no-origin-"));
		const configDirectory = join(repository, "runner-config");
		roots.push(repository);
		execFileSync("git", ["init", repository], { stdio: "ignore" });

		const environment = { ...process.env };
		delete environment.NO_COLOR;
		environment.FORCE_COLOR = "1";
		environment.TAKONAUT_RUNNER_CONFIG = join(configDirectory, "runner.json");
		environment.TAKONAUT_RUNNER_CREDENTIALS = join(
			configDirectory,
			"runner-credentials.json",
		);
		environment.TAKONAUT_RUNNER_ALLOW_UNSAFE_ANCESTOR = "";
		const result = spawnSync(
			"bun",
			[
				fileURLToPath(new URL("../src/runner-cli.ts", import.meta.url)),
				"setup",
				"--url",
				"http://127.0.0.1:1",
				"--path",
				repository,
			],
			{ encoding: "utf8", env: environment },
		);
		const plainStderr = result.stderr.replace(/\u001b\[[0-9;]*m/g, "");

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("\u001b[");
		expect(plainStderr).toContain("✗ Tako Runner could not continue");
		expect(plainStderr).toContain('No Git remote named "origin" was found.');
		expect(plainStderr).toContain("Why this is required");
		expect(plainStderr).toContain("How to fix");
		expect(plainStderr).toContain(
			`git -C ${JSON.stringify(realpathSync(repository))} remote add origin git@github.com:OWNER/REPOSITORY.git`,
		);
		expect(plainStderr).toContain("No Runner was created.");
		expect(existsSync(join(configDirectory, "runner.json"))).toBe(false);
	}, 15_000);

	it("uses plain readable errors when color is disabled", () => {
		const repository = mkdtempSync(join(tmpdir(), "tako-runner-plain-error-"));
		const configDirectory = join(repository, "runner-config");
		roots.push(repository);
		execFileSync("git", ["init", repository], { stdio: "ignore" });
		const environment = { ...process.env };
		delete environment.FORCE_COLOR;
		environment.NO_COLOR = "1";
		environment.TAKONAUT_RUNNER_CONFIG = join(configDirectory, "runner.json");
		environment.TAKONAUT_RUNNER_CREDENTIALS = join(
			configDirectory,
			"runner-credentials.json",
		);

		const result = spawnSync(
			"bun",
			[
				fileURLToPath(new URL("../src/runner-cli.ts", import.meta.url)),
				"setup",
				"--url",
				"http://127.0.0.1:1",
				"--path",
				repository,
			],
			{ encoding: "utf8", env: environment },
		);

		expect(result.stderr).not.toContain("\u001b[");
		expect(result.stderr).toContain("✗ Tako Runner could not continue");
		expect(result.stderr).toContain("How to fix");
	});

	it("explains how to select a Git repository before setup", () => {
		const directory = mkdtempSync(join(tmpdir(), "tako-runner-not-git-"));
		roots.push(directory);

		expect(() => detectRunnerRepository(directory)).toThrow(
			/requires a Git repository.*--path/i,
		);
	});

	it("explains fetch authentication failures before enrollment", () => {
		const repository = mkdtempSync(join(tmpdir(), "tako-runner-no-fetch-"));
		roots.push(repository);
		execFileSync("git", ["init", repository], { stdio: "ignore" });
		execFileSync("git", [
			"-C",
			repository,
			"remote",
			"add",
			"origin",
			join(repository, "missing-remote.git"),
		]);

		expect(() => verifyRunnerRepositoryFetch(repository)).toThrow(
			/could not fetch origin.*GitHub authentication/i,
		);
	});

	it("matches the detected GitHub origin to an allowed repository", () => {
		const match = matchRunnerSetupRepository(
			catalog,
			"git@github.com:acme/widget.git",
		);

		expect(match).toMatchObject({
			projectId: "project-1",
			repository: { id: "repo-1" },
		});
	});

	it("rejects an explicit repository ID that does not match the local origin", () => {
		expect(() =>
			assertRunnerSetupRepositoryOrigin(
				catalog.projects[1]!.repositories[0]!,
				"git@github.com:acme/widget.git",
			),
		).toThrow(/does not match the detected origin/i);
	});

	it("writes repository bindings without local Agent authorization", () => {
		const configured = applyRunnerSetupSelection(config, {
			projectId: "project-1",
			repositoryId: "repo-1",
			repositoryPath: "/work/widget",
		});

		expect(configured).toEqual({
			...config,
			repositoryBindings: {
				"repo-1": { projectId: "project-1", path: "/work/widget" },
			},
		});
		expect(JSON.stringify(configured)).not.toContain("agentIds");
	});

	it("persists an explicit per-repository Trusted Native opt-in", () => {
		const configured = applyRunnerSetupSelection(config, {
			projectId: "project-1",
			repositoryId: "repo-1",
			repositoryPath: "/work/widget",
			trustedNative: true,
		});

		expect(configured.repositoryBindings?.["repo-1"]?.trustedNative).toBe(true);
	});

	it("fails safely when interactive input closes before the trust choice", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const answer = promptRunnerSetupLine(
			"Enable Trusted Native? [y/N]",
			input,
			output,
		);

		input.end();

		await expect(answer).rejects.toThrow(/input closed before a choice/i);
	});

	it("warns and asks before enabling Trusted Native during interactive setup", async () => {
		const warnings: string[] = [];
		const questions: string[] = [];

		const trustedNative = await selectRunnerSetupTrustedNative({
			interactive: true,
			explicit: undefined,
			existing: undefined,
			warn: (summary, detail) => warnings.push(`${summary}\n${detail}`),
			prompt: async (question) => {
				questions.push(question);
				return "yes";
			},
		});

		expect(trustedNative).toBe(true);
		expect(warnings.join("\n")).toMatch(/protected actions/i);
		expect(warnings.join("\n")).toMatch(/signing key/i);
		expect(warnings.join("\n")).toMatch(/separate.*Takonaut/i);
		expect(questions).toEqual([
			expect.stringMatching(/Enable Trusted Native.*\[y\/N\]/i),
		]);
	});

	it("defaults a fresh interactive setup to standard read-only mode", async () => {
		const trustedNative = await selectRunnerSetupTrustedNative({
			interactive: true,
			explicit: undefined,
			existing: undefined,
			warn: () => {},
			prompt: async () => "",
		});

		expect(trustedNative).toBe(false);
	});

	it("preserves an existing choice without prompting in non-interactive setup", async () => {
		let promptCount = 0;
		const trustedNative = await selectRunnerSetupTrustedNative({
			interactive: false,
			explicit: undefined,
			existing: true,
			warn: () => {},
			prompt: async () => {
				promptCount += 1;
				return "no";
			},
		});

		expect(trustedNative).toBe(true);
		expect(promptCount).toBe(0);
	});

	it("lets explicit setup flags bypass the Trusted Native prompt", async () => {
		let promptCount = 0;
		const trustedNative = await selectRunnerSetupTrustedNative({
			interactive: true,
			explicit: false,
			existing: true,
			warn: () => {},
			prompt: async () => {
				promptCount += 1;
				return "yes";
			},
		});

		expect(trustedNative).toBe(false);
		expect(promptCount).toBe(0);
	});

	it("rejects origins that are not approved for the Runner", () => {
		expect(() =>
			matchRunnerSetupRepository(
				catalog,
				"https://github.com/acme/private.git",
			),
		).toThrow(/not linked to an approved Project/i);
	});
});
