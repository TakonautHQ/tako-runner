/**
 * Secrets typed in the browser, sealed so only this Runner can open them.
 *
 * The Runner keeps a P-256 key pair; only the public half leaves the machine.
 * The browser derives a one-off key with ECDH + HKDF-SHA256 and encrypts the
 * value with AES-256-GCM, bound to this key's fingerprint and the secret's
 * name. Takonaut stores only the sealed value until the Runner picks it up.
 * Someone checks the fingerprint once against `tako-runner secrets fingerprint`,
 * so a swapped key would show.
 */
import {
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultSecretsPath, SECRET_NAME, setSecret } from "./secrets";

const INFO = "takonaut-runner-secret-v1";

export interface SealingKey {
	/** SubjectPublicKeyInfo (DER), base64. */
	publicKeyB64: string;
	privateKeyPem: string;
}

export interface SealedEnvelope {
	v: 1;
	/** The fingerprint of the key it was sealed for. */
	kid: string;
	/** The browser's one-off public key, SPKI base64. */
	epk: string;
	salt: string;
	iv: string;
	/** Ciphertext with the GCM tag at the end, base64. */
	ct: string;
}

export function defaultSealingKeyPath(): string {
	return process.env.TAKONAUT_RUNNER_SEALING_KEY ?? join(homedir(), ".takonaut", "runner-sealing-key.json");
}

/** This Runner's sealing key, made on first use and kept owner-only. */
export function loadOrCreateSealingKey(path = defaultSealingKeyPath()): SealingKey {
	if (existsSync(path)) {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SealingKey> & { version?: number };
		if (parsed.version === 1 && parsed.publicKeyB64 && parsed.privateKeyPem?.includes("PRIVATE KEY")) {
			return { publicKeyB64: parsed.publicKeyB64, privateKeyPem: parsed.privateKeyPem };
		}
		throw new Error(`Sealing key ${path} is not a version 1 key`);
	}
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const key = {
		publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
		privateKeyPem: String(privateKey.export({ type: "pkcs8", format: "pem" })),
	};
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ version: 1, ...key }, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
	return key;
}

/** SHA-256 of the public key, first 16 bytes as eight groups: what people compare. */
export function sealingFingerprint(publicKeyB64: string): string {
	const hex = createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex").toUpperCase();
	return (hex.slice(0, 32).match(/.{4}/g) ?? []).join(" ");
}

/** The secret's value; throws when it was sealed for another key or name, or was altered. */
export function openSealedSecret(envelope: SealedEnvelope, name: string, key: SealingKey): string {
	const kid = sealingFingerprint(key.publicKeyB64);
	if (envelope?.v !== 1 || envelope.kid !== kid) {
		throw new Error("It was sealed for a different key. Enter it again.");
	}
	try {
		const shared = diffieHellman({
			privateKey: createPrivateKey(key.privateKeyPem),
			publicKey: createPublicKey({ key: Buffer.from(envelope.epk, "base64"), format: "der", type: "spki" }) as KeyObject,
		});
		const aesKey = Buffer.from(hkdfSync("sha256", shared, Buffer.from(envelope.salt, "base64"), INFO, 32));
		const sealed = Buffer.from(envelope.ct, "base64");
		const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(envelope.iv, "base64"));
		decipher.setAAD(Buffer.from(`${kid}\n${name}`, "utf8"));
		decipher.setAuthTag(sealed.subarray(sealed.length - 16));
		return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString("utf8");
	} catch {
		throw new Error("The value could not be opened. Enter it again.");
	}
}

export interface SealedSecretsApi {
	listSealedSecrets(): Promise<{ id: string; name: string; envelope: SealedEnvelope }[]>;
	ackSealedSecrets(ack: { delivered: string[]; failed: { id: string; error: string }[] }): Promise<unknown>;
}

/** Open and store every secret waiting for this Runner; returns the names stored. */
export async function deliverSealedSecrets(
	api: SealedSecretsApi,
	options: { key?: SealingKey; secretsPath?: string } = {},
): Promise<string[]> {
	const waiting = await api.listSealedSecrets();
	if (waiting.length === 0) return [];
	const key = options.key ?? loadOrCreateSealingKey();
	const delivered: string[] = [];
	const names: string[] = [];
	const failed: { id: string; error: string }[] = [];
	for (const item of waiting) {
		try {
			if (!SECRET_NAME.test(item.name)) throw new Error("Invalid secret name");
			setSecret(item.name, openSealedSecret(item.envelope, item.name, key), {
				path: options.secretsPath ?? defaultSecretsPath(),
			});
			delivered.push(item.id);
			names.push(item.name);
		} catch (error) {
			failed.push({ id: item.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
		}
	}
	await api.ackSealedSecrets({ delivered, failed });
	return names;
}

/** The public key to advertise, or undefined when the key can't be read or made. */
export function safeSealingPublicKey(path = defaultSealingKeyPath()): string | undefined {
	try {
		return loadOrCreateSealingKey(path).publicKeyB64;
	} catch (error) {
		console.error(`Runner sealing key unusable: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}
