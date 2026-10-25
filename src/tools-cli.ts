/** `tako-runner secrets …` and `tako-runner tools …`. */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import {
	defaultSecretsPath,
	parseEnvFile,
	secretStore,
	setSecret,
	unsetSecret,
	validateSecretName,
} from "./secrets";
import { callCatalogTool, loadLocalTools, safeSecretStore, toolState } from "./tools/catalog";

export const SECRETS_USAGE = `  tako-runner secrets                  list secrets this Runner has and the ones its tools still need
  tako-runner secrets set NAME [--keychain]   prompt for a value (not echoed); --keychain stores it in the macOS Keychain
  tako-runner secrets unset NAME
  tako-runner secrets import --env-file FILE  store every NAME=value line
  tako-runner tools                    organization tools on this Runner and whether each is ready
  tako-runner tools test KEY [--tool MCP_TOOL] [--arg NAME=VALUE]...`;

/** Read one line without echoing it. Piped input works too. */
async function promptHidden(question: string): Promise<string> {
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
	}
	let muted = false;
	const output = new Writable({
		write(chunk, _encoding, callback) {
			if (!muted) process.stdout.write(chunk);
			callback();
		},
	});
	const rl = createInterface({ input: process.stdin, output, terminal: true });
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			process.stdout.write("\n");
			resolve(answer);
		});
		muted = true;
	});
}

export async function secretsCommand(args: string[]): Promise<void> {
	const [action, ...rest] = args;
	if (!action || action === "list") {
		const store = secretStore();
		const names = store.names();
		const needed = new Map<string, string[]>();
		for (const tool of loadLocalTools()) {
			for (const name of toolState(tool, store).missing_secrets ?? []) {
				needed.set(name, [...(needed.get(name) ?? []), tool.label]);
			}
		}
		console.log(names.length ? `Secrets on this Runner (${defaultSecretsPath()}):\n${names.map((name) => `  ${name}`).join("\n")}` : "No secrets on this Runner yet.");
		if (needed.size > 0) {
			console.log("\nStill needed:");
			for (const [name, tools] of needed) console.log(`  ${name}\tfor ${tools.join(", ")}\n    tako-runner secrets set ${name}`);
		}
		return;
	}
	if (action === "set" && rest[0]) {
		const name = validateSecretName(rest[0]);
		const value = await promptHidden(`Value for ${name}: `);
		setSecret(name, value, { keychain: rest.includes("--keychain") });
		console.log(`Saved ${name}. Tools that need it become ready within 5 minutes, or now with: tako-runner tools`);
		return;
	}
	if (action === "unset" && rest[0]) {
		console.log(unsetSecret(rest[0]) ? `Removed ${rest[0]}.` : `No secret named ${rest[0]}.`);
		return;
	}
	if (action === "import") {
		const index = rest.indexOf("--env-file");
		const file = index >= 0 ? rest[index + 1] : undefined;
		if (!file) throw new Error("secrets import needs --env-file FILE");
		const values = parseEnvFile(readFileSync(file, "utf8"));
		let saved = 0;
		for (const [name, value] of Object.entries(values)) {
			try {
				setSecret(validateSecretName(name), value);
				saved += 1;
			} catch (error) {
				console.error(`Skipped ${name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		console.log(`Saved ${saved} secret(s).`);
		return;
	}
	throw new Error(`Usage:\n${SECRETS_USAGE}`);
}

export async function toolsCommand(args: string[]): Promise<void> {
	const [action, ...rest] = args;
	const tools = loadLocalTools();
	if (!action || action === "list") {
		if (tools.length === 0) {
			console.log("No organization tools are installed on this Runner. Add them in Takonaut: Agents → Tools.");
			return;
		}
		const secrets = safeSecretStore();
		for (const tool of tools) {
			const state = toolState(tool, secrets);
			const detail =
				state.state === "missing_secrets"
					? `needs ${state.missing_secrets?.map((name) => `tako-runner secrets set ${name}`).join("; ")}`
					: state.state;
			console.log(`${tool.key}\t${tool.kind}\t${tool.effect}\t${detail}`);
		}
		return;
	}
	if (action === "test" && rest[0]) {
		const tool = tools.find((item) => item.key === rest[0]);
		if (!tool) throw new Error(`No tool ${rest[0]} on this Runner. Run tako-runner tools`);
		if (tool.effect === "change" && tool.kind !== "connector") {
			throw new Error("This tool changes something; try it from Takonaut, where the call is recorded");
		}
		const args_: Record<string, unknown> = {};
		let mcpTool: string | undefined;
		for (let index = 1; index < rest.length; index += 2) {
			const flag = rest[index];
			const flagValue = rest[index + 1] ?? "";
			if (flag === "--tool") mcpTool = flagValue;
			else if (flag === "--arg") {
				const equals = flagValue.indexOf("=");
				if (equals < 1) throw new Error("--arg takes NAME=VALUE");
				args_[flagValue.slice(0, equals)] = flagValue.slice(equals + 1);
			}
		}
		const outcome = await callCatalogTool(tool, args_, { mcpTool });
		console.log(`${outcome.ok ? "OK" : "Failed"}: ${outcome.summary}\n${outcome.output}`);
		if (!outcome.ok) process.exitCode = 1;
		return;
	}
	throw new Error(`Usage:\n${SECRETS_USAGE}`);
}
