import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	connectorCapabilities,
	grantedConnectors,
	loadConnectors,
	openConnectorTools,
	removeConnector,
	saveConnector,
	validateConnectorName,
} from "../src/connectors";

const fakeServer = join(__dirname, "fixtures", "fake-mcp-server.mjs");

function tempFile() {
	return join(mkdtempSync(join(tmpdir(), "tako-connectors-")), "runner-connectors.json");
}

describe("connector registry", () => {
	it("saves connectors to an owner-only file and loads them back", () => {
		const path = tempFile();
		saveConnector(
			"aws-logs",
			{ description: "CloudWatch logs", command: ["uvx", "awslabs.cloudwatch-mcp-server"], env: { AWS_PROFILE: "readonly" } },
			path,
		);

		expect(loadConnectors(path)).toEqual({
			"aws-logs": {
				description: "CloudWatch logs",
				command: ["uvx", "awslabs.cloudwatch-mcp-server"],
				env: { AWS_PROFILE: "readonly" },
			},
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
		removeConnector("aws-logs", path);
		expect(loadConnectors(path)).toEqual({});
	});

	it("treats a missing file as no connectors", () => {
		expect(loadConnectors(tempFile())).toEqual({});
	});

	it("rejects names that cannot be a capability", () => {
		expect(() => validateConnectorName("AWS Logs")).toThrow(/lowercase/);
		expect(() => validateConnectorName("a".repeat(41))).toThrow();
		expect(validateConnectorName("aws-logs")).toBe("aws-logs");
	});

	it("advertises one capability per connector", () => {
		expect(
			connectorCapabilities({
				sentry: { command: ["x"], env: {} },
				"aws-logs": { command: ["y"], env: {} },
			}),
		).toEqual(["connector.aws-logs", "connector.sentry"]);
	});

	it("starts only connectors the Profile grants", () => {
		const connectors = {
			"aws-logs": { command: ["x"], env: {} },
			sentry: { command: ["y"], env: {} },
		};
		expect(
			grantedConnectors(
				{
					"runner.connector.aws-logs": { enabled: true, autonomy: "auto" },
					"runner.connector.sentry": { enabled: false },
					"runner.connector.unknown": { enabled: true },
				},
				connectors,
			).map(([name]) => name),
		).toEqual(["aws-logs"]);
	});
});

describe("connector tools over stdio MCP", () => {
	it("exposes read-only tools, bounds results, and isolates the environment", async () => {
		process.env.TAKONAUT_RUNNER_TOKEN = "tkr_should_not_leak";
		const session = await openConnectorTools("aws-logs", {
			command: [process.execPath, fakeServer],
			env: { FAKE_REGION: "ap-south-1" },
		});
		try {
			expect(session.tools.map((tool) => tool.name)).toEqual(["aws-logs__get_log_events"]);
			const result = await session.tools[0].execute("call-1", { group: "/ecs/api" }, undefined, undefined, undefined as never);
			const text = result.content.map((item) => ("text" in item ? item.text : "")).join("");
			expect(text).toContain("ERROR PaymentService 402 in /ecs/api");
			expect(text).toContain("env=ap-south-1");
			expect(text).toContain("secret=absent");
			expect(text).toContain("untrusted");
		} finally {
			await session.close();
			delete process.env.TAKONAUT_RUNNER_TOKEN;
		}
	});

	it("exposes a mutating tool only when the machine admin allows it by name", async () => {
		const session = await openConnectorTools("aws-logs", {
			command: [process.execPath, fakeServer],
			env: {},
			allowTools: ["delete_log_group"],
		});
		try {
			expect(session.tools.map((tool) => tool.name).sort()).toEqual([
				"aws-logs__delete_log_group",
				"aws-logs__get_log_events",
			]);
		} finally {
			await session.close();
		}
	});

	it("fails clearly when the connector command cannot start", async () => {
		await expect(
			openConnectorTools("broken", { command: ["/nonexistent/mcp-server"], env: {}, timeoutMs: 2_000 }),
		).rejects.toThrow(/broken/);
	});
});

describe("connector add arguments", () => {
	it("parses description, environment, allowed tools, timeout, and the command after --", async () => {
		const { parseConnectorAdd } = await import("../src/connectors");
		expect(
			parseConnectorAdd([
				"aws-logs",
				"--description",
				"Production CloudWatch",
				"--env",
				"AWS_PROFILE=readonly",
				"--env",
				"AWS_REGION=ap-south-1",
				"--allow-tool",
				"describe_log_groups",
				"--timeout-ms",
				"45000",
				"--",
				"uvx",
				"awslabs.cloudwatch-mcp-server@latest",
			]),
		).toEqual({
			name: "aws-logs",
			connector: {
				description: "Production CloudWatch",
				command: ["uvx", "awslabs.cloudwatch-mcp-server@latest"],
				env: { AWS_PROFILE: "readonly", AWS_REGION: "ap-south-1" },
				allowTools: ["describe_log_groups"],
				timeoutMs: 45000,
			},
		});
	});

	it("requires a command after --", async () => {
		const { parseConnectorAdd } = await import("../src/connectors");
		expect(() => parseConnectorAdd(["aws-logs", "--env", "A=1"])).toThrow(/--/);
	});
});
