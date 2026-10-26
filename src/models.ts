/**
 * Models this Runner can use, beyond Pi's built-in providers: OpenAI-compatible
 * endpoints (LiteLLM, Ollama, vLLM, OpenRouter…), the machine's default model,
 * and models found not to work.
 *
 * Endpoints are plain configuration: no third-party code runs in the Runner.
 * Their models are discovered from the endpoint's /models list.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { secretStore } from "./secrets";

export type EndpointApi = "openai-completions" | "openai-responses";

export interface ModelEndpoint {
	/** Provider name used in model ids: <name>/<model-id>. */
	name: string;
	/** Base URL that serves /models and the chosen API, e.g. https://proxy.example/v1. */
	baseUrl: string;
	api: EndpointApi;
	/** Runner secret holding the API key; without it, Pi's own login for `name` is used. */
	keySecret?: string;
}

export interface RunnerModelSettings {
	endpoints: ModelEndpoint[];
	/** provider/model-id used when an Agent doesn't choose a model. */
	default?: string;
	/** provider/model-id that failed a test; not advertised or used. */
	unusable: string[];
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const DISCOVERY_TIMEOUT_MS = 10_000;

export function modelSettingsPath(): string {
	return process.env.TAKONAUT_RUNNER_MODELS ?? join(homedir(), ".takonaut", "models.json");
}

function piAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function cleanEndpoint(value: unknown): ModelEndpoint | null {
	if (typeof value !== "object" || value === null) return null;
	const item = value as Record<string, unknown>;
	if (typeof item.name !== "string" || !NAME.test(item.name)) return null;
	if (typeof item.baseUrl !== "string" || !/^https?:\/\//.test(item.baseUrl)) return null;
	return {
		name: item.name,
		baseUrl: item.baseUrl.replace(/\/+$/, ""),
		api: item.api === "openai-responses" ? "openai-responses" : "openai-completions",
		...(typeof item.keySecret === "string" && item.keySecret ? { keySecret: item.keySecret } : {}),
	};
}

export function readModelSettings(path = modelSettingsPath()): RunnerModelSettings {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			endpoints: Array.isArray(raw.endpoints)
				? raw.endpoints.map(cleanEndpoint).filter((item): item is ModelEndpoint => item !== null)
				: [],
			...(typeof raw.default === "string" && raw.default.includes("/") ? { default: raw.default } : {}),
			unusable: Array.isArray(raw.unusable) ? raw.unusable.filter((item) => typeof item === "string") : [],
		};
	} catch {
		return { endpoints: [], unusable: [] };
	}
}

export function writeModelSettings(settings: RunnerModelSettings, path = modelSettingsPath()): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

interface PiLogin {
	key?: string;
	env?: Record<string, string>;
}

function piLogin(name: string, agentDir = piAgentDir()): PiLogin | undefined {
	try {
		const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<string, PiLogin>;
		return auth[name];
	} catch {
		return undefined;
	}
}

/** Endpoints set up for Pi on this machine that a Runner could reuse. */
export function discoverPiEndpoints(agentDir = piAgentDir()): ModelEndpoint[] {
	const litellm = piLogin("litellm", agentDir);
	const baseUrl = litellm?.env?.LITELLM_BASE_URL;
	if (!litellm?.key || !baseUrl) return [];
	return [{ name: "litellm", baseUrl: `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`, api: "openai-completions" }];
}

function endpointKey(endpoint: ModelEndpoint): string | undefined {
	return endpoint.keySecret ? secretStore().get(endpoint.keySecret) : piLogin(endpoint.name)?.key;
}

