/**
 * Secrets for organization tools, kept only on this machine.
 *
 * Takonaut knows a tool needs `ADMIN_API_TOKEN`; only this file (owner-only,
 * `~/.takonaut/secrets.json`) or, opt-in, the macOS Keychain knows its value.
 * Tools reference secrets as `${secret:NAME}`; values are resolved when a tool
 * is called and redacted from everything the Runner reports or shows a model.
 *
 * The background service can't answer Keychain prompts, so the file is the
 * default. `tako-runner doctor` reads every secret the way the service does.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const SECRET_REF = /\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g;
const KEYCHAIN_SERVICE = "takonaut-runner";

interface SecretEntry {
	value?: string;
	keychain?: true;
}

interface SecretFile {
	version: 1;
	secrets: Record<string, SecretEntry>;
}

export function defaultSecretsPath(): string {
	return process.env.TAKONAUT_RUNNER_SECRETS ?? join(homedir(), ".takonaut", "secrets.json");
}

function load(path: string): SecretFile {
	if (!existsSync(path)) return { version: 1, secrets: {} };
	const parsed = JSON.parse(readFileSync(path, "utf8")) as SecretFile;
	if (parsed?.version !== 1 || typeof parsed.secrets !== "object") {
		throw new Error(`Secrets file ${path} is not a version 1 secrets file`);
	}
	return parsed;
}

function save(file: SecretFile, path: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
}

export function validateSecretName(name: string): string {
	if (!SECRET_NAME.test(name)) {
		throw new Error("Secret names are capital letters, digits and underscores, e.g. ADMIN_API_TOKEN");
	}
	return name;
}

export interface SecretStore {
	get(name: string): string | undefined;
	names(): string[];
}

function keychainRead(name: string): string | undefined {
	try {
		return execFileSync(
			"/usr/bin/security",
			["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"],
			{ encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
		).replace(/\n$/, "");
	} catch {
		return undefined;
	}
}

export function secretStore(path = defaultSecretsPath()): SecretStore {
	const file = load(path);
	const cache = new Map<string, string | undefined>();
	return {
		get(name) {
			if (cache.has(name)) return cache.get(name);
			const entry = file.secrets[name];
			const value = entry?.keychain ? keychainRead(name) : entry?.value;
			cache.set(name, value);
			return value;
		},
		names: () => Object.keys(file.secrets).sort(),
	};
}

export function setSecret(
	name: string,
	value: string,
	options: { keychain?: boolean; path?: string } = {},
): void {
	validateSecretName(name);
	if (!value) throw new Error("The secret is empty");
	const path = options.path ?? defaultSecretsPath();
	const file = load(path);
	if (options.keychain) {
		if (process.platform !== "darwin") throw new Error("--keychain works on macOS only");
		execFileSync(
			"/usr/bin/security",
			["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", name, "-w", value],
			{ timeout: 10_000, stdio: "ignore" },
		);
		file.secrets[name] = { keychain: true };
	} else {
		file.secrets[name] = { value };
	}
	save(file, path);
}

export function unsetSecret(name: string, path = defaultSecretsPath()): boolean {
	const file = load(path);
	if (!(name in file.secrets)) return false;
	if (file.secrets[name]?.keychain) {
		try {
			execFileSync("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name], {
				timeout: 10_000,
				stdio: "ignore",
			});
		} catch {
			// Already gone from the Keychain.
		}
	}
	delete file.secrets[name];
	save(file, path);
	return true;
}

/** Parse KEY=VALUE lines (comments and blanks ignored, optional quotes). */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2] ?? "";
		if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
		out[(match[1] ?? "").toUpperCase()] = value;
	}
	return out;
}

/** Secret names referenced anywhere in a value. */
export function referencedSecrets(value: unknown): string[] {
	const found = new Set<string>();
	const walk = (item: unknown) => {
		if (typeof item === "string") {
			for (const match of item.matchAll(SECRET_REF)) found.add(match[1] as string);
		} else if (Array.isArray(item)) item.forEach(walk);
		else if (item && typeof item === "object") Object.values(item).forEach(walk);
	};
	walk(value);
	return [...found].sort();
}

export function missingSecrets(value: unknown, store: SecretStore): string[] {
	return referencedSecrets(value).filter((name) => !store.get(name));
}

/** Replace `${secret:NAME}` with values; remembers what it used for redaction. */
export function resolveSecrets(text: string, store: SecretStore, used: Set<string>): string {
	return text.replace(SECRET_REF, (_whole, name: string) => {
		const value = store.get(name);
		if (value === undefined) throw new Error(`Secret ${name} is not set on this Runner. Run: tako-runner secrets set ${name}`);
		used.add(value);
		return value;
	});
}
