/**
 * `tako-runner doctor`: every check a working Runner needs, each with one
 * fix. Pure over injected probes so it is testable and never hangs on a
 * single broken dependency.
 */
import { existsSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import type { RunnerDaemonConfig } from "./runner";
import type { RunnerSetupCatalog } from "./runner-setup";

export type DoctorLevel = "ok" | "warn" | "fail";

export interface DoctorCheck {
	name: string;
	level: DoctorLevel;
	detail: string;
	fix?: string;
}

export interface DoctorProbes {
	platform: string;
	loadConfig: () => RunnerDaemonConfig;
	catalog: (config: RunnerDaemonConfig) => Promise<RunnerSetupCatalog>;
	providers: () => Promise<string[]>;
	gitFetchable: (path: string) => boolean;
	serviceRunning: () => boolean;
	stopMarkerExists: () => boolean;
	freeBytes: (path: string) => number | undefined;
	connectorNames: () => string[];
	home: string;
	/** "macos" / "bwrap" when Agents can get a sandboxed shell. */
	sandbox?: () => string | null;
}

const PRIVACY_PROTECTED = ["Desktop", "Documents", "Downloads"];
const MIN_FREE_BYTES = 2 * 1024 ** 3;

function message(error: unknown): string {
	return (error instanceof Error ? error.message : String(error))
		.split("\n")[0]
		.slice(0, 300);
}

export async function runDoctor(probes: DoctorProbes): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	const add = (check: DoctorCheck) => checks.push(check);

	add(
		probes.platform === "darwin" || probes.platform === "linux"
			? { name: "Operating system", level: "ok", detail: probes.platform }
			: {
					name: "Operating system",
					level: "fail",
					detail: `${probes.platform} is not supported`,
					fix: "Use macOS or Linux",
				},
	);

	let config: RunnerDaemonConfig | undefined;
	try {
		config = probes.loadConfig();
		add({ name: "Configuration", level: "ok", detail: config.serverUrl });
	} catch (error) {
		add({
			name: "Configuration",
			level: "fail",
			detail: message(error),
			fix: "tako-runner setup --url https://takonaut.app",
		});
	}

	let catalog: RunnerSetupCatalog | undefined;
	if (config) {
		try {
			catalog = await probes.catalog(config);
			add({
				name: "Takonaut",
				level: "ok",
				detail: `${catalog.organization.name} · Runner "${catalog.runner.name}" · ${catalog.projects.length} project(s)`,
			});
			if (catalog.projects.length === 0) {
				add({
					name: "Projects",
					level: "fail",
					detail: "No projects are approved for this Runner",
					fix: "In Takonaut open Settings → Agents → Runners and choose projects for this Runner",
				});
			}
		} catch (error) {
			const text = message(error);
			add({
				name: "Takonaut",
				level: "fail",
				detail: text,
				fix: /401|403|revoked|credential/i.test(text)
					? "The Runner credential was rejected; run tako-runner setup --force to enroll again"
					: "Check the network and the server URL, then run tako-runner doctor again",
			});
		}
	}

	try {
		const providers = await probes.providers();
		add(
			providers.length > 0
				? { name: "Model provider", level: "ok", detail: providers.join(", ") }
				: {
						name: "Model provider",
						level: "fail",
						detail: "No authenticated Pi provider",
						fix: "Run pi as this user and use /login",
					},
		);
	} catch (error) {
		add({
			name: "Model provider",
			level: "fail",
			detail: message(error),
			fix: "Run pi as this user and use /login",
		});
	}

	if (config) {
		const bindings = Object.entries(config.repositoryBindings ?? {});
		const bound = new Set(bindings.map(([id]) => id));
		for (const [id, binding] of bindings) {
			const name =
				catalog?.projects
					.flatMap((project) => project.repositories)
					.find((repository) => repository.id === id) ?? undefined;
			const label = name ? `${name.owner}/${name.name}` : binding.path;
			if (!existsSync(binding.path)) {
				add({
					name: `Repository ${label}`,
					level: "fail",
					detail: `${binding.path} does not exist`,
					fix: "tako-runner repos sync",
				});
				continue;
			}
			const protectedFolder =
				probes.platform === "darwin" &&
				PRIVACY_PROTECTED.some((folder) =>
					binding.path.startsWith(`${probes.home}/${folder}/`),
				);
			if (protectedFolder) {
				add({
					name: `Repository ${label}`,
					level: "warn",
					detail: `${binding.path} is in a macOS privacy-protected folder; the background service can hang waiting for permission`,
					fix: "tako-runner repos sync --replace (uses Runner-owned clones)",
				});
				continue;
			}
			add(
				probes.gitFetchable(binding.path)
					? { name: `Repository ${label}`, level: "ok", detail: "fetch works" }
					: {
							name: `Repository ${label}`,
							level: "fail",
							detail: "git fetch failed",
							fix: "Give this user GitHub read access (ssh -T git@github.com or gh auth login)",
						},
			);
		}
		const missing =
			catalog?.projects.flatMap((project) =>
				project.repositories
					.filter((repository) => !bound.has(repository.id))
					.map((repository) => `${repository.owner}/${repository.name}`),
			) ?? [];
		if (missing.length > 0) {
			add({
				name: "Repositories",
				level: "warn",
				detail: `Not on this Runner yet: ${missing.join(", ")}`,
				fix: "tako-runner repos sync",
			});
		}
		if (bindings.length === 0 && missing.length === 0 && catalog) {
			add({
				name: "Repositories",
				level: "fail",
				detail: "The approved projects have no connected GitHub repositories",
				fix: "Connect a repository to the project in Takonaut, then run tako-runner repos sync",
			});
		}
	}

	try {
		const names = probes.connectorNames();
		add({
			name: "Connectors",
			level: "ok",
			detail: names.length > 0 ? names.join(", ") : "none",
		});
	} catch (error) {
		add({
			name: "Connectors",
			level: "warn",
			detail: message(error),
			fix: "tako-runner connector list",
		});
	}

	if (probes.sandbox) {
		const kind = probes.sandbox();
		add(
			kind
				? { name: "Sandbox", level: "ok", detail: kind === "macos" ? "macOS sandbox" : "bubblewrap" }
				: {
						name: "Sandbox",
						level: "warn",
						detail: "No sandbox, so Agents can read and search code but cannot run commands or tests",
						fix: probes.platform === "linux" ? "Install bubblewrap (apt install bubblewrap)" : "Use macOS or Linux",
					},
		);
	}

	const free = probes.freeBytes(probes.home);
	if (free !== undefined) {
		const gib = (free / 1024 ** 3).toFixed(1);
		add(
			free >= MIN_FREE_BYTES
				? { name: "Disk", level: "ok", detail: `${gib} GiB free` }
				: {
						name: "Disk",
						level: "warn",
						detail: `Only ${gib} GiB free; checkouts may fail`,
						fix: "Free some disk space",
					},
		);
	}

	if (probes.stopMarkerExists()) {
		add({
			name: "Service",
			level: "fail",
			detail: "The Runner stopped itself after a worker could not be confirmed dead",
			fix: "Check for leftover pi/bun processes, then tako-runner clear-stop",
		});
	} else {
		add(
			probes.serviceRunning()
				? { name: "Service", level: "ok", detail: "running" }
				: {
						name: "Service",
						level: "warn",
						detail: "not running",
						fix: "brew services start tako-runner (or tako-runner start)",
					},
		);
	}
	return checks;
}

export function freeBytes(path: string): number | undefined {
	try {
		const stats = statfsSync(path);
		return Number(stats.bavail) * Number(stats.bsize);
	} catch {
		return undefined;
	}
}

export function defaultHome(): string {
	return homedir();
}

export function doctorExitCode(checks: DoctorCheck[]): number {
	return checks.some((check) => check.level === "fail") ? 1 : 0;
}
