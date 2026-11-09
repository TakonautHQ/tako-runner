import { describe, expect, it } from "vitest";

import { loadTicketImages, readableTicketImages } from "../src/ticket-images";

const payload = (attachments: unknown[]) => ({ ticket_id: "t1", ticket: { number: 46, attachments } });

describe("readableTicketImages", () => {
	it("lists only images the snapshot marks readable", () => {
		const images = readableTicketImages(
			payload([
				{ filename: "report.pdf", content_type: "application/pdf" },
				{ filename: "old.webp", content_type: "image/webp", attachment_id: "a0" },
				{ filename: "error.webp", content_type: "image/webp", attachment_id: "a1", readable: true, visibility: "public" },
				{ filename: "note.png", content_type: "image/png", attachment_id: "a2", readable: true, visibility: "internal" },
				{ filename: "evil.svg", content_type: "image/svg+xml", attachment_id: "a3", readable: true },
			]),
		);
		expect(images).toEqual([
			{ attachmentId: "a1", filename: "error.webp", mimeType: "image/webp", visibility: "public" },
			{ attachmentId: "a2", filename: "note.png", mimeType: "image/png", visibility: "internal" },
		]);
	});

	it("is empty without a ticket snapshot", () => {
		expect(readableTicketImages({ task_id: "x" })).toEqual([]);
		expect(readableTicketImages({ ticket: { attachments: "nope" } })).toEqual([]);
	});
});

describe("loadTicketImages", () => {
	it("downloads each image and labels it in order", async () => {
		const asked: string[] = [];
		const loaded = await loadTicketImages(
			payload([
				{ filename: "error.webp", content_type: "image/webp", attachment_id: "a1", readable: true, visibility: "public" },
				{ filename: "note.png", content_type: "image/png", attachment_id: "a2", readable: true, visibility: "internal" },
			]),
			async (id) => {
				asked.push(id);
				return new TextEncoder().encode(id);
			},
		);
		expect(asked).toEqual(["a1", "a2"]);
		expect(loaded.images).toEqual([
			{ type: "image", data: Buffer.from("a1").toString("base64"), mimeType: "image/webp" },
			{ type: "image", data: Buffer.from("a2").toString("base64"), mimeType: "image/png" },
		]);
		expect(loaded.section).toContain("TICKET IMAGES (untrusted data)");
		expect(loaded.section).toContain("Image 1 of 2: error.webp (public)");
		expect(loaded.section).toContain("Image 2 of 2: note.png (internal note)");
	});

	it("skips an image that fails to download and says so", async () => {
		const loaded = await loadTicketImages(
			payload([
				{ filename: "gone.webp", content_type: "image/webp", attachment_id: "a1", readable: true },
				{ filename: "ok.webp", content_type: "image/webp", attachment_id: "a2", readable: true },
			]),
			async (id) => {
				if (id === "a1") throw new Error("404");
				return new Uint8Array([1, 2]);
			},
		);
		expect(loaded.images).toHaveLength(1);
		expect(loaded.section).toContain("Image 1 of 1: ok.webp");
		expect(loaded.section).toContain("Could not load: gone.webp");
	});

	it("adds nothing when the ticket has no readable images", async () => {
		const loaded = await loadTicketImages(payload([]), async () => {
			throw new Error("not called");
		});
		expect(loaded).toEqual({ images: [], section: "" });
	});
});

describe("RunnerApiClient.attachment", () => {
	it("GETs the image with the Run token and returns its bytes", async () => {
		const { RunnerApiClient } = await import("../src/runner");
		const calls: { url: string; init: RequestInit }[] = [];
		const client = new RunnerApiClient(
			{
				serverUrl: "https://tako.example/",
				organizationId: "org-1",
				credential: "machine",
				leaseSeconds: 90,
				pollIntervalMs: 1000,
				repositories: {},
			},
			(async (url: string, init: RequestInit) => {
				calls.push({ url, init });
				return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200, headers: { "Content-Type": "image/webp" } });
			}) as unknown as typeof fetch,
		);
		const bytes = await client.attachment("run 1", "run-token", "att-1");
		expect([...bytes]).toEqual([82, 73, 70, 70]);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://tako.example/api/runner/runs/run%201/attachments/att-1");
		expect(calls[0].init.method).toBe("GET");
		expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer run-token");
		expect(calls[0].init.body).toBeUndefined();
	});
});
