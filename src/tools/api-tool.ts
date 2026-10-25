/**
 * API call tools: one HTTP request built from a spec Takonaut sends.
 *
 * Safety rules, all enforced here on the Runner:
 * - Arguments only fill `{name}` placeholders in the path, query, headers and
 *   body; they are URL-encoded and can never change the scheme or host.
 * - The host must be one of the spec's `allowed_hosts`. DNS answers in
 *   private, loopback or link-local ranges are refused unless the spec says
 *   the service is on a private network.
 * - Redirects are not followed.
 * - Secrets are resolved only here and redacted from the output.
 * - The response is capped; an optional `json_path` picks one part of it.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { redact } from "../redact";
import { type SecretStore, resolveSecrets } from "../secrets";

export interface ApiToolSpec {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	url: string;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	body?: unknown;
	input_schema?: { properties?: Record<string, unknown>; required?: string[] };
	allowed_hosts: string[];
	allow_plain_http?: boolean;
	allow_private_network?: boolean;
	response?: { max_bytes?: number; json_path?: string };
	timeout_ms?: number;
}

export interface ToolCallOutcome {
	ok: boolean;
	summary: string;
	statusCode?: number;
	output: string;
}

const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]{0,63})\}/g;
const WHOLE_PLACEHOLDER = /^\{([a-zA-Z_][a-zA-Z0-9_]{0,63})\}$/;

export function isPrivateAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const [a = 0, b = 0] = address.split(".").map(Number);
		return (
			a === 10 ||
			a === 127 ||
			a === 0 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	const lower = address.toLowerCase();
	if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
	return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

export function hostAllowed(host: string, allowed: string[]): boolean {
	const name = host.toLowerCase();
	return allowed.some((item) => name === item || (item.startsWith("*.") && name.endsWith(item.slice(1))));
}

function argText(value: unknown): string {
	return typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);
}

/** Fill placeholders; `encode` applies to argument values only. */
function fill(template: string, args: Record<string, unknown>, encode: (value: string) => string): string {
	return template.replace(PLACEHOLDER, (_whole, name: string) => encode(argText(args[name])));
}

function fillBody(value: unknown, args: Record<string, unknown>, secrets: SecretStore, used: Set<string>): unknown {
	if (typeof value === "string") {
		const whole = WHOLE_PLACEHOLDER.exec(value);
		// "{amount}" keeps the argument's type; text with placeholders stays text.
		if (whole) return args[whole[1] as string] ?? null;
		return resolveSecrets(fill(value, args, (text) => text), secrets, used);
	}
	if (Array.isArray(value)) return value.map((item) => fillBody(item, args, secrets, used));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, fillBody(item, args, secrets, used)]),
		);
	}
	return value;
}

export function buildApiRequest(
	spec: ApiToolSpec,
	args: Record<string, unknown>,
	secrets: SecretStore,
	used: Set<string>,
): { url: URL; init: { method: string; headers: Record<string, string>; body?: string } } {
	const template = new URL(spec.url.replace(PLACEHOLDER, "x"));
	const url = new URL(fill(spec.url, args, encodeURIComponent));
	if (url.protocol !== template.protocol || url.host !== template.host) {
		throw new Error("Arguments may not change where the request goes");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && spec.allow_plain_http)) {
		throw new Error("Only https requests are allowed");
	}
	if (!hostAllowed(url.hostname, spec.allowed_hosts ?? [])) {
		throw new Error(`Host ${url.hostname} is not allowed for this tool`);
	}
	for (const [name, value] of Object.entries(spec.query ?? {})) {
		url.searchParams.set(name, resolveSecrets(fill(value, args, (text) => text), secrets, used));
	}
	const headers: Record<string, string> = { Accept: "application/json" };
	for (const [name, value] of Object.entries(spec.headers ?? {})) {
		const filled = resolveSecrets(fill(value, args, (text) => text), secrets, used);
		if (/[\r\n]/.test(filled)) throw new Error(`Header ${name} may not contain line breaks`);
		headers[name] = filled;
	}
	let body: string | undefined;
	if (spec.body !== undefined && spec.body !== null) {
		body = JSON.stringify(fillBody(spec.body, args, secrets, used));
		headers["Content-Type"] ??= "application/json";
	}
	return { url, init: { method: spec.method, headers, ...(body === undefined ? {} : { body }) } };
}

export function pickJsonPath(value: unknown, path: string): unknown {
	let current: unknown = value;
	for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
		if (current === null || current === undefined) return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) return { text: "", truncated: false };
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done || !value) break;
		const room = maxBytes - size;
		if (value.length > room) {
			chunks.push(value.subarray(0, room));
			truncated = true;
			await reader.cancel();
			break;
		}
		chunks.push(value);
		size += value.length;
	}
	return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

export interface ApiToolOptions {
	secrets: SecretStore;
	fetchImpl?: typeof fetch;
	resolveHost?: (host: string) => Promise<string[]>;
	idempotencyKey?: string;
	personalData?: boolean;
	signal?: AbortSignal;
}

export async function executeApiTool(
	spec: ApiToolSpec,
	args: Record<string, unknown>,
	options: ApiToolOptions,
): Promise<ToolCallOutcome> {
	const used = new Set<string>();
	const clean = (text: string) => redact(text, { secrets: used, personalData: options.personalData });
	try {
		for (const name of spec.input_schema?.required ?? []) {
			if (args[name] === undefined || args[name] === "") throw new Error(`${name} is required`);
		}
		const { url, init } = buildApiRequest(spec, args, options.secrets, used);
		if (options.idempotencyKey) init.headers["Idempotency-Key"] = options.idempotencyKey;
		const host = url.hostname.replace(/^\[|\]$/g, "");
		const addresses = isIP(host)
			? [host]
			: await (options.resolveHost ?? (async (name) => (await lookup(name, { all: true })).map((item) => item.address)))(host);
		if (!spec.allow_private_network && addresses.some(isPrivateAddress)) {
			throw new Error(`${url.hostname} is on a private network; tick 'Private network' on the tool if that is intended`);
		}
		const timeout = AbortSignal.timeout(spec.timeout_ms ?? 15_000);
		const response = await (options.fetchImpl ?? fetch)(url, {
			...init,
			redirect: "manual",
			signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
		});
		if (response.status >= 300 && response.status < 400) {
			return {
				ok: false,
				statusCode: response.status,
				summary: `${response.status}: redirects are not followed`,
				output: clean(`Location: ${response.headers.get("location") ?? "(none)"}`),
			};
		}
		const { text, truncated } = await readCapped(response, spec.response?.max_bytes ?? 50_000);
		let output = text;
		if (spec.response?.json_path && !truncated) {
			try {
				output = JSON.stringify(pickJsonPath(JSON.parse(text), spec.response.json_path), null, 1) ?? "null";
			} catch {
				// Not JSON; return it as is.
			}
		}
		return {
			ok: response.ok,
			statusCode: response.status,
			summary: `${response.status} ${response.statusText}`.trim(),
			output: clean(truncated ? `${output}\n[truncated]` : output),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, summary: clean(message).slice(0, 300), output: clean(message) };
	}
}
