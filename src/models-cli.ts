/** `tako-runner models …`. */
import {
	discoverPiEndpoints,
	type EndpointApi,
	type ModelEndpoint,
	modelKey,
	modelSettingsPath,
	openRunnerModels,
	readModelSettings,
	testModel,
	usableModels,
	writeModelSettings,
} from "./models";
import { validateSecretName } from "./secrets";

export const MODELS_USAGE = `  tako-runner models                   models this Runner can use, its default, and endpoints
  tako-runner models default PROVIDER/MODEL   model for Agents that don't choose one (--clear to unset)
  tako-runner models test [PROVIDER/MODEL | --all]   try models with a tiny request; --all stops advertising the ones that fail
  tako-runner models add NAME --base-url URL [--key-secret NAME] [--api openai-completions|openai-responses]
                                       an OpenAI-compatible endpoint (LiteLLM, Ollama, vLLM, OpenRouter…)
  tako-runner models add litellm --from-pi   reuse Pi's LiteLLM login on this machine
  tako-runner models remove NAME`;

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

/** Timeouts and rate limits say nothing about whether the model works. */
export function isTransientFailure(failure: string): boolean {
	return /no answer within|timed? ?out|rate.?limit|429|ResourceExhausted|ECONNRESET|ETIMEDOUT|overloaded|503/i.test(failure);
}

function restartHint(): void {
	console.log("Restart the Runner service so Takonaut sees the change.");
}

