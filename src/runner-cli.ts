#!/usr/bin/env bun

import { SECRETS_USAGE, secretsCommand, toolsCommand } from "./tools-cli";
import { doctorToolChecks } from "./tools/catalog";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { modelDoctorChecks, openRunnerModels } from "./models";
import { MODELS_USAGE, modelsCommand } from "./models-cli";
import {
	defaultRunnerConfigPaths,
	loadRunnerDaemonConfig,
	prepareRunnerConfigStorage,
	assertRunnerNotStopped,
	clearRunnerStopMarker,
	defaultRunnerStopMarkerPath,
	writeRunnerStopMarker,
	RUNNER_VERSION,
	RunnerApiClient,
	runAnalysisWorker,
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
	countStaleGraphWorkRoots,
	runGraphOnce,
	runGraphWorker,
	sweepStaleGraphWorkRoots,
} from "./graph-build";
import {
	defaultConnectorsPath,
	loadConnectors,
	openConnectorTools,
	parseConnectorAdd,
	removeConnector,
	type RunnerConnector,
	saveConnector,
} from "./connectors";
import { readSupervisedRequest } from "./runner-supervisor";
import { detectSandbox } from "./sandbox";
import { pruneRunArchive } from "./run-archive";
import {
	defaultHome,
	doctorExitCode,
	freeBytes,
	runDoctor,
	type DoctorCheck,
} from "./runner-doctor";
import {
	defaultRepositoriesRoot,
	provisionRepositories,
	type ProvisionedRepository,
} from "./runner-provision";
import {
	applyRunnerSetupSelection,
	assertRunnerSetupRepositoryOrigin,
	detectRunnerRepository,
	matchRunnerSetupRepository,
	promptRunnerSetupLine,
	selectRunnerSetupTrustedNative,
	verifyRunnerRepositoryFetch,
	type DetectedRunnerRepository,
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
	console.error(
		`${color("1;33", "⚠")} ${color("1;33", summary)}\n  ${detail}`,
	);
}

