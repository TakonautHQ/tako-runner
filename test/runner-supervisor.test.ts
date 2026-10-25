import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import {
	readSupervisedRequest,
	runSupervisedWorker,
} from "../src/runner-supervisor";

const runnerCli = fileURLToPath(new URL("../src/runner-cli.ts", import.meta.url));
const supervisorModule = fileURLToPath(
	new URL("../src/runner-supervisor.ts", import.meta.url),
);

// Real OS processes; no repository, provider, or AI runtime is involved.
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "takonaut-supervisor-"));
	roots.push(root);
	return root;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(path: string): Promise<string> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (existsSync(path)) {
			const value = readFileSync(path, "utf8");
			if (value) return value;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

// Worker protocol: one JSON line on stdin `{ resultPath, input }`; stdin then
// stays open as the supervisor lifeline.
const readRequest = `
let raw = "";
let started = false;
process.stdin.on("data", (chunk) => {
	raw += chunk;
	const newline = raw.indexOf("\\n");
	if (!started && newline >= 0) {
		started = true;
		process.stdin.pause();
		main(JSON.parse(raw.slice(0, newline)));
	}
});
`;

describe("supervised analysis worker", () => {
	it("returns the result written by a worker that exits cleanly", async () => {
		const script = `${readRequest}
function main({ resultPath, input }) {
	require("node:fs").writeFileSync(resultPath, JSON.stringify({ echoed: input.value }));
	process.exit(0);
}`;
		const result = await runSupervisedWorker<{ echoed: string }>({
			command: process.execPath,
			args: ["-e", script],
			input: { value: "synthetic" },
			signal: new AbortController().signal,
		});
		expect(result).toEqual({ echoed: "synthetic" });
	});

	it("rejects a failed worker without accepting a partial result", async () => {
		const script = `${readRequest}
function main({ resultPath }) {
	require("node:fs").writeFileSync(resultPath, JSON.stringify({ partial: true }));
	process.exit(3);
}`;
		await expect(
			runSupervisedWorker({
				command: process.execPath,
				args: ["-e", script],
				input: {},
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("Runner analysis worker exited with code 3");
	});

	it("kills the worker and its grandchild before settling on abort", async () => {
		const root = scratch();
		const pidFile = join(root, "grandchild.pid");
		const script = `${readRequest}
function main() {
	const child = require("node:child_process").spawn("sleep", ["60"], { stdio: "ignore" });
	require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
	setInterval(() => {}, 1000);
}`;
		const controller = new AbortController();
		const outcome = runSupervisedWorker({
			command: process.execPath,
			args: ["-e", script],
			input: {},
			signal: controller.signal,
		}).then(
			() => "unexpected success",
			(error: Error) => error.message,
		);
		const grandchild = Number(await waitFor(pidFile));
		expect(isAlive(grandchild)).toBe(true);
		controller.abort(new Error("Runner lease lost; analysis was stopped"));
		expect(await outcome).toBe("Runner lease lost; analysis was stopped");
		expect(isAlive(grandchild)).toBe(false);
	});

	it("escalates to SIGKILL when the worker ignores SIGTERM", async () => {
		const root = scratch();
		const ready = join(root, "ready");
		const script = `${readRequest}
function main() {
	process.on("SIGTERM", () => {});
	require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid));
	setInterval(() => {}, 1000);
}`;
		const controller = new AbortController();
		const outcome = runSupervisedWorker({
			command: process.execPath,
			args: ["-e", script],
			input: {},
			signal: controller.signal,
			graceMs: 200,
		}).then(
			() => "unexpected success",
			(error: Error) => error.message,
		);
		const worker = Number(await waitFor(ready));
		controller.abort(new Error("stop"));
		expect(await outcome).toBe("stop");
		expect(isAlive(worker)).toBe(false);
	});

	it("reaps a grandchild left behind by a worker that exited cleanly", async () => {
		const root = scratch();
		const pidFile = join(root, "orphan.pid");
		const script = `${readRequest}
function main({ resultPath }) {
	const fs = require("node:fs");
	const child = require("node:child_process").spawn("sleep", ["60"], { stdio: "ignore" });
	child.unref();
	fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
	fs.writeFileSync(resultPath, "{}");
	process.exit(0);
}`;
		await runSupervisedWorker({
			command: process.execPath,
			args: ["-e", script],
			input: {},
			signal: new AbortController().signal,
		});
		expect(isAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
	});

	it("the real analysis worker rejects malformed input before any Pi work", async () => {
		await expect(
			runSupervisedWorker({
				command: "bun",
				args: [runnerCli, "__analysis-worker"],
				input: { claim: {}, cwd: 42 },
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("Runner analysis worker exited with code 65");
	});

	it("withholds the machine credential from the worker environment", async () => {
		const previous = process.env.TAKONAUT_RUNNER_TOKEN;
		process.env.TAKONAUT_RUNNER_TOKEN = "tkr_synthetic_not_secret";
		try {
			const script = `${readRequest}
function main({ resultPath }) {
	require("node:fs").writeFileSync(resultPath, JSON.stringify({
		hasToken: "TAKONAUT_RUNNER_TOKEN" in process.env,
		hasPath: typeof process.env.PATH === "string",
	}));
	process.exit(0);
}`;
			const result = await runSupervisedWorker({
				command: process.execPath,
				args: ["-e", script],
				input: {},
				signal: new AbortController().signal,
			});
			expect(result).toEqual({ hasToken: false, hasPath: true });
		} finally {
			if (previous === undefined) delete process.env.TAKONAUT_RUNNER_TOKEN;
			else process.env.TAKONAUT_RUNNER_TOKEN = previous;
		}
	});

	it("worker and grandchild die when the supervising process is killed", async () => {
		const root = scratch();
		const pids = join(root, "pids.json");
		const worker = `
import { readSupervisedRequest } from ${JSON.stringify(supervisorModule)};
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
await readSupervisedRequest();
const child = spawn("sleep", ["60"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ worker: process.pid, grandchild: child.pid }));
setInterval(() => {}, 1000);
`;
		const parent = `
import { runSupervisedWorker } from ${JSON.stringify(supervisorModule)};
await runSupervisedWorker({ command: "bun", args: ["-e", ${JSON.stringify(worker)}], input: {}, signal: new AbortController().signal });
`;
		const { spawn } = await import("node:child_process");
		const supervisor = spawn("bun", ["-e", parent], { stdio: "ignore" });
		const { worker: workerPid, grandchild } = JSON.parse(await waitFor(pids));
		expect(isAlive(workerPid)).toBe(true);
		supervisor.kill("SIGKILL");
		for (let attempt = 0; attempt < 120; attempt += 1) {
			if (!isAlive(workerPid) && !isAlive(grandchild)) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const survivors = [workerPid, grandchild].filter(isAlive);
		for (const pid of survivors) process.kill(pid, "SIGKILL");
		expect(survivors).toEqual([]);
	});

	it("decodes a multi-byte character split across stdin chunks", async () => {
		// Never ended: EOF would trigger the lifeline and kill this test's group.
		const stdin = new PassThrough();
		const line = readSupervisedRequest(stdin);
		const bytes = Buffer.from('{"text":"a\u2014b"}\n', "utf8");
		const split = bytes.indexOf(0xe2) + 1;
		stdin.write(bytes.subarray(0, split));
		stdin.write(bytes.subarray(split));
		expect(JSON.parse(await line)).toEqual({ text: "a\u2014b" });
	});

	it("does not start a worker when already aborted", async () => {
		const root = scratch();
		const marker = join(root, "started");
		const controller = new AbortController();
		controller.abort(new Error("already stopped"));
		await expect(
			runSupervisedWorker({
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
				input: {},
				signal: controller.signal,
			}),
		).rejects.toThrow("already stopped");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(existsSync(marker)).toBe(false);
	});
});
