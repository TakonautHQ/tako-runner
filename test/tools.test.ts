import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { limitKey } from "../src/run-archive";
import { redact } from "../src/redact";
import { parseEnvFile, referencedSecrets, secretStore, setSecret, unsetSecret } from "../src/secrets";
import { buildApiRequest, executeApiTool, isPrivateAddress, type ApiToolSpec } from "../src/tools/api-tool";
import {
	argumentsHash,
	type CatalogToolSpec,
	type ClaimedAction,
	catalogCapabilities,
	type ControlApi,
	runActionOnce,
	syncTools,
	toolState,
} from "../src/tools/catalog";
import { scriptArgv } from "../src/tools/script-tool";

const store = (values: Record<string, string>) => ({
	get: (name: string) => values[name],
	names: () => Object.keys(values),
});

const LOOKUP: ApiToolSpec = {
	method: "GET",
	url: "https://admin.example.com/api/orders/{order_id}",
	headers: { Authorization: "Bearer ${secret:ADMIN_API_TOKEN}" },
	query: { expand: "{expand}" },
	input_schema: { required: ["order_id"] },
	allowed_hosts: ["admin.example.com"],
};

function tool(overrides: Partial<CatalogToolSpec> = {}): CatalogToolSpec {
	return {
		key: "look-up-order",
		kind: "api",
		label: "Look up order",
		description: "",
		effect: "read",
		definition_id: "d1",
		revision_id: "r1",
		revision: 1,
		spec: LOOKUP as unknown as Record<string, unknown>,
		limits: [25, 10],
		chat_allowed: false,
		...overrides,
	};
}

describe("secrets", () => {
	it("stores values owner-only and lists what tools still need", () => {
		const path = join(mkdtempSync(join(tmpdir(), "tako-secrets-")), "secrets.json");
		setSecret("ADMIN_API_TOKEN", "s3cret-value", { path });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(secretStore(path).get("ADMIN_API_TOKEN")).toBe("s3cret-value");
		expect(JSON.parse(readFileSync(path, "utf8")).secrets.ADMIN_API_TOKEN.value).toBe("s3cret-value");
		expect(() => setSecret("bad name", "x", { path })).toThrow(/capital letters/);
		expect(unsetSecret("ADMIN_API_TOKEN", path)).toBe(true);
		expect(secretStore(path).get("ADMIN_API_TOKEN")).toBeUndefined();
		expect(referencedSecrets(LOOKUP)).toEqual(["ADMIN_API_TOKEN"]);
		expect(parseEnvFile("# c\nexport a_token='x y'\nB=2\n")).toEqual({ A_TOKEN: "x y", B: "2" });
	});

	it("a tool is ready only when every secret it names is set", () => {
		expect(toolState(tool(), store({}))).toMatchObject({ state: "missing_secrets", missing_secrets: ["ADMIN_API_TOKEN"] });
		expect(toolState(tool(), store({ ADMIN_API_TOKEN: "t" })).state).toBe("ready");
		expect(catalogCapabilities([tool()], store({ ADMIN_API_TOKEN: "t" }))).toEqual(["tool.look-up-order"]);
		expect(catalogCapabilities([tool()], store({}))).toEqual([]);
	});

	it("sync stores the tools and reports their state", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "tako-tools-")), "tools.json");
		const reported: unknown[] = [];
		const ready = await syncTools(
			{ listTools: async () => [tool()], reportToolStates: async (states) => reported.push(...states) },
			path,
		);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(reported).toHaveLength(1);
		expect(Array.isArray(ready)).toBe(true);
	});
});

describe("redaction", () => {
	it("removes secret values, tokens and, opt-in, personal data", () => {
		const out = redact("key s3cret-value ghp_abcdefghijklmnopqrstuvwxyz0123 mail a@b.co +91 98765 43210", {
			secrets: ["s3cret-value"],
			personalData: true,
		});
		expect(out).not.toContain("s3cret-value");
		expect(out).not.toContain("ghp_");
		expect(out).toContain("[email]");
		expect(out).toContain("[phone]");
	});
});

