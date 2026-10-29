/**
 * Mockup Runs: draft a new Mockup, or regenerate one from the team's comments.
 *
 * - A person asked for it explicitly in Takonaut (New Mockup → Draft with
 *   agent, or Regenerate). The Run is read-only, like a planning Run: the
 *   worktree is checked out at a pinned commit so the agent can match the
 *   product's real UI, but it never changes, commits or pushes anything, and
 *   only the Agent's exactly granted organization tools are offered.
 * - Everything the agent needs travels in the claim: the current source, the
 *   chosen comments with where they point (a pin, or an area), the person's
 *   note or description, and the work item's published text.
 * - The agent answers with the complete new source in one ```takonaut-mockup
 *   block; Takonaut validates, saves and publishes it, and marks the comments
 *   it was given as addressed.
 */
import { fenceNonce, fenceUntrustedData } from "./prompt-fence";

export type MockupKind = "html" | "mermaid" | "excalidraw";

export interface MockupComment {
	label: string;
	comments: string[];
	where?: { x: number; y: number; width?: number; height?: number };
}

export interface MockupJob {
	jobKind: "draft" | "regenerate";
	mockupKind: MockupKind;
	title: string;
	request: string | null;
	source: unknown;
	comments: MockupComment[];
	workItem: { title: string; text: string } | null;
	agentName: string | null;
}

const KINDS: MockupKind[] = ["html", "mermaid", "excalidraw"];

const FORMAT: Record<MockupKind, string> = {
	html: "one self-contained HTML file (inline CSS and JS only; no external scripts, fonts, images or network requests; it runs sandboxed). Keep it under 150 KB.",
	mermaid: "Mermaid diagram text that starts with the diagram type (for example `flowchart TD`). No surrounding ```mermaid fence. Keep it under 40 KB.",
	excalidraw:
		'one Excalidraw scene as JSON: an object with an "elements" array (and "appState" if you need it). Every element needs a string "id" and a "type". Keep existing element ids for elements you keep. Keep it under 150 KB.',
};

/** The Mockup job from a claim, or null when this isn't a usable Mockup Run. */
export function claimMockupJob(payload: unknown): MockupJob | null {
	const job = (payload as { mockup_job?: unknown } | null)?.mockup_job as Record<string, unknown> | undefined;
	if (!job || typeof job !== "object") return null;
	const jobKind = job.job_kind === "draft" || job.job_kind === "regenerate" ? job.job_kind : null;
	const mockupKind = KINDS.includes(job.mockup_kind as MockupKind) ? (job.mockup_kind as MockupKind) : null;
	if (!jobKind || !mockupKind) return null;
	const comments = Array.isArray(job.comments)
		? job.comments
				.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
				.map((entry) => ({
					label: typeof entry.label === "string" ? entry.label : "Comment",
					comments: Array.isArray(entry.comments)
						? entry.comments.filter((body): body is string => typeof body === "string")
						: [],
					where:
						entry.where && typeof entry.where === "object"
							? (entry.where as MockupComment["where"])
							: undefined,
				}))
		: [];
	const workItem =
		job.work_item && typeof job.work_item === "object"
			? (job.work_item as { title?: unknown; text?: unknown })
			: null;
	return {
		jobKind,
		mockupKind,
		title: typeof job.title === "string" ? job.title : "Mockup",
		request: typeof job.request === "string" && job.request.trim() ? job.request : null,
		source: job.source ?? null,
		comments,
		workItem:
			workItem && typeof workItem.title === "string"
				? { title: workItem.title, text: typeof workItem.text === "string" ? workItem.text : "" }
				: null,
		agentName: typeof job.agent_name === "string" ? job.agent_name : null,
	};
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

/** Where a comment points, in words the model can use. */
export function describeWhere(where: MockupComment["where"]): string {
	if (!where || typeof where.x !== "number" || typeof where.y !== "number") return "the whole Mockup";
	if (typeof where.width === "number" && typeof where.height === "number") {
		return `the area from ${percent(where.x)} across, ${percent(where.y)} down, ${percent(where.width)} wide and ${percent(where.height)} tall`;
	}
	return `the spot ${percent(where.x)} across and ${percent(where.y)} down`;
}

/** The current source as text, the way the agent should give it back. */
export function sourceText(kind: MockupKind, source: unknown): string {
	if (source && typeof source === "object") {
		if (kind === "html" && typeof (source as { html?: unknown }).html === "string") {
			return (source as { html: string }).html;
		}
		if (kind === "mermaid" && typeof (source as { text?: unknown }).text === "string") {
			return (source as { text: string }).text;
		}
		return JSON.stringify(source, null, 2);
	}
	return typeof source === "string" ? source : "";
}

export function mockupPrompt(job: MockupJob): string {
	const nonce = fenceNonce();
	const kindName = { html: "HTML prototype", mermaid: "Mermaid diagram", excalidraw: "Excalidraw wireframe" }[job.mockupKind];
	const sections: string[] = [];
	sections.push(
		job.jobKind === "draft"
			? `Draft a new ${kindName} titled ${JSON.stringify(job.title)} for your team in Takonaut.`
			: `Regenerate the ${kindName} titled ${JSON.stringify(job.title)}: make a new version that addresses the team's comments below, and keep everything they didn't ask to change.`,
	);
	if (job.request) {
		sections.push(
			fenceUntrustedData(job.jobKind === "draft" ? "WHAT THE MOCKUP SHOULD SHOW" : "NOTE FROM THE PERSON WHO ASKED", nonce, job.request),
		);
	}
	if (job.workItem) {
		sections.push(
			fenceUntrustedData(
				"THE WORK ITEM IT IS FOR (published text)",
				nonce,
				`${job.workItem.title}\n\n${job.workItem.text || "(no text yet)"}`,
			),
		);
	}
	if (job.jobKind === "regenerate") {
		sections.push(fenceUntrustedData("CURRENT SOURCE", nonce, sourceText(job.mockupKind, job.source)));
		if (job.comments.length > 0) {
			const comments = job.comments
				.map(
					(comment) =>
						`${comment.label}, on ${describeWhere(comment.where)} of the rendered Mockup:\n${comment.comments
							.map((body, index) => `${index === 0 ? "- " : "  - reply: "}${body}`)
							.join("\n")}`,
				)
				.join("\n\n");
			sections.push(
				`Positions are fractions of the rendered Mockup, from its top-left corner. Work out which element each comment is about from where it points and what it says.\n${fenceUntrustedData("THE TEAM'S COMMENTS", nonce, comments)}`,
			);
		}
	}
	sections.push(
		"The product's code is checked out read-only in your working directory. Look at its UI (components, styles, copy) when it helps the Mockup match the real product. Don't change any files.",
	);
	sections.push(
		`Reply with one or two sentences on what you made or changed, then the COMPLETE ${job.jobKind === "draft" ? "" : "new "}source as ${FORMAT[job.mockupKind]} Put the source in exactly one fenced block whose info string is takonaut-mockup, like this:\n\n\`\`\`takonaut-mockup\n...the complete source...\n\`\`\`\n\nNothing after the block. Takonaut checks the source, saves it as a new version and publishes it.`,
	);
	return sections.join("\n\n");
}
