#!/usr/bin/env bun

import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	defaultRunnerConfigPaths,
	loadRunnerDaemonConfig,
	prepareRunnerConfigStorage,
	RunnerApiClient,
	runRunnerDaemon,
	runRunnerOnce,
	saveRunnerDaemonConfig,
	setUnsafeRunnerAncestorOverride,
	type RunnerDaemonConfig,
} from "./runner";
import {
	normalizeRunnerEnrollmentServerUrl,
	runRunnerEnrollment,
	type RunnerEnrollmentHttpResult,
} from "./runner-enrollment";
import {
	applyRunnerSetupSelection,
	assertRunnerSetupRepositoryOrigin,
	detectRunnerRepository,
	matchRunnerSetupRepository,
	verifyRunnerRepositoryFetch,
	type DetectedRunnerRepository,
	type RunnerSetupCatalog,
} from "./runner-setup";

function value(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function cliColorsEnabled(): boolean {
	if ("NO_COLOR" in process.env) return false;
	if (process.env.FORCE_COLOR !== undefined)
		return process.env.FORCE_COLOR !== "0";
	return process.stderr.isTTY === true;
}

function color(code: string, text: string): string {
	return cliColorsEnabled() ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function renderCliError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const sectionHeadings = new Set([
		"Why this is required",
		"How to fix",
		"Then retry",
	]);
	const body = message
		.split("\n")
		.map((line, index) => {
			if (sectionHeadings.has(line)) return color("1;33", line);
			if (/^ {2}(?:cd|gh|git|tako-runner)\b/.test(line))
				return color("36", line);
			if (line === "No Runner was created.") return color("2", line);
			if (index === 0) return color("1", line);
			return line;
		})
		.join("\n");
	return `${color("1;31", "✗ Tako Runner could not continue")}\n\n${body}`;
}

function printInfo(message: string): void {
	console.error(`${color("1;34", "●")} ${color("1", message)}`);
}

function printSuccess(message: string): void {
	console.error(`${color("1;32", "✓")} ${message}`);
}

function printWarning(summary: string, detail: string): void {
	console.error(`${color("1;33", "⚠")} ${color("1;33", summary)}\n  ${detail}`);
}

function values(args: string[], name: string): string[] {
	return args.flatMap((arg, index) =>
		arg === name && args[index + 1] ? [args[index + 1] as string] : [],
	);
}

function usage(): never {
	console.error(`Usage:
  tako-runner setup [--url URL] [--org ORG_ID] [--path REPOSITORY_ROOT] [--repository-id ID] [--project-id ID] [--agent-id ID] [--all-agents] [--start-service] [--force]
  tako-runner configure --url URL --org ORG_ID [--poll-ms 2000] [--lease-seconds 90]
  tako-runner enroll [--url URL] [--name NAME] [--capacity 1] [--force]
  tako-runner login [enroll options]
  tako-runner map PROJECT_ID REPOSITORY_ROOT --repository-id REPOSITORY_ID [--agent-id AGENT_ID]
  tako-runner status
  tako-runner diagnostic-bundle [--output FILE]
  tako-runner once
  tako-runner start

Every command accepts --allow-unsafe-ancestor ABSOLUTE_PATH as a temporary,
exact-path override. It must be repeated for each invocation and does not bypass
ownership, symlink, credential-mode, or nested writable-directory checks.
TAKONAUT_RUNNER_TOKEN supplies the machine credential without exposing it in process arguments.`);
	process.exit(2);
}

function configure(args: string[]): void {
	const serverUrl = value(args, "--url");
	const organizationId = value(args, "--org");
	const credential = process.env.TAKONAUT_RUNNER_TOKEN;
	if (!serverUrl || !organizationId || !credential) usage();
	const config: RunnerDaemonConfig = {
		serverUrl,
		organizationId,
		credential,
		pollIntervalMs: Number(value(args, "--poll-ms") ?? 2_000),
		leaseSeconds: Number(value(args, "--lease-seconds") ?? 90),
		repositories: {},
	};
	saveRunnerDaemonConfig(config);
	console.log(`Configured Takonaut Runner for organization ${organizationId}.`);
}

function openBrowser(url: string): void {
	const command = process.platform === "darwin" ? "open" : "xdg-open";
	const child = spawn(command, [url], {
		detached: true,
		stdio: "ignore",
	});
	child.on("error", () => {});
	child.unref();
}

async function enrollmentFetch(
	serverUrl: string,
	method: "POST",
	path: string,
	body?: unknown,
): Promise<RunnerEnrollmentHttpResult> {
	const response = await fetch(new URL(path, serverUrl), {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: "error",
	});
	const text = await response.text();
	let json: unknown = {};
	if (text) {
		try {
			json = JSON.parse(text);
		} catch {
			json = { detail: "Takonaut returned a non-JSON response" };
		}
	}
	return { status: response.status, json };
}

async function enroll(args: string[]): Promise<void> {
	const serverUrl = normalizeRunnerEnrollmentServerUrl(
		value(args, "--url") ?? "https://takonaut.app",
	);
	const name = value(args, "--name") ?? hostname();
	const capacity = Number(value(args, "--capacity") ?? 1);
	const force = args.includes("--force");
	prepareRunnerConfigStorage(undefined, { allowExisting: force });

	const result = await runRunnerEnrollment(
		serverUrl,
		{ name, capacity },
		{
			fetchJson: (method, path, body) =>
				enrollmentFetch(serverUrl, method, path, body),
			sleep: (milliseconds) =>
				new Promise((resolve) => setTimeout(resolve, milliseconds)),
			log: (message) => console.error(message),
			openUrl: openBrowser,
		},
	);
	try {
		saveRunnerDaemonConfig({
			serverUrl: result.serverUrl,
			organizationId: result.organizationId,
			credential: result.credential,
			pollIntervalMs: 2_000,
			leaseSeconds: 90,
			repositories: {},
		});
	} catch (error) {
		throw new Error(
			`Runner ${result.runnerId} was created, but its credential could not be saved. ` +
				"Rotate or revoke it in Takonaut before trying again.",
			{ cause: error },
		);
	}
	console.log(
		`Enrolled Runner ${result.runnerId} for ${result.organizationName}.`,
	);
	for (const projectId of result.projects) {
		console.log(
			`Map approved Project ${projectId}: tako-runner map ${projectId} /absolute/path/to/repository`,
		);
	}
}

async function chooseSetupAgents(
	catalog: RunnerSetupCatalog,
	args: string[],
): Promise<string[]> {
	const explicit = values(args, "--agent-id");
	if (explicit.length > 0) return explicit;
	if (args.includes("--all-agents")) {
		return catalog.agents.map((agent) => agent.id);
	}
	if (catalog.agents.length === 1) {
		return [catalog.agents[0]?.id as string];
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(
			"Non-interactive setup requires --agent-id or --all-agents",
		);
	}
	console.error("Select allowed Agents (comma-separated numbers):");
	catalog.agents.forEach((agent, index) => {
		console.error(`  ${index + 1}. ${agent.name} (${agent.slug})`);
	});
	const prompt = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = await prompt.question("Agents: ");
		const selected = answer
			.split(",")
			.map((part) => Number(part.trim()) - 1)
			.filter((index) => Number.isInteger(index) && index >= 0)
			.map((index) => catalog.agents[index]?.id)
			.filter((agentId): agentId is string => Boolean(agentId));
		if (selected.length === 0) {
			throw new Error("Select at least one Agent");
		}
		return selected;
	} finally {
		prompt.close();
	}
}

