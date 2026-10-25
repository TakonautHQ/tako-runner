import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctorExitCode, runDoctor, type DoctorProbes } from "../src/runner-doctor";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function probes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
	const home = mkdtempSync(join(tmpdir(), "tako-doctor-"));
	roots.push(home);
	const repo = join(home, ".takonaut", "repos", "Acme", "Api");
	mkdirSync(repo, { recursive: true });
	return {
		platform: "darwin",
		home,
		loadConfig: () => ({
			serverUrl: "https://takonaut.test",
			organizationId: "o",
			credential: "c",
			pollIntervalMs: 2000,
			leaseSeconds: 90,
			repositories: {},
			repositoryBindings: { r1: { projectId: "p1", path: repo } },
		}),
		catalog: async () => ({
			organization: { id: "o", name: "Acme" },
			runner: { id: "x", name: "Mac", capacity: 1 },
			projects: [
				{
					id: "p1",
					name: "Platform",
					key: "PL",
					repositories: [{ id: "r1", owner: "Acme", name: "Api", default_branch: "main" }],
				},
			],
		}),
		providers: async () => ["anthropic"],
		gitFetchable: () => true,
		serviceRunning: () => true,
		stopMarkerExists: () => false,
		freeBytes: () => 50 * 1024 ** 3,
		connectorNames: () => [],
		...overrides,
	};
}

describe("tako-runner doctor", () => {
	it("passes a healthy Runner", async () => {
		const checks = await runDoctor(probes());
		expect(checks.filter((c) => c.level !== "ok")).toEqual([]);
		expect(doctorExitCode(checks)).toBe(0);
	});

	it("names a rejected credential and how to fix it", async () => {
		const checks = await runDoctor(
			probes({ catalog: async () => { throw new Error("Takonaut Runner API 401: revoked"); } }),
		);
		const server = checks.find((c) => c.name === "Takonaut");
		expect(server?.level).toBe("fail");
		expect(server?.fix).toContain("setup --force");
		expect(doctorExitCode(checks)).toBe(1);
	});

	it("warns about repositories in macOS privacy-protected folders", async () => {
		const base = probes();
		const desktop = join(base.home, "Desktop", "Api");
		mkdirSync(desktop, { recursive: true });
		const checks = await runDoctor({
			...base,
			loadConfig: () => ({
				...base.loadConfig(),
				repositoryBindings: { r1: { projectId: "p1", path: desktop } },
			}),
		});
		const repo = checks.find((c) => c.name.startsWith("Repository "));
		expect(repo?.level).toBe("warn");
		expect(repo?.fix).toContain("repos sync");
	});

	it("lists approved repositories that are not on this Runner", async () => {
		const base = probes();
		const checks = await runDoctor({
			...base,
			loadConfig: () => ({ ...base.loadConfig(), repositoryBindings: {} }),
		});
		expect(checks.find((c) => c.name === "Repositories")?.detail).toContain("Acme/Api");
	});

	it("reports no provider, low disk, a stop marker and a stopped service", async () => {
		const checks = await runDoctor(
			probes({
				providers: async () => [],
				freeBytes: () => 1024 ** 3,
				stopMarkerExists: () => true,
			}),
		);
		expect(checks.find((c) => c.name === "Model provider")?.level).toBe("fail");
		expect(checks.find((c) => c.name === "Disk")?.level).toBe("warn");
		expect(checks.find((c) => c.name === "Service")?.fix).toContain("clear-stop");
	});

	it("warns when Agents cannot get a sandboxed shell", async () => {
		const checks = await runDoctor(probes({ platform: "linux", sandbox: () => null }));
		const sandbox = checks.find((c) => c.name === "Sandbox");
		expect(sandbox?.level).toBe("warn");
		expect(sandbox?.fix).toContain("bubblewrap");
	});

	it("keeps checking after the configuration is missing", async () => {
		const checks = await runDoctor(
			probes({ loadConfig: () => { throw new Error("ENOENT runner.json"); } }),
		);
		expect(checks.find((c) => c.name === "Configuration")?.level).toBe("fail");
		expect(checks.find((c) => c.name === "Model provider")?.level).toBe("ok");
	});
});