describe("API tools", () => {
	it("keeps arguments out of the host and resolves secrets only into the request", () => {
		const used = new Set<string>();
		const { url, init } = buildApiRequest(
			LOOKUP,
			{ order_id: "../../admin?x=1#", expand: "items" },
			store({ ADMIN_API_TOKEN: "s3cret-value" }),
			used,
		);
		expect(url.host).toBe("admin.example.com");
		expect(url.pathname).toBe("/api/orders/..%2F..%2Fadmin%3Fx%3D1%23");
		expect(url.searchParams.get("expand")).toBe("items");
		expect(init.headers.Authorization).toBe("Bearer s3cret-value");
		expect([...used]).toEqual(["s3cret-value"]);
		expect(() =>
			buildApiRequest({ ...LOOKUP, url: "https://admin.example.com.{x}/a" }, { x: "evil.com" }, store({ ADMIN_API_TOKEN: "t" }), new Set()),
		).toThrow();
	});

	it("refuses private networks and redirects, caps and redacts output", async () => {
		const secrets = store({ ADMIN_API_TOKEN: "s3cret-value" });
		const privateHost = await executeApiTool(LOOKUP, { order_id: "1" }, { secrets, resolveHost: async () => ["10.0.0.5"] });
		expect(privateHost.ok).toBe(false);
		expect(privateHost.summary).toMatch(/private network/);
		expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isPrivateAddress("8.8.8.8")).toBe(false);

		const redirected = await executeApiTool(LOOKUP, { order_id: "1" }, {
			secrets,
			resolveHost: async () => ["93.184.216.34"],
			fetchImpl: (async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })) as typeof fetch,
		});
		expect(redirected).toMatchObject({ ok: false, statusCode: 302 });

		let sent: RequestInit | undefined;
		const ok = await executeApiTool(
			{ ...LOOKUP, method: "POST", body: { id: "{order_id}", note: "for {order_id}" }, response: { json_path: "data.status" } },
			{ order_id: 7 },
			{
				secrets,
				idempotencyKey: "takonaut-action-1",
				resolveHost: async () => ["93.184.216.34"],
				fetchImpl: (async (_url: URL, init: RequestInit) => {
					sent = init;
					return new Response(JSON.stringify({ data: { status: "paid s3cret-value" } }), { status: 200 });
				}) as unknown as typeof fetch,
			},
		);
		expect(ok.ok).toBe(true);
		expect(JSON.parse(String(sent?.body))).toEqual({ id: 7, note: "for 7" });
		expect((sent?.headers as Record<string, string>)["Idempotency-Key"]).toBe("takonaut-action-1");
		expect(ok.output).toBe('"paid [redacted secret]"');
		const missing = await executeApiTool(LOOKUP, {}, { secrets });
		expect(missing.summary).toBe("order_id is required");
	});
});

describe("script tools", () => {
	it("substitutes inputs as whole arguments only", () => {
		expect(scriptArgv({ command: ["bin/check", "{order_id}", "--flag"], cwd: "home", network: false }, { order_id: "a b; rm -rf /" })).toEqual([
			"bin/check",
			"a b; rm -rf /",
			"--flag",
		]);
	});
});

describe("approved actions", () => {
	it("hashes arguments the way Takonaut does", () => {
		// Python: sha256(json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False))
		expect(argumentsHash({ b: "é", a: 1, c: [true, null, "x"] })).toBe(
			"362b662291a1aa8918f29b86fb0bc2c161e5e10c2c86361be0535137bfced08d",
		);
	});

	it("executes exactly the approved call once and reports it with the permit", async () => {
		const reports: Array<Record<string, unknown>> = [];
		const action: ClaimedAction = {
			action_id: "a1",
			tool_key: "runner.tool.requeue",
			kind: "api",
			key: "requeue",
			revision_id: "r1",
			spec: { ...LOOKUP, method: "POST", headers: {}, allowed_hosts: ["127.0.0.1"], allow_private_network: true, allow_plain_http: true, url: "http://127.0.0.1:9/x/{order_id}" } as unknown as Record<string, unknown>,
			arguments: { order_id: "ORD-1" },
			arguments_hash: argumentsHash({ order_id: "ORD-1" }),
			permit: "tpa_x",
			idempotency_key: "takonaut-action-a1",
		};
		const api: ControlApi = {
			claimAction: async () => action,
			reportAction: async (_id, result) => reports.push(result),
			claimTry: async () => null,
			reportTry: async () => null,
		};
		expect(await runActionOnce(api)).toBe(true);
		expect(reports[0]).toMatchObject({ permit: "tpa_x", arguments_hash: action.arguments_hash });

		reports.length = 0;
		await runActionOnce({ ...api, claimAction: async () => ({ ...action, arguments: { order_id: "OTHER" } }) });
		expect(reports[0]).toMatchObject({ ok: false, summary: expect.stringMatching(/did not match/) });
		expect(await runActionOnce({ ...api, claimAction: async () => null })).toBe(false);
	});

	it("organization tools have their own limits", () => {
		expect(limitKey("t_look_up_order")).toBe("tool.look-up-order");
		expect(limitKey("t_cloudwatch__get_logs")).toBe("tool.cloudwatch");
	});
});