async function verifyPiProviderAuthentication(): Promise<string[]> {
	let modelRuntime: ModelRuntime;
	try {
		modelRuntime = await ModelRuntime.create();
	} catch (error) {
		throw new Error(
			"Pi provider authentication or model configuration could not be read. Run pi as this operating-system user, use /login, then rerun setup.",
			{ cause: error },
		);
	}
	const providers = [
		...new Set(
			(await modelRuntime.getAvailable()).map((model) => model.provider),
		),
	].sort();
	if (providers.length === 0) {
		throw new Error(
			"No authenticated Pi model provider is available. Run pi as this operating-system user, use /login, confirm a model responds, then rerun setup.",
		);
	}
	return providers;
}

async function preflightRunnerSetup(
	args: string[],
): Promise<DetectedRunnerRepository> {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		throw new Error("Tako Runner setup supports only macOS and Linux");
	}
	const capacity = Number(value(args, "--capacity") ?? 1);
	if (!Number.isInteger(capacity) || capacity < 1 || capacity > 32) {
		throw new Error("Runner capacity must be an integer from 1 to 32");
	}
	const name = value(args, "--name") ?? hostname();
	if (!name.trim()) throw new Error("Runner name is required");
	const serverUrl = value(args, "--url");
	if (serverUrl) normalizeRunnerEnrollmentServerUrl(serverUrl);
	prepareRunnerConfigStorage(undefined, { allowExisting: true });

	printInfo("Checking local Runner prerequisites before enrollment…");
	const detected = detectRunnerRepository(
		value(args, "--path") ?? process.cwd(),
	);
	printSuccess(`Git repository: ${detected.root}`);
	printSuccess(`GitHub origin: ${detected.origin}`);
	verifyRunnerRepositoryFetch(detected.root);
	printSuccess("Git fetch access");
	const providers = await verifyPiProviderAuthentication();
	printSuccess(`Pi provider authentication: ${providers.join(", ")}`);
	printSuccess("Local preflight complete; starting Runner enrollment");
	return detected;
}

