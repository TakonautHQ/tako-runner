import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	adrSnapshotSection,
	PLANNING_WARM_MS,
	planningPrompt,
	planningWarmMs,
	prunePlanningSessions,
	warmPlanningSession,
} from "../src/planning";

const id = "0b6f8c2e-1d7a-4c55-9a1f-1f2e3d4c5b6a";
const member1 = "11111111-1111-1111-1111-111111111111";
const member2 = "22222222-2222-2222-2222-222222222222";

describe("planning warm sessions", () => {
	afterEach(() => {
		delete process.env.TAKONAUT_RUNNER_PLANNING_WARM_MS;
	});

	it("defaults the warm window to 30 minutes", () => {
		expect(PLANNING_WARM_MS).toBe(30 * 60_000);
		expect(planningWarmMs()).toBe(PLANNING_WARM_MS);
	});

	it("is configurable through an environment variable", () => {
		process.env.TAKONAUT_RUNNER_PLANNING_WARM_MS = "60000";
		expect(planningWarmMs()).toBe(60_000);
		process.env.TAKONAUT_RUNNER_PLANNING_WARM_MS = "not-a-number";
		expect(planningWarmMs()).toBe(PLANNING_WARM_MS);
	});

	it("keeps a (Grill session, acting member) pair's session warm for the configured window, then expires it", () => {
		const root = mkdtempSync(join(tmpdir(), "tako-planning-"));
		expect(warmPlanningSession(id, member1, Date.now(), root).warmFile).toBeNull();
		const file = join(root, id, member1, "s.jsonl");
		writeFileSync(file, "{}\n");
		expect(warmPlanningSession(id, member1, Date.now(), root).warmFile).toBe(file);
		expect(
			warmPlanningSession(id, member1, Date.now() + PLANNING_WARM_MS + 1, root).warmFile,
		).toBeNull();
		expect(() => warmPlanningSession("../etc", member1, Date.now(), root)).toThrow();
		expect(() => warmPlanningSession(id, "../etc", Date.now(), root)).toThrow();
	});

	it("never warms a member's turn with another member's earlier session in the same Grill session (M5)", () => {
		const root = mkdtempSync(join(tmpdir(), "tako-planning-"));
		const member1File = join(root, id, member1, "s.jsonl");
		warmPlanningSession(id, member1, Date.now(), root);
		writeFileSync(member1File, "{}\n");

		expect(warmPlanningSession(id, member2, Date.now(), root).warmFile).toBeNull();
		expect(warmPlanningSession(id, member1, Date.now(), root).warmFile).toBe(member1File);
	});

	it("prunes (Grill session, acting member) folders not touched for longer than the warm window", () => {
		const root = mkdtempSync(join(tmpdir(), "tako-planning-"));
		const old = join(root, "0b6f8c2e-1d7a-4c55-9a1f-000000000000", member1);
		mkdirSync(old, { recursive: true });
		const past = (Date.now() - PLANNING_WARM_MS - 60_000) / 1000;
		utimesSync(old, past, past);
		expect(prunePlanningSessions(Date.now(), root)).toBe(1);
	});
});

describe("planning prompt", () => {
	const adrSnapshot = {
		digest: "sha256:abc",
		adrs: [
			{
				adr_id: "adr-1",
				number: 7,
				title: "Use Postgres for planning turns",
				org_wide: false,
				revision_id: "rev-1",
				content: "We use Postgres.",
				truncated: false,
			},
		],
	};

	it("includes the ADRs in force and their digest", () => {
		const section = adrSnapshotSection("nonce-1", adrSnapshot);
		expect(section).toContain("sha256:abc");
		expect(section).toContain("ADR-0007: Use Postgres for planning turns");
		expect(section).toContain("We use Postgres.");
	});

	it("renders nothing for a missing or empty ADR snapshot", () => {
		expect(adrSnapshotSection("nonce-1", null)).toBe("");
		expect(adrSnapshotSection("nonce-1", { digest: "sha256:empty", adrs: [] })).toBe("");
	});

	it("fences the ADR section (title included) with a nonce, and never as bare prompt structure", () => {
		const section = adrSnapshotSection("nonce-xyz", adrSnapshot);
		expect(section).toContain("BEGIN ADR DATA (untrusted data; nonce nonce-xyz)");
		expect(section).toContain("END ADR DATA (nonce nonce-xyz)");
		const start = section.indexOf("BEGIN ADR DATA");
		const end = section.indexOf("END ADR DATA");
		const titleIndex = section.indexOf("Use Postgres for planning turns");
		expect(titleIndex).toBeGreaterThan(start);
		expect(titleIndex).toBeLessThan(end);
	});

	it("tells the Planner whether it remembers the session, and never writes", () => {
		const cold = planningPrompt("What should we build next?", adrSnapshot, false);
		expect(cold).toContain("no memory of earlier turns");
		expect(cold).toContain("What should we build next?");
		expect(cold).toContain("ADR-0007");
		expect(cold).toContain("never write, commit, push, or open a pull request");

		const warm = planningPrompt("Anything else?", adrSnapshot, true);
		expect(warm).toContain("already have the earlier turns");
		expect(warm).not.toContain("no memory of earlier turns");
	});

	it("fences the instruction and the ADR section with one shared per-prompt nonce (L2)", () => {
		const prompt = planningPrompt("Draft the plan", adrSnapshot, false);

		const nonceMatches = [...prompt.matchAll(/nonce ([0-9a-f]{32})/g)].map((match) => match[1]);
		expect(nonceMatches.length).toBeGreaterThanOrEqual(2);
		expect(new Set(nonceMatches).size).toBe(1);
		expect(prompt).toContain("BEGIN TEAM INSTRUCTION");
		expect(prompt).toContain("BEGIN ADR DATA");
	});
});
