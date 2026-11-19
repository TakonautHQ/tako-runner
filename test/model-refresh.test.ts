import { describe, expect, it } from "vitest";
import { RunnerApiClient, refreshModelCapabilities } from "../src/runner";

function client() {
	const bodies: { capabilities: string[] }[] = [];
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	}) as unknown as typeof fetch;
	const api = new RunnerApiClient(
		{
			serverUrl: "https://takonaut.test",
			organizationId: "org",
			credential: "tkr_x",
			pollIntervalMs: 1000,
			leaseSeconds: 90,
			repositories: {},
			repositoryBindings: {},
		} as never,
		fetchImpl,
	);
	return { api, bodies };
}

const found = (capabilities: string[], complete = true) => async () => ({ capabilities, complete });
const quiet = () => {};

describe("model refresh", () => {
	it("remembers the models it advertised", async () => {
		const { api, bodies } = client();
		await api.advertiseCapabilities(["model.litellm/sol", "model.default:litellm/sol", "model.litellm/luna"]);
		expect(api.advertisedModels).toEqual(["model.default:litellm/sol", "model.litellm/luna", "model.litellm/sol"]);
		expect(bodies[0].capabilities).toContain("model.litellm/luna");
	});

	it("advertises again only when the models changed", async () => {
		const { api, bodies } = client();
		await api.advertiseCapabilities(["model.litellm/gpt-6-sol", "model.litellm/sol"]);

		expect(await refreshModelCapabilities(api, found(["model.litellm/sol", "model.litellm/gpt-6-sol"]), quiet)).toBe(false);
		expect(bodies).toHaveLength(1);

		expect(await refreshModelCapabilities(api, found(["model.litellm/sol", "model.litellm/terra"]), quiet)).toBe(true);
		expect(bodies).toHaveLength(2);
		expect(bodies[1].capabilities).toContain("model.litellm/terra");
		expect(bodies[1].capabilities).not.toContain("model.litellm/gpt-6-sol");
		expect(api.advertisedModels).toEqual(["model.litellm/sol", "model.litellm/terra"]);
	});

	it("keeps the advertised models when discovery is incomplete", async () => {
		const { api, bodies } = client();
		await api.advertiseCapabilities(["model.litellm/sol"]);
		expect(await refreshModelCapabilities(api, found([], false), quiet)).toBe(false);
		expect(bodies).toHaveLength(1);
		expect(api.advertisedModels).toEqual(["model.litellm/sol"]);
	});

	it("waits for the first advertisement", async () => {
		const { api, bodies } = client();
		let asked = false;
		const discover = async () => {
			asked = true;
			return { capabilities: ["model.litellm/sol"], complete: true };
		};
		expect(await refreshModelCapabilities(api, discover, quiet)).toBe(false);
		expect(asked).toBe(false);
		expect(bodies).toHaveLength(0);
	});
});