export async function modelsCommand(args: string[]): Promise<void> {
	const [action, ...rest] = args;
	const settings = readModelSettings();

	if (!action || action === "list") {
		const models = await openRunnerModels(settings);
		const usable = await usableModels(models);
		const byProvider = new Map<string, string[]>();
		for (const model of usable) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model.id]);
		console.log(`Default: ${settings.default ?? "none (Pi's built-in default)"}`);
		if (settings.default && !usable.some((model) => modelKey(model) === settings.default)) {
			console.log(`  ⚠ ${settings.default} isn't available on this Runner`);
		}
		for (const [provider, ids] of [...byProvider.entries()].sort()) {
			console.log(`\n${provider} (${ids.length})\n${ids.map((id) => `  ${provider}/${id}`).join("\n")}`);
		}
		if (settings.unusable.length) console.log(`\nNot advertised (failed a test): ${settings.unusable.join(", ")}`);
		if (settings.endpoints.length) {
			console.log(`\nEndpoints (${modelSettingsPath()}):`);
			for (const endpoint of settings.endpoints) console.log(`  ${endpoint.name}  ${endpoint.baseUrl}  ${endpoint.api}`);
		}
		const found = discoverPiEndpoints().filter((item) => !settings.endpoints.some((endpoint) => endpoint.name === item.name));
		for (const endpoint of found) {
			console.log(`\nPi on this machine is logged in to ${endpoint.name}. Use it with: tako-runner models add ${endpoint.name} --from-pi`);
		}
		for (const error of models.errors) console.log(`\n⚠ ${error}`);
		return;
	}

	if (action === "default") {
		if (rest.includes("--clear")) {
			const { default: _cleared, ...kept } = settings;
			writeModelSettings(kept);
			console.log("No Runner default; Agents without a model use Pi's built-in default.");
			restartHint();
			return;
		}
		const key = rest[0];
		if (!key?.includes("/")) throw new Error("Usage: tako-runner models default PROVIDER/MODEL");
		const models = await openRunnerModels(settings);
		const model = (await usableModels(models)).find((item) => modelKey(item) === key);
		if (!model) throw new Error(`${key} isn't available on this Runner; see tako-runner models`);
		const failure = await testModel(models.modelRuntime, model);
		if (failure) throw new Error(`${key} didn't answer: ${failure}`);
		writeModelSettings({ ...settings, default: key });
		console.log(`✓ ${key} answered and is now this Runner's default.`);
		restartHint();
		return;
	}

	if (action === "test") {
		const models = await openRunnerModels({ ...settings, unusable: [] });
		const available = await usableModels(models);
		const all = rest.includes("--all");
		const key = all ? undefined : (rest[0] ?? settings.default);
		const targets = all ? available : available.filter((model) => modelKey(model) === key);
		if (targets.length === 0) throw new Error(key ? `${key} isn't available on this Runner` : "Name a model, or use --all");
		const failed: string[] = [];
		const unsure: string[] = [];
		const queue = [...targets];
		const worker = async () => {
			for (let model = queue.shift(); model; model = queue.shift()) {
				const failure = await testModel(models.modelRuntime, model, 45_000);
				const passing = failure !== null && isTransientFailure(failure);
				console.log(
					failure === null ? `✓ ${modelKey(model)}` : `${passing ? "?" : "✗"} ${modelKey(model)}: ${failure.slice(0, 160)}`,
				);
				if (failure !== null) (passing ? unsure : failed).push(modelKey(model));
			}
		};
		await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
		failed.sort();
		if (all) {
			writeModelSettings({ ...settings, unusable: failed });
			console.log(
				`\n${targets.length - failed.length - unsure.length} of ${targets.length} work; ${failed.length} refused and are no longer advertised.`,
			);
			if (unsure.length) console.log(`${unsure.length} timed out or were rate-limited (?); they stay advertised. Test again later.`);
			restartHint();
		}
		if (failed.length && !all) process.exitCode = 1;
		// A provider that ignored the timeout may still hold the event loop.
		process.exit(process.exitCode ?? 0);
	}

	if (action === "add") {
		const name = rest[0];
		if (!name || name.startsWith("--")) throw new Error("Usage: tako-runner models add NAME --base-url URL");
		let endpoint: ModelEndpoint | undefined;
		if (rest.includes("--from-pi")) {
			endpoint = discoverPiEndpoints().find((item) => item.name === name);
			if (!endpoint) throw new Error(`Pi on this machine isn't logged in to ${name}`);
		} else {
			const baseUrl = option(rest, "--base-url");
			if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new Error("--base-url must be an http(s) URL");
			const keySecret = option(rest, "--key-secret");
			const api = (option(rest, "--api") ?? "openai-completions") as EndpointApi;
			if (api !== "openai-completions" && api !== "openai-responses") throw new Error("--api must be openai-completions or openai-responses");
			endpoint = {
				name,
				baseUrl: baseUrl.replace(/\/+$/, ""),
				api,
				...(keySecret ? { keySecret: validateSecretName(keySecret) } : {}),
			};
		}
		if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(endpoint.name)) throw new Error("Use a lowercase name, e.g. litellm");
		const next = { ...settings, endpoints: [...settings.endpoints.filter((item) => item.name !== endpoint.name), endpoint] };
		const models = await openRunnerModels(next);
		const ids = (await usableModels(models)).filter((model) => model.provider === endpoint.name);
		if (models.errors.length) throw new Error(models.errors.join("; "));
		writeModelSettings(next);
		console.log(`✓ ${endpoint.name}: ${ids.length} models, e.g. ${ids.slice(0, 5).map(modelKey).join(", ")}`);
		console.log(`Make one the default with: tako-runner models default ${ids[0] ? modelKey(ids[0]) : `${endpoint.name}/MODEL`}`);
		restartHint();
		return;
	}

	if (action === "remove") {
		const name = rest[0];
		if (!settings.endpoints.some((item) => item.name === name)) throw new Error(`No endpoint named ${name}`);
		writeModelSettings({
			...settings,
			endpoints: settings.endpoints.filter((item) => item.name !== name),
			...(settings.default?.startsWith(`${name}/`) ? { default: undefined } : {}),
		});
		console.log(`Removed ${name}.`);
		restartHint();
		return;
	}

	throw new Error(`Unknown models command: ${action}\n${MODELS_USAGE}`);
}