async function setup(args: string[]): Promise<void> {
	const detected = await preflightRunnerSetup(args);
	let config: RunnerDaemonConfig;
	try {
		config = loadRunnerDaemonConfig();
	} catch (error) {
		const paths = defaultRunnerConfigPaths();
		if (
			(existsSync(paths.configPath) || existsSync(paths.credentialPath)) &&
			!args.includes("--force")
		) {
			throw new Error(
				"Existing Runner configuration is invalid; inspect it or rerun setup with --force to replace it",
				{ cause: error },
			);
		}
		if (value(args, "--org") && process.env.TAKONAUT_RUNNER_TOKEN) {
			configure(args);
		} else {
			await enroll(args);
		}
		config = loadRunnerDaemonConfig();
	}

	const api = new RunnerApiClient(config);
	const catalog = await api.setupCatalog();
	const explicitRepositoryId = value(args, "--repository-id");
	const explicitMatch = explicitRepositoryId
		? catalog.projects
				.flatMap((project) =>
					project.repositories.map((repository) => ({
						projectId: project.id,
						projectName: project.name,
						repository,
					})),
				)
				.find((candidate) => candidate.repository.id === explicitRepositoryId)
		: undefined;
	const match = explicitRepositoryId
		? explicitMatch
		: matchRunnerSetupRepository(catalog, detected.origin);
	if (!match) {
		throw new Error("The selected repository is not approved for this Runner");
	}
	if (explicitRepositoryId) {
		assertRunnerSetupRepositoryOrigin(match.repository, detected.origin);
	}
	const explicitProjectId = value(args, "--project-id");
	if (explicitProjectId && explicitProjectId !== match.projectId) {
		throw new Error("The selected repository does not belong to that Project");
	}
	const existing = config.repositoryBindings?.[match.repository.id];
	if (
		existing &&
		(existing.projectId !== match.projectId ||
			existing.path !== detected.root) &&
		!args.includes("--force")
	) {
		throw new Error(
			"This repository already has a different binding; rerun with --force to replace it",
		);
	}
	const agentIds = await chooseSetupAgents(catalog, args);
	const knownAgents = new Set(catalog.agents.map((agent) => agent.id));
	if (agentIds.some((agentId) => !knownAgents.has(agentId))) {
		throw new Error(
			"One or more selected Agents are not enabled for this organization",
		);
	}

	verifyRunnerRepositoryFetch(detected.root);
	const configured = applyRunnerSetupSelection(config, {
		projectId: match.projectId,
		repositoryId: match.repository.id,
		repositoryPath: detected.root,
		agentIds,
	});
	saveRunnerDaemonConfig(configured);
	await new RunnerApiClient(configured).advertiseCapabilities();
	console.log(
		`Configured ${match.repository.owner}/${match.repository.name} for Project ${match.projectName} with ${agentIds.length} Agent(s).`,
	);

	if (args.includes("--start-service")) {
		execFileSync("brew", ["services", "start", "tako-runner"], {
			stdio: "inherit",
		});
	}
}