function usage(): never {
	console.error(`Usage:
  tako-runner setup [--url URL] [--name NAME] [--capacity N] [--no-service]
        Enrolls this machine, clones every repository of the approved Projects
        into ~/.takonaut/repos, installs the background service and runs doctor.
  tako-runner doctor            check everything this Runner needs, with fixes
  tako-runner status [--json]   what this Runner is and what it can run
  tako-runner repos list | sync [--replace]
  tako-runner setup --path REPOSITORY_ROOT [--org ORG_ID] [--repository-id ID] [--project-id ID] [--trusted-native|--disable-trusted-native] [--start-service] [--force]
  tako-runner configure --url URL --org ORG_ID [--poll-ms 2000] [--lease-seconds 90]
  tako-runner enroll [--url URL] [--name NAME] [--capacity 1] [--force]
  tako-runner login [enroll options]
  tako-runner map PROJECT_ID REPOSITORY_ROOT --repository-id REPOSITORY_ID [--trusted-native|--disable-trusted-native]
  tako-runner status
  tako-runner diagnostic-bundle [--output FILE]
  tako-runner once
  tako-runner start
  tako-runner clear-stop   (after checking for leftover Runner/Pi processes)
  tako-runner connector add NAME [--description TEXT] [--env KEY=VALUE]... [--allow-tool TOOL]... [--timeout-ms N] -- COMMAND [ARGS...]
  tako-runner connector list | test NAME | remove NAME
${SECRETS_USAGE}
${MODELS_USAGE}

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
}

async function verifyPiProviderAuthentication(): Promise<string[]> {
	let modelRuntime: ModelRuntime;
	try {
		modelRuntime = (await openRunnerModels()).modelRuntime;
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

function printProvisioned(result: ProvisionedRepository): void {
	if (result.status === "failed") {
		printWarning(`${result.fullName} was not cloned`, result.reason ?? "");
	} else if (result.status === "kept") {
		printInfo(`${result.fullName}: keeping ${result.path}`);
	} else {
		printSuccess(`${result.fullName} ${result.status} → ${result.path}`);
	}
}

function printDoctor(checks: DoctorCheck[]): void {
	for (const check of checks) {
		const line = `${check.name}: ${check.detail}`;
		if (check.level === "ok") printSuccess(line);
		else printWarning(line, check.fix ? `Fix: ${check.fix}` : "");
	}
}

function serviceRunning(): boolean {
	try {
		execFileSync("pgrep", ["-f", "runner-cli.ts start"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function hasBrew(): boolean {
	try {
		execFileSync("brew", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function doctorChecks(): Promise<DoctorCheck[]> {
	return runDoctor({
		platform: process.platform,
		home: defaultHome(),
		loadConfig: () => loadRunnerDaemonConfig(),
		catalog: (config) => new RunnerApiClient(config).setupCatalog(),
		providers: () => verifyPiProviderAuthentication(),
		modelChecks: () => modelDoctorChecks(),
		gitFetchable: (path) => {
			try {
				execFileSync("git", ["-C", path, "fetch", "--dry-run", "--no-tags", "origin"], {
					stdio: "ignore",
					timeout: 30_000,
					env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
				});
				return true;
			} catch {
				return false;
			}
		},
		serviceRunning,
		stopMarkerExists: () => existsSync(defaultRunnerStopMarkerPath()),
		freeBytes,
		connectorNames: () => Object.keys(loadConnectors()),
		sandbox: () => detectSandbox(),
		toolChecks: () => doctorToolChecks(),
	});
}

async function syncRepositories(
	config: RunnerDaemonConfig,
	replace: boolean,
): Promise<{ config: RunnerDaemonConfig; failed: number }> {
	const catalog = await new RunnerApiClient(config).setupCatalog();
	if (catalog.projects.length === 0) {
		throw new Error(
			"No projects are approved for this Runner. In Takonaut open Settings → Agents → Runners, choose projects for this Runner, then run tako-runner repos sync.",
		);
	}
	printInfo(
		`Cloning repositories for ${catalog.projects.map((p) => p.name).join(", ")} into ${defaultRepositoriesRoot()}…`,
	);
	const { config: next, results } = provisionRepositories(config, catalog, {
		replace,
		log: printProvisioned,
	});
	saveRunnerDaemonConfig(next);
	await new RunnerApiClient(loadRunnerDaemonConfig()).advertiseCapabilities();
	return {
		config: next,
		failed: results.filter((result) => result.status === "failed").length,
	};
}

async function preflightManagedSetup(args: string[]): Promise<void> {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		throw new Error("Tako Runner setup supports only macOS and Linux");
	}
	const capacity = Number(value(args, "--capacity") ?? 1);
	if (!Number.isInteger(capacity) || capacity < 1 || capacity > 32) {
		throw new Error("Runner capacity must be an integer from 1 to 32");
	}
	const serverUrl = value(args, "--url");
	if (serverUrl) normalizeRunnerEnrollmentServerUrl(serverUrl);
	prepareRunnerConfigStorage(undefined, { allowExisting: true });
	printInfo("Checking local Runner prerequisites before enrollment…");
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
	} catch {
		throw new Error("Git is not installed. Install it (xcode-select --install or your package manager), then run setup again.");
	}
	printSuccess("Git");
	const providers = await verifyPiProviderAuthentication();
	printSuccess(`Pi provider authentication: ${providers.join(", ")}`);
}

async function loadOrEnroll(args: string[]): Promise<RunnerDaemonConfig> {
	try {
		return loadRunnerDaemonConfig();
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
		return loadRunnerDaemonConfig();
	}
}

async function managedSetup(args: string[]): Promise<void> {
	await preflightManagedSetup(args);
	const config = await loadOrEnroll(args);
	const { failed } = await syncRepositories(config, args.includes("--replace"));
	if (!args.includes("--no-service")) {
		if (hasBrew()) {
			execFileSync("brew", ["services", "restart", "tako-runner"], {
				stdio: "ignore",
			});
			printSuccess("Background service started (brew services)");
		} else {
			printWarning(
				"No Homebrew found; the service was not installed",
				"Run tako-runner start under your service manager (systemd --user, launchd).",
			);
		}
	}
	printInfo("Checking the Runner…");
	const checks = await doctorChecks();
	printDoctor(checks);
	if (failed > 0 || doctorExitCode(checks) !== 0) {
		process.exitCode = 1;
		printWarning("Setup finished with problems", "Fix the items above, then run tako-runner doctor.");
	} else {
		printSuccess("Ready. This Runner will pick up Agent runs for its projects.");
	}
}

async function setup(args: string[]): Promise<void> {
	if (!value(args, "--path") && !value(args, "--repository-id")) {
		await managedSetup(args);
		return;
	}
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
		args.includes("--trusted-native") &&
		args.includes("--disable-trusted-native")
	) {
		throw new Error("Choose only one Trusted Native repository mode");
	}
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
	verifyRunnerRepositoryFetch(detected.root);
	let explicitTrustedNative: boolean | undefined;
	if (args.includes("--trusted-native")) explicitTrustedNative = true;
	else if (args.includes("--disable-trusted-native"))
		explicitTrustedNative = false;
	const trustedNative = await selectRunnerSetupTrustedNative({
		interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
		explicit: explicitTrustedNative,
		existing: existing?.trustedNative,
		warn: printWarning,
		prompt: promptRunnerSetupLine,
	});
	const configured = applyRunnerSetupSelection(config, {
		projectId: match.projectId,
		repositoryId: match.repository.id,
		repositoryPath: detected.root,
		trustedNative,
	});
	saveRunnerDaemonConfig(configured);
	await new RunnerApiClient(configured).advertiseCapabilities();
	console.log(
		`Configured ${match.repository.owner}/${match.repository.name} for Project ${match.projectName}. Profile eligibility is managed in Takonaut.`,
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
	if (
		args.includes("--trusted-native") &&
		args.includes("--disable-trusted-native")
	) {
		throw new Error("Choose only one Trusted Native repository mode");
	}
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
					[repositoryId]: {
						projectId,
						path: root,
						trustedNative: args.includes("--trusted-native")
							? true
							: args.includes("--disable-trusted-native")
								? false
								: config.repositoryBindings?.[repositoryId]?.trustedNative,
					},
				}
			: config.repositoryBindings,
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
		// A count only: work roots hold staged customer sources.
		staleGraphWorkRoots: countStaleGraphWorkRoots(),
	};
	writeFileSync(output, `${JSON.stringify(bundle, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	console.log(`Wrote privacy-safe diagnostic bundle to ${output}.`);
}

const RESTART_HINT =
	"Restart the Runner (brew services restart tako-runner) so Takonaut sees the change, then grant the connector on an Agent Profile's Tools page.";

async function connectorCommand(args: string[]): Promise<void> {
	const [action, ...rest] = args;
	if (action === "add") {
		const { name, connector } = parseConnectorAdd(rest);
		saveConnector(name, connector);
		console.log(`Saved connector ${name} to ${defaultConnectorsPath()}.`);
		console.log(RESTART_HINT);
		return;
	}
	if (action === "list") {
		const connectors = loadConnectors();
		const names = Object.keys(connectors).sort();
		if (names.length === 0) {
			console.log("No connectors. Add one with: tako-runner connector add NAME -- COMMAND");
			return;
		}
		for (const name of names) {
			const connector = connectors[name] as RunnerConnector;
			// Environment values may be secrets; show only their names.
			const envKeys = Object.keys(connector.env).sort();
			console.log(
				`${name}\t${connector.command[0]}${envKeys.length ? `\tenv: ${envKeys.join(", ")}` : ""}${connector.description ? `\t${connector.description}` : ""}`,
			);
		}
		return;
	}
	if (action === "remove" && rest[0]) {
		console.log(removeConnector(rest[0]) ? `Removed connector ${rest[0]}. ${RESTART_HINT}` : `No connector named ${rest[0]}.`);
		return;
	}
	if (action === "test" && rest[0]) {
		const connector = loadConnectors()[rest[0]];
		if (!connector) throw new Error(`No connector named ${rest[0]}`);
		const session = await openConnectorTools(rest[0], connector);
		try {
			console.log(
				session.tools.length
					? `Connector ${rest[0]} started. Tools Agents can use:\n${session.tools.map((tool) => `  ${tool.name}`).join("\n")}`
					: `Connector ${rest[0]} started but exposes no read-only tools. Allow specific tools with --allow-tool.`,
			);
		} finally {
			await session.close();
		}
		return;
	}
	usage();
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (command === "__analysis-worker") {
		// Internal: supervised analysis child. One request line on stdin; stdin
		// EOF kills this process group. Exit explicitly: stdin stays open.
		try {
			process.exit(await runAnalysisWorker(await readSupervisedRequest()));
		} catch (error) {
			console.error(renderCliError(error));
			process.exit(70);
		}
	}
	if (command === "__graph-worker") {
		// Internal: supervised graph build child, same protocol as above.
		try {
			process.exit(await runGraphWorker(await readSupervisedRequest()));
		} catch (error) {
			console.error(renderCliError(error));
			process.exit(70);
		}
	}
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
	if (command === "connector") {
		await connectorCommand(args);
		return;
	}
	if (command === "secrets") {
		await secretsCommand(args);
		return;
	}
	if (command === "models") {
		await modelsCommand(args);
		return;
	}
	if (command === "tools") {
		await toolsCommand(args);
		return;
	}
	if (command === "setup") {
		await setup(args);
		return;
	}
	if (command === "doctor") {
		const checks = await doctorChecks();
		if (args.includes("--json")) console.log(JSON.stringify(checks, null, 2));
		else printDoctor(checks);
		process.exitCode = doctorExitCode(checks);
		return;
	}
	if (command === "repos") {
		const config = loadRunnerDaemonConfig();
		if (args[0] === "sync") {
			const { failed } = await syncRepositories(config, args.includes("--replace"));
			if (failed > 0) process.exitCode = 1;
			if (serviceRunning() && hasBrew()) {
				execFileSync("brew", ["services", "restart", "tako-runner"], { stdio: "ignore" });
			}
			return;
		}
		if (args[0] === "list" || args.length === 0) {
			for (const [id, binding] of Object.entries(config.repositoryBindings ?? {})) {
				console.log(`${binding.path}  (repository ${id})`);
			}
			return;
		}
		usage();
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
	if (command === "clear-stop") {
		console.log(
			clearRunnerStopMarker()
				? "Runner supervision stop cleared."
				: "No Runner supervision stop was set.",
		);
		return;
	}
	if (command === "status") {
		const config = loadRunnerDaemonConfig();
		const bindings = Object.entries(config.repositoryBindings ?? {});
		const summary = {
			server: config.serverUrl,
			organizationId: config.organizationId,
			service: serviceRunning() ? "running" : "not running",
			stopped: existsSync(defaultRunnerStopMarkerPath()),
			repositories: bindings.map(([id, binding]) => ({ id, path: binding.path })),
			connectors: Object.keys(loadConnectors()),
		};
		if (args.includes("--json")) {
			console.log(JSON.stringify(summary, null, 2));
			return;
		}
		console.log(`Server:       ${summary.server}`);
		console.log(`Service:      ${summary.service}${summary.stopped ? " (stopped itself; run tako-runner doctor)" : ""}`);
		console.log(`Repositories: ${bindings.length === 0 ? "none (run tako-runner repos sync)" : ""}`);
		for (const repository of summary.repositories) console.log(`  ${repository.path}`);
		console.log(`Connectors:   ${summary.connectors.join(", ") || "none"}`);
		console.log("Run tako-runner doctor for a full check.");
		return;
	}
	if (command === "once") {
		// Same supervision rules as the daemon, for one claim.
		assertRunnerNotStopped();
		const config = loadRunnerDaemonConfig();
		const api = new RunnerApiClient(config);
		const controller = new AbortController();
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.once(signal, () => controller.abort());
		}
		const stopped = (reason: string) => () =>
			writeRunnerStopMarker(defaultRunnerStopMarkerPath(), reason);
		const worked =
			(await runRunnerOnce(config, api, {
				signal: controller.signal,
				onTerminationUnconfirmed: stopped(
					"Analysis worker termination was not confirmed",
				),
			})) ||
			(await runGraphOnce(config, api, {
				signal: controller.signal,
				onTerminationUnconfirmed: stopped(
					"Graph worker termination was not confirmed",
				),
			}));
		process.exitCode = worked ? 0 : 3;
		return;
	}
	if (command === "start") {
		const controller = new AbortController();
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.once(signal, () => controller.abort());
		}
		const config = loadRunnerDaemonConfig();
		// Capacity is set in Takonaut; fall back to one Run at a time offline.
		let concurrency = 1;
		try {
			concurrency = (await new RunnerApiClient(config).setupCatalog()).runner.capacity;
		} catch (error) {
			console.error(
				`Runner could not read its capacity from Takonaut; running one at a time (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
			);
		}
		const pruned = pruneRunArchive();
		if (pruned > 0) console.error(`Runner removed ${pruned} archived Run(s) past retention`);
		console.error(
			`Runner ${RUNNER_VERSION} started; up to ${concurrency} Run(s) at once, plus one for Runs a person is waiting for`,
		);
		await runRunnerDaemon(config, {
			concurrency,
			interactiveSlot: true,
			control: true,
			signal: controller.signal,
			log: (message) => console.error(message),
			runGraphOnce,
			sweepGraphWorkRoots: () => sweepStaleGraphWorkRoots(),
		});
		return;
	}
	usage();
}

main().catch((error: unknown) => {
	console.error(renderCliError(error));
	process.exitCode = 1;
});