/** Model ids the endpoint lists at /models. */
export async function listEndpointModels(endpoint: ModelEndpoint, key = endpointKey(endpoint)): Promise<string[]> {
	const response = await fetch(`${endpoint.baseUrl}/models`, {
		headers: key ? { authorization: `Bearer ${key}` } : {},
		signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`${endpoint.baseUrl}/models answered ${response.status}`);
	const body = (await response.json()) as { data?: { id?: unknown }[] };
	return [...new Set((body.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === "string"))]
		.filter((id) => id.length <= 100)
		.sort();
}

/** Register each endpoint and its discovered models on the model runtime. */
export async function registerEndpoints(modelRuntime: ModelRuntime, endpoints: readonly ModelEndpoint[]): Promise<string[]> {
	const errors: string[] = [];
	for (const endpoint of endpoints) {
		const key = endpointKey(endpoint);
		if (!key) {
			errors.push(
				`${endpoint.name}: no API key (${endpoint.keySecret ? `set it with tako-runner secrets set ${endpoint.keySecret}` : `log in to ${endpoint.name} in Pi`})`,
			);
			continue;
		}
		try {
			const ids = await listEndpointModels(endpoint, key);
			modelRuntime.registerProvider(endpoint.name, {
				baseUrl: endpoint.baseUrl,
				api: endpoint.api,
				apiKey: key,
				models: ids.map((id) => ({
					id,
					name: id,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 32_000,
				})),
			} as never);
		} catch (error) {
			errors.push(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return errors;
}

export interface RunnerModels {
	modelRuntime: ModelRuntime;
	settings: RunnerModelSettings;
	errors: string[];
}

const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 90_000;

/**
 * Run `work` while holding this machine's model lock. Runs start in separate
 * processes, and opening the model list refreshes OAuth logins: two at once
 * can both spend a single-use refresh token, and the second login fails.
 */
export async function withModelLock<T>(work: () => Promise<T>, path = `${modelSettingsPath()}.lock`): Promise<T> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const started = Date.now();
	for (;;) {
		try {
			mkdirSync(path, { mode: 0o700 });
			break;
		} catch {
			try {
				// A crashed holder's lock is taken over once it is old enough.
				if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { recursive: true, force: true });
			} catch {
				// Released meanwhile.
			}
			if (Date.now() - started > LOCK_WAIT_MS) break; // Never block a Run forever.
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	try {
		return await work();
	} finally {
		rmSync(path, { recursive: true, force: true });
	}
}

type RuntimeModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];

/**
 * Signed-in models, provider by provider: one broken login (say, a revoked
 * Codex token) only removes that provider's models.
 */
export async function availableModels(modelRuntime: ModelRuntime, errors?: string[]): Promise<RuntimeModel[]> {
	try {
		return [...(await modelRuntime.getAvailable())];
	} catch {
		const out: RuntimeModel[] = [];
		for (const provider of modelRuntime.getProviders()) {
			try {
				out.push(...(await modelRuntime.getAvailable(provider.id)));
			} catch (error) {
				errors?.push(`${provider.id}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
			}
		}
		return out;
	}
}

async function openOnce(settings: RunnerModelSettings): Promise<RunnerModels> {
	const modelRuntime = await ModelRuntime.create();
	const errors = await registerEndpoints(modelRuntime, settings.endpoints);
	// Refresh logins now, inside the lock, so later calls reuse them.
	await availableModels(modelRuntime, errors);
	return { modelRuntime, settings, errors };
}

/** A model runtime with Pi's providers plus this Runner's endpoints. */
export async function openRunnerModels(settings = readModelSettings()): Promise<RunnerModels> {
	const models = await withModelLock(async () => {
		try {
			return await openOnce(settings);
		} catch (error) {
			// Another process may have just refreshed the login; read it again.
			console.error(`Models not ready, retrying once: ${error instanceof Error ? error.message : String(error)}`);
			return await openOnce(settings);
		}
	});
	for (const error of models.errors) console.error(`Model endpoint ${error}`);
	return models;
}

export const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

/** Models this Runner can use: signed in, and not found unusable. */
export async function usableModels(models: RunnerModels): Promise<RuntimeModel[]> {
	const unusable = new Set(models.settings.unusable.map((key) => key.toLowerCase()));
	return (await availableModels(models.modelRuntime)).filter((model) => !unusable.has(modelKey(model).toLowerCase()));
}

/** The model for a Run: the Agent's choice if this Runner has it, else the Runner default. */
export async function chooseModel(
	models: RunnerModels,
	preferred: { provider?: string; modelId?: string },
): Promise<{ model?: RuntimeModel; note?: string }> {
	const available = await usableModels(models);
	const find = (key: string) => available.find((model) => modelKey(model).toLowerCase() === key.toLowerCase());
	const wanted = preferred.provider && preferred.modelId ? `${preferred.provider}/${preferred.modelId}` : undefined;
	const chosen = wanted ? find(wanted) : undefined;
	if (chosen) return { model: chosen };
	const fallback = models.settings.default ? find(models.settings.default) : undefined;
	const note = wanted
		? `Model ${wanted} is not available on this Runner; using ${fallback ? modelKey(fallback) : "the default"}`
		: undefined;
	return { model: fallback, note };
}

/** Try one model with a tiny request. Resolves to null when it works, otherwise the error. */
export async function testModel(modelRuntime: ModelRuntime, model: RuntimeModel, timeoutMs = 60_000): Promise<string | null> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Some providers ignore the abort signal, so the timeout doesn't rely on it.
	const timeout = new Promise<string>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(`no answer within ${Math.round(timeoutMs / 1000)} seconds`);
		}, timeoutMs);
	});
	const attempt = (async () => {
		try {
			const reply = (await modelRuntime.completeSimple(
				model,
				{ messages: [{ role: "user", content: "Reply with just: ok", timestamp: Date.now() }] } as never,
				{ signal: controller.signal, maxTokens: 64 } as never,
			)) as { stopReason?: string; errorMessage?: string };
			return reply.stopReason === "error" ? (reply.errorMessage ?? "the model returned an error") : null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	})();
	try {
		return await Promise.race([attempt, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Doctor checks: endpoints reachable, and a default model this Runner has. */
export async function modelDoctorChecks(settings = readModelSettings()): Promise<
	{ name: string; level: "ok" | "warn" | "fail"; detail: string; fix?: string }[]
> {
	const models = await openRunnerModels(settings);
	const checks: { name: string; level: "ok" | "warn" | "fail"; detail: string; fix?: string }[] = models.errors.map(
		(error) => ({ name: "Model endpoint", level: "warn", detail: error, fix: "tako-runner models" }),
	);
	const usable = await usableModels(models);
	if (!settings.default) {
		checks.push({
			name: "Default model",
			level: "warn",
			detail: "None; Agents that don't choose a model use Pi's built-in default, which may not work with your login",
			fix: "tako-runner models default PROVIDER/MODEL",
		});
	} else if (!usable.some((model) => modelKey(model) === settings.default)) {
		checks.push({
			name: "Default model",
			level: "fail",
			detail: `${settings.default} isn't available on this Runner`,
			fix: "tako-runner models (then tako-runner models default …)",
		});
	} else {
		checks.push({ name: "Default model", level: "ok", detail: settings.default });
	}
	return checks;
}
