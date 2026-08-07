#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [version, sha256, output] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
	throw new Error("Usage: render-homebrew-formula VERSION SHA256 OUTPUT");
}
if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256) || !output) {
	throw new Error(
		"SHA256 must be 64 hexadecimal characters and OUTPUT is required",
	);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const template = readFileSync(
	join(root, "packaging", "homebrew", "tako-runner.rb.template"),
	"utf8",
);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(
	output,
	template.replaceAll("@@VERSION@@", version).replaceAll("@@SHA256@@", sha256),
);
