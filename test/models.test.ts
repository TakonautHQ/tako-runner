import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	chooseModel,
	discoverPiEndpoints,
	modelDoctorChecks,
	readModelSettings,
	registerEndpoints,
	usableModels,
	writeModelSettings,
} from "../src/models";

let dir: string;
let server: Server;
let baseUrl = "";
const seen: string[] = [];

beforeAll(async () => {
	server = createServer((request, response) => {
		seen.push(String(request.headers.authorization));
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ data: [{ id: "gpt-6.1-sol" }, { id: "luna" }, { id: 7 }] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
});
afterAll(() => server.close());

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "runner-models-"));
	process.env.TAKONAUT_RUNNER_MODELS = join(dir, "models.json");
	process.env.TAKONAUT_RUNNER_SECRETS = join(dir, "secrets.json");
	process.env.PI_CODING_AGENT_DIR = join(dir, "pi");
	mkdirSync(join(dir, "pi"));
	seen.length = 0;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	for (const name of ["TAKONAUT_RUNNER_MODELS", "TAKONAUT_RUNNER_SECRETS", "PI_CODING_AGENT_DIR"]) delete process.env[name];
});

function piLogin(url: string) {
	writeFileSync(
		join(dir, "pi", "auth.json"),
		JSON.stringify({ litellm: { type: "api_key", key: "sk-test", env: { LITELLM_BASE_URL: url } } }),
	);
}

describe("Runner models", () => {
	it("keeps only valid settings", () => {
		writeFileSync(
			join(dir, "models.json"),
			JSON.stringify({
				endpoints: [
					{ name: "litellm", baseUrl: "https://proxy.example/v1/", api: "nope" },
					{ name: "Bad Name", baseUrl: "https://x" },
					{ name: "local", baseUrl: "file:///etc" },
				],
				default: "litellm/sol",
				unusable: ["openai-codex/gpt-5.5", 3],
			}),
		);
		expect(readModelSettings()).toEqual({
			endpoints: [{ name: "litellm", baseUrl: "https://proxy.example/v1", api: "openai-completions" }],
			default: "litellm/sol",
			unusable: ["openai-codex/gpt-5.5"],
		});
	});

	it("reuses Pi's LiteLLM login, without copying the key", () => {
		piLogin("https://proxy.example/");
		expect(discoverPiEndpoints()).toEqual([{ name: "litellm", baseUrl: "https://proxy.example/v1", api: "openai-completions" }]);
	});

	it("discovers an endpoint's models and chooses the Agent's model, else the Runner default", async () => {
		piLogin(baseUrl.replace(/\/v1$/, ""));
		const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "pi", "auth.json"), modelsPath: null });
		expect(await registerEndpoints(modelRuntime, discoverPiEndpoints())).toEqual([]);
		expect(seen).toEqual(["Bearer sk-test"]);
		const settings = { endpoints: [], default: "litellm/gpt-6.1-sol", unusable: ["litellm/luna"] };
		const models = { modelRuntime, settings, errors: [] };
		expect((await usableModels(models)).filter((m) => m.provider === "litellm").map((m) => m.id)).toEqual(["gpt-6.1-sol"]);

		expect((await chooseModel(models, {})).model?.id).toBe("gpt-6.1-sol");
		const missing = await chooseModel(models, { provider: "openai-codex", modelId: "gpt-5.5" });
		expect(missing.model?.id).toBe("gpt-6.1-sol");
		expect(missing.note).toMatch(/not available on this Runner; using litellm\/gpt-6.1-sol/);
		// A model found unusable is never chosen, even when the Agent names it.
		expect((await chooseModel(models, { provider: "litellm", modelId: "luna" })).model?.id).toBe("gpt-6.1-sol");
	});

	it("reports an endpoint without a key instead of failing", async () => {
		const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "pi", "auth.json"), modelsPath: null });
		const errors = await registerEndpoints(modelRuntime, [
			{ name: "ollama", baseUrl, api: "openai-completions", keySecret: "OLLAMA_KEY" },
		]);
		expect(errors).toEqual(["ollama: no API key (set it with tako-runner secrets set OLLAMA_KEY)"]);
	});

	it("doctor warns without a default and fails when the default is missing", async () => {
		writeModelSettings({ endpoints: [], unusable: [] });
		expect((await modelDoctorChecks()).find((check) => check.name === "Default model")?.level).toBe("warn");
		expect((await modelDoctorChecks({ endpoints: [], default: "nowhere/model", unusable: [] })).at(-1)).toMatchObject({
			level: "fail",
			detail: "nowhere/model isn't available on this Runner",
		});
	});
});

describe("model tests", () => {
	it("doesn't count timeouts and rate limits as refusals", async () => {
		const { isTransientFailure } = await import("../src/models-cli");
		expect(isTransientFailure("no answer within 45 seconds")).toBe(true);
		expect(isTransientFailure("ResourceExhausted: Worker local total request limit reached (43/32)")).toBe(true);
		expect(isTransientFailure("Codex error: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.")).toBe(false);
		expect(isTransientFailure("410 status code (no body)")).toBe(false);
	});
});
