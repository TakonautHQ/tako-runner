/**
 * Output fields: values an Agent fills in on every result (severity,
 * root_cause …). After the answer, the Runner asks the model for them as one
 * JSON object, checks them, and asks once more if they don't fit.
 */
export interface OutputField {
	name: string;
	type: "text" | "number" | "yes_no" | "choice";
	description?: string;
	required?: boolean;
	choices?: string[];
}

export function outputFields(snapshot: unknown): OutputField[] {
	const fields = (snapshot as { output_fields?: unknown } | null)?.output_fields;
	return Array.isArray(fields)
		? fields.filter(
				(field): field is OutputField =>
					!!field && typeof field === "object" && typeof (field as OutputField).name === "string",
			)
		: [];
}

export function fieldsPrompt(fields: OutputField[], problems: string[] = []): string {
	const lines = fields.map((field) => {
		const kind =
			field.type === "choice"
				? `one of ${(field.choices ?? []).map((choice) => JSON.stringify(choice)).join(", ")}`
				: field.type === "yes_no"
					? "true or false"
					: field.type === "number"
						? "a number"
						: "text";
		return `- "${field.name}": ${kind}${field.required ? " (required)" : " (or omit)"}${field.description ? ` — ${field.description}` : ""}`;
	});
	return `${problems.length ? `That didn't fit: ${problems.join("; ")}.\n\n` : ""}Now reply with ONLY one JSON object, no prose, with these fields from your answer:
${lines.join("\n")}`;
}

/** Parse and check the model's JSON; returns values and problems. */
export function checkFields(
	fields: OutputField[],
	text: string,
): { values: Record<string, unknown>; problems: string[] } {
	const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1));
	} catch {
		return { values: {}, problems: ["it was not one JSON object"] };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { values: {}, problems: ["it was not one JSON object"] };
	}
	const values: Record<string, unknown> = {};
	const problems: string[] = [];
	for (const field of fields) {
		const value = (parsed as Record<string, unknown>)[field.name];
		if (value === undefined || value === null) {
			if (field.required) problems.push(`${field.name} is required`);
			continue;
		}
		const ok =
			(field.type === "text" && typeof value === "string") ||
			(field.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
			(field.type === "yes_no" && typeof value === "boolean") ||
			(field.type === "choice" && (field.choices ?? []).includes(value as string));
		if (ok) values[field.name] = typeof value === "string" ? value.slice(0, 2_000) : value;
		else problems.push(`${field.name} must be ${field.type === "choice" ? `one of ${(field.choices ?? []).join(", ")}` : field.type}`);
	}
	return { values, problems };
}
