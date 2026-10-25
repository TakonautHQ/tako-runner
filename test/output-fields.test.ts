import { describe, expect, it } from "vitest";
import { checkFields, fieldsPrompt, outputFields } from "../src/output-fields";

const fields = outputFields({
	output_fields: [
		{ name: "severity", type: "choice", choices: ["low", "high"], required: true },
		{ name: "users", type: "number" },
		{ name: "regression", type: "yes_no" },
	],
});

describe("output fields", () => {
	it("asks for JSON and checks every field", () => {
		expect(fieldsPrompt(fields)).toContain('"severity": one of "low", "high" (required)');
		expect(checkFields(fields, '```json\n{"severity":"high","users":12,"regression":false}\n```')).toEqual({
			values: { severity: "high", users: 12, regression: false },
			problems: [],
		});
		const bad = checkFields(fields, 'Sure! {"severity":"medium","users":"12"}');
		expect(bad.problems).toEqual(["severity must be one of low, high", "users must be number"]);
		expect(checkFields(fields, "no json").problems).toEqual(["it was not one JSON object"]);
		expect(fieldsPrompt(fields, ["users must be number"])).toMatch(/^That didn't fit: users must be number/);
	});
});
