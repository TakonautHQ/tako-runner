/** Path segments the Runner never reads, indexes or exposes. */
const SECRET_SEGMENTS = new Set([
	".aws",
	".docker",
	".env",
	".git",
	".gnupg",
	".kube",
	".netrc",
	".npmrc",
	".pypirc",
	".ssh",
	"credentials",
	"id_dsa",
	"id_ed25519",
	"id_rsa",
]);

export function isSensitiveSegment(value: string): boolean {
	const lower = value.toLowerCase();
	return (
		SECRET_SEGMENTS.has(lower) ||
		lower.startsWith(".env.") ||
		lower.endsWith(".env") ||
		/^(?:credentials?|secrets?|tokens?|auth)(?:\..+)?$/.test(lower) ||
		lower.endsWith(".pem") ||
		lower.endsWith(".key") ||
		lower.endsWith(".p8") ||
		lower.endsWith(".p12") ||
		lower.endsWith(".pfx")
	);
}
