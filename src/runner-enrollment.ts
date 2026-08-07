export interface RunnerEnrollmentHttpResult {
	status: number;
	json: unknown;
}

export interface RunnerEnrollmentDeps {
	fetchJson(
		method: "POST",
		path: string,
		body?: unknown,
	): Promise<RunnerEnrollmentHttpResult>;
	sleep(ms: number): Promise<void>;
	log(message: string): void;
	openUrl?(url: string): void;
}

export interface RunnerEnrollmentRequest {
	name: string;
	capacity: number;
}

export interface RunnerEnrollmentResult {
	serverUrl: string;
	credential: string;
	organizationId: string;
	organizationName: string;
	runnerId: string;
	projects: string[];
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Takonaut returned an invalid Runner enrollment response");
	}
	return value as JsonObject;
}

function string(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) {
		throw new Error(`Takonaut Runner enrollment response is missing ${field}`);
	}
	return value;
}

function isLoopback(hostname: string): boolean {
	return (
		hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
	);
}

export function normalizeRunnerEnrollmentServerUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Runner server URL must be a valid URL");
	}
	if (parsed.username || parsed.password) {
		throw new Error("Runner server URL must not contain credentials");
	}
	if (
		parsed.protocol !== "https:" &&
		!(parsed.protocol === "http:" && isLoopback(parsed.hostname))
	) {
		throw new Error(
			"Runner enrollment requires HTTPS except for loopback development",
		);
	}
	if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
		throw new Error("Runner server URL must contain only an origin");
	}
	return parsed.origin;
}

function sameOriginEnrollmentUrl(serverUrl: string, value: unknown): string {
	const url = new URL(string(value, "verification_uri_complete"));
	if (url.origin !== new URL(serverUrl).origin) {
		throw new Error(
			"Runner verification URL must use the same origin as Takonaut",
		);
	}
	if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
		throw new Error("Runner verification URL must use HTTPS");
	}
	return url.toString();
}

function consumedError(json: unknown): Error | undefined {
	const payload = object(json);
	if (!payload.detail || typeof payload.detail !== "object") return undefined;
	const detail = payload.detail as JsonObject;
	if (detail.code !== "RUNNER_ENROLLMENT_CONSUMED") return undefined;
	const runnerId =
		typeof detail.runner_id === "string" ? detail.runner_id : "unknown";
	return new Error(
		`Runner ${runnerId} was enrolled but its credential was already delivered. ` +
			"Rotate or revoke that Runner in Takonaut, then enroll again.",
	);
}

export async function runRunnerEnrollment(
	serverUrlValue: string,
	request: RunnerEnrollmentRequest,
	deps: RunnerEnrollmentDeps,
	maxPolls = 120,
): Promise<RunnerEnrollmentResult> {
	const serverUrl = normalizeRunnerEnrollmentServerUrl(serverUrlValue);
	const name = request.name.trim();
	if (!name) throw new Error("Runner name is required");
	if (
		!Number.isInteger(request.capacity) ||
		request.capacity < 1 ||
		request.capacity > 32
	) {
		throw new Error("Runner capacity must be an integer from 1 to 32");
	}

	const started = await deps.fetchJson("POST", "/api/runner/enrollment/start", {
		name,
		capacity: request.capacity,
	});
	if (started.status !== 200) {
		throw new Error(`Runner enrollment start failed: HTTP ${started.status}`);
	}
	const start = object(started.json);
	const deviceCode = string(start.device_code, "device_code");
	const userCode = string(start.user_code, "user_code");
	const verificationUrl = sameOriginEnrollmentUrl(
		serverUrl,
		start.verification_uri_complete,
	);
	const bareVerificationUrl = sameOriginEnrollmentUrl(
		serverUrl,
		start.verification_uri,
	);

	deps.log("");
	deps.log("Open Takonaut and approve this unattended Runner:");
	deps.log(`  ${verificationUrl}`);
	deps.log(`Or open ${bareVerificationUrl} and enter code:  ${userCode}`);
	deps.log("");
	deps.log("Waiting for approval…");
	deps.openUrl?.(verificationUrl);

	const intervalSeconds = Number(start.interval ?? 5);
	const pollMs = Number.isFinite(intervalSeconds)
		? Math.max(1, intervalSeconds) * 1_000
		: 5_000;
	for (let attempt = 0; attempt < maxPolls; attempt += 1) {
		const token = await deps.fetchJson("POST", "/api/runner/enrollment/token", {
			device_code: deviceCode,
		});
		if (token.status === 200) {
			const payload = object(token.json);
			const runner = object(payload.runner);
			const projectValues = runner.project_ids;
			if (
				!Array.isArray(projectValues) ||
				projectValues.some((value) => typeof value !== "string")
			) {
				throw new Error(
					"Takonaut Runner enrollment response has invalid Projects",
				);
			}
			const credential = string(payload.credential, "credential");
			if (!credential.startsWith("tkr_")) {
				throw new Error(
					"Takonaut returned an invalid Runner machine credential",
				);
			}
			deps.log("✓ Runner approved. Saving its machine credential locally.");
			return {
				serverUrl,
				credential,
				organizationId: string(runner.organization_id, "organization_id"),
				organizationName: string(
					payload.organization_name,
					"organization_name",
				),
				runnerId: string(runner.id, "runner_id"),
				projects: projectValues as string[],
			};
		}
		if (token.status === 428) {
			await deps.sleep(pollMs);
			continue;
		}
		if (token.status === 409) {
			const consumed = consumedError(token.json);
			if (consumed) throw consumed;
		}
		throw new Error(
			`Runner enrollment token exchange failed: HTTP ${token.status}`,
		);
	}
	throw new Error("Timed out waiting for Runner approval");
}
