/**
 * Redaction applied to every tool output before it is shown to a model,
 * stored, or sent to Takonaut: secret values the tool used, common token
 * shapes, and (opt-in) emails and phone numbers.
 */
const TOKEN_PATTERNS: RegExp[] = [
	/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
	/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\btkr_[A-Za-z0-9_-]{16,}\b/g,
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /(?<![\w-])\+?\d[\d ().-]{8,}\d(?![\w-])/g;

export interface RedactOptions {
	secrets?: Iterable<string>;
	personalData?: boolean;
}

export function redact(text: string, options: RedactOptions = {}): string {
	let out = text;
	const values = [...(options.secrets ?? [])].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length);
	for (const value of values) out = out.split(value).join("[redacted secret]");
	for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "[redacted token]");
	if (options.personalData) out = out.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
	return out;
}
