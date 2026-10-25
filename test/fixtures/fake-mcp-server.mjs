// Minimal stdio MCP server for connector tests: newline-delimited JSON-RPC.
import { createInterface } from "node:readline";

const tools = [
	{
		name: "get_log_events",
		description: "Read log events",
		inputSchema: { type: "object", properties: { group: { type: "string" } }, required: ["group"] },
		annotations: { readOnlyHint: true },
	},
	{
		name: "delete_log_group",
		description: "Delete a log group",
		inputSchema: { type: "object", properties: { group: { type: "string" } } },
		annotations: { readOnlyHint: false, destructiveHint: true },
	},
];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id === undefined) return;
	if (message.method === "initialize") {
		send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
	} else if (message.method === "tools/list") {
		send({ jsonrpc: "2.0", id: message.id, result: { tools } });
	} else if (message.method === "tools/call") {
		const { name, arguments: args } = message.params;
		if (name === "get_log_events") {
			send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `ERROR PaymentService 402 in ${args.group} env=${process.env.FAKE_REGION ?? "none"} secret=${process.env.TAKONAUT_RUNNER_TOKEN ?? "absent"}` }] } });
		} else {
			send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no ${name}` } });
		}
	} else {
		send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } });
	}
});