function mapRepository(args: string[]): void {
	const projectId = args[0];
	const rootValue = args[1];
	const repositoryId = value(args, "--repository-id");
	const agentIds = values(args, "--agent-id");
	if (!projectId || !rootValue) usage();
	const config = loadRunnerDaemonConfig();
	const root = realpathSync(rootValue);
	const topLevel = execFileSync(
		"git",
		["-C", root, "rev-parse", "--show-toplevel"],
		{
			encoding: "utf8",
		},
	).trim();
	if (realpathSync(topLevel) !== root) {
		throw new Error("Repository mapping must point to the Git top level");
	}
	saveRunnerDaemonConfig({
		...config,
		repositories: { ...config.repositories, [projectId]: root },
		repositoryBindings: repositoryId
			? {
					...(config.repositoryBindings ?? {}),
					[repositoryId]: { projectId, path: root },
				}
			: config.repositoryBindings,
		agentIds:
			agentIds.length > 0
				? [...new Set([...(config.agentIds ?? []), ...agentIds])].sort()
				: config.agentIds,
	});
	console.log(
		repositoryId
			? `Bound repository ${repositoryId} in Project ${projectId} to ${root}.`
			: `Mapped legacy Project ${projectId} to ${root}.`,
	);
}

function writeDiagnosticBundle(args: string[]): void {
	const config = loadRunnerDaemonConfig();
	const generatedAt = new Date().toISOString();
	const output =
		value(args, "--output") ??
		`tako-runner-diagnostics-${generatedAt.replace(/[:.]/g, "-")}.json`;
	const repositoryBindings = Object.entries(
		config.repositoryBindings ?? {},
	).map(([repositoryId, binding]) => ({
		repositoryId,
		projectId: binding.projectId,
	}));
	let serverOrigin: string;
	try {
		serverOrigin = new URL(config.serverUrl).origin;
	} catch (error) {
		throw new Error("Runner server URL is invalid; rerun tako-runner setup", {
			cause: error,
		});
	}
	const bundle = {
		schemaVersion: 1,
		generatedAt,
		platform: `${process.platform}-${process.arch}`,
		runtime: process.versions.bun
			? `bun-${process.versions.bun}`
			: `node-${process.version}`,
		serverOrigin,
		organizationId: config.organizationId,
		pollIntervalMs: config.pollIntervalMs,
		leaseSeconds: config.leaseSeconds,
		repositoryBindings,
		legacyProjectMappingCount: Object.keys(config.repositories).length,
		agentIds: [...(config.agentIds ?? [])].sort(),
	};
	writeFileSync(output, `${JSON.stringify(bundle, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	console.log(`Wrote privacy-safe diagnostic bundle to ${output}.`);
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	const unsafeAncestorFlag = "--allow-unsafe-ancestor";
	const unsafeAncestor = value(args, unsafeAncestorFlag);
	if (args.includes(unsafeAncestorFlag) && !unsafeAncestor) {
		throw new Error(`${unsafeAncestorFlag} requires an absolute path`);
	}
	if (unsafeAncestor) {
		const normalized = setUnsafeRunnerAncestorOverride(unsafeAncestor);
		printWarning(
			"Unsafe ancestor override enabled",
			`Temporarily accepting ${normalized}. Repeat this exact-path flag for every Runner command; all other path protections remain active.`,
		);
	}
	if (command === "setup") {
		await setup(args);
		return;
	}
	if (command === "configure") {
		configure(args);
		return;
	}
	if (command === "enroll" || command === "login") {
		await enroll(args);
		return;
	}
	if (command === "map") {
		mapRepository(args);
		return;
	}
	if (command === "diagnostic-bundle") {
		writeDiagnosticBundle(args);
		return;
	}
	if (command === "status") {
		const config = loadRunnerDaemonConfig();
		console.log(
			JSON.stringify(
				{
					serverUrl: config.serverUrl,
					organizationId: config.organizationId,
					pollIntervalMs: config.pollIntervalMs,
					leaseSeconds: config.leaseSeconds,
					repositories: config.repositories,
					repositoryBindings: config.repositoryBindings,
					agentIds: config.agentIds,
				},
				null,
				2,
			),
		);
		return;
	}
	if (command === "once") {
		process.exitCode = (await runRunnerOnce(loadRunnerDaemonConfig())) ? 0 : 3;
		return;
	}
	if (command === "start") {
		const controller = new AbortController();
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.once(signal, () => controller.abort());
		}
		await runRunnerDaemon(loadRunnerDaemonConfig(), {
			signal: controller.signal,
			log: (message) => console.error(message),
		});
		return;
	}
	usage();
}

main().catch((error: unknown) => {
	console.error(renderCliError(error));
	process.exitCode = 1;
});
