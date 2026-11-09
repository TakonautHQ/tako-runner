import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECRET_PATHS } from "../src/sandbox";
import {
	deliverSealedSecrets,
	loadOrCreateSealingKey,
	openSealedSecret,
	type SealedEnvelope,
	sealingFingerprint,
} from "../src/sealed-secrets";
import { secretStore } from "../src/secrets";
import { RunnerApiClient } from "../src/runner";

const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");

/** What the browser does (frontend/src/lib/sealed-secrets.ts), with WebCrypto. */
async function sealLikeTheBrowser(publicKeyB64: string, name: string, value: string): Promise<SealedEnvelope> {
	const subtle = globalThis.crypto.subtle;
	const runnerKey = await subtle.importKey("spki", Buffer.from(publicKeyB64, "base64"), { name: "ECDH", namedCurve: "P-256" }, false, []);
	const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const shared = await subtle.deriveBits({ name: "ECDH", public: runnerKey }, ephemeral.privateKey, 256);
	const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
	const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
	const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
	const kid = sealingFingerprint(publicKeyB64);
	const key = await subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("takonaut-runner-secret-v1") },
		hkdf,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt"],
	);
	const ct = await subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${kid}\n${name}`) },
		key,
		new TextEncoder().encode(value),
	);
	return {
		v: 1,
		kid,
		epk: b64(await subtle.exportKey("spki", ephemeral.publicKey)),
		salt: b64(salt),
		iv: b64(iv),
		ct: b64(ct),
	};
}

describe("sealed secrets", () => {
	it("keeps one owner-only key the sandbox can't read, with a short fingerprint", () => {
		const path = join(mkdtempSync(join(tmpdir(), "tako-seal-")), "runner-sealing-key.json");
		const key = loadOrCreateSealingKey(path);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(loadOrCreateSealingKey(path).publicKeyB64).toBe(key.publicKeyB64);
		expect(sealingFingerprint(key.publicKeyB64)).toMatch(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/);
		expect(SECRET_PATHS).toContain(".takonaut/runner-sealing-key.json");
	});

	it("opens what the browser sealed, only for that name and key", async () => {
		const key = loadOrCreateSealingKey(join(mkdtempSync(join(tmpdir(), "tako-seal-")), "k.json"));
		const envelope = await sealLikeTheBrowser(key.publicKeyB64, "AWS_SECRET_ACCESS_KEY", "s3cr3t/value");
		expect(openSealedSecret(envelope, "AWS_SECRET_ACCESS_KEY", key)).toBe("s3cr3t/value");
		// Takonaut can't move a sealed value to another secret name.
		expect(() => openSealedSecret(envelope, "OTHER", key)).toThrow(/could not be opened/);
		const other = loadOrCreateSealingKey(join(mkdtempSync(join(tmpdir(), "tako-seal-")), "k.json"));
		expect(() => openSealedSecret(envelope, "AWS_SECRET_ACCESS_KEY", other)).toThrow(/different key/);
	});

	it("stores delivered secrets and reports which it couldn't open", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tako-seal-"));
		const key = loadOrCreateSealingKey(join(dir, "k.json"));
		const secretsPath = join(dir, "secrets.json");
		const good = await sealLikeTheBrowser(key.publicKeyB64, "TOKEN", "abc");
		const acks: unknown[] = [];
		const delivered = await deliverSealedSecrets(
			{
				listSealedSecrets: async () => [
					{ id: "1", name: "TOKEN", envelope: good },
					{ id: "2", name: "BROKEN", envelope: { ...good, ct: good.ct.slice(4) } },
				],
				ackSealedSecrets: async (ack) => {
					acks.push(ack);
				},
			},
			{ key, secretsPath },
		);
		expect(delivered).toEqual(["TOKEN"]);
		expect(secretStore(secretsPath).get("TOKEN")).toBe("abc");
		expect(acks).toEqual([{ delivered: ["1"], failed: [{ id: "2", error: "The value could not be opened. Enter it again." }] }]);
	});
});

describe("advertising the sealing key", () => {
	it("sends it, and advertises without it to a Takonaut that refuses it", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			bodies.push(body);
			if ("sealing_public_key" in body) {
				return new Response(JSON.stringify({ detail: [{ loc: ["body", "sealing_public_key"], msg: "Extra inputs are not permitted" }] }), { status: 422 });
			}
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
		await api.advertiseCapabilities();
		expect(bodies.map((body) => "sealing_public_key" in body)).toEqual([true, false]);
		await api.advertiseCapabilities();
		expect(bodies.map((body) => "sealing_public_key" in body)).toEqual([true, false, false]);
	});
});
