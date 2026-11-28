import { describe, expect, it } from "vitest";
import {
	chunkHash,
	frameChunks,
	materialChunks,
	parseIndexManifest,
	planIndexUpdate,
	summaryChunks,
	TRANSCRIPT_CHUNK_SECONDS,
	transcriptChunks,
	visualChunks,
} from "@/lib/knowledge/chunks";
import type { LoadedMaterial } from "@/lib/video-materials/context";
import type { FramesIndex } from "@/lib/video-qa/artifacts";

const cue = (start: number, text: string) => ({ start, end: start + 5, text });

describe("transcriptChunks", () => {
	it("groups cues into passages bounded by time", () => {
		const cues = Array.from({ length: 40 }, (_, i) => cue(i * 5, `第${i}句`));
		const chunks = transcriptChunks("v1", cues);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect((chunk.end ?? 0) - (chunk.start ?? 0)).toBeLessThanOrEqual(
				TRANSCRIPT_CHUNK_SECONDS + 5,
			);
		}
		expect(chunks[0]).toMatchObject({
			key: "v1:transcript:0",
			kind: "transcript",
			label: "00:00-01:30",
			start: 0,
		});
		expect(chunks.map((c) => c.text).join(" ")).toBe(
			cues.map((c) => c.text).join(" "),
		);
	});

	it("bounds passages by length too", () => {
		const long = "长".repeat(500);
		const chunks = transcriptChunks("v1", [cue(0, long), cue(5, long)]);
		expect(chunks).toHaveLength(2);
	});
});

describe("visual and frame chunks", () => {
	const segments = [
		{ start: 0, end: 30, description: "工单列表", screenText: ["新建工单"] },
		{
			start: 30,
			end: 60,
			description: "预约时间弹窗",
			screenText: ["期望上门时间"],
		},
	];

	it("indexes each screen segment with its screen text", () => {
		expect(visualChunks("v1", segments)[1]).toMatchObject({
			key: "v1:visual:30000",
			text: "预约时间弹窗\n期望上门时间",
			label: "00:30-01:00",
		});
	});

	it("embeds keyframes as images, searchable by their segment's text", () => {
		const frames: FramesIndex = {
			version: 1,
			durationSeconds: 60,
			frames: [
				{ t: 35, key: "f/35.jpg", keyframe: true },
				{ t: 40, key: "f/40.jpg", keyframe: false },
			],
		};
		const chunks = frameChunks("v1", frames, segments);
		expect(chunks).toEqual([
			expect.objectContaining({
				key: "v1:frame:35000",
				kind: "frame",
				imageKey: "f/35.jpg",
				embedText: "",
				text: "预约时间弹窗\n期望上门时间",
				start: 35,
			}),
		]);
	});
});

describe("summaryChunks", () => {
	it("makes one chunk for the summary and one per chapter", () => {
		const chunks = summaryChunks("v1", "周会", "讨论了派单", [
			{ title: "地图", start: 120 },
			{ title: "开场", start: 0 },
		]);
		expect(chunks.map((c) => [c.kind, c.label, c.end])).toEqual([
			["summary", "Summary", null],
			["chapter", "00:00", 120],
			["chapter", "02:00", null],
		]);
		expect(chunks[1]?.embedText).toBe("周会: 开场");
		expect(summaryChunks("v1", "t", "", [])).toEqual([]);
	});
});

describe("materialChunks", () => {
	const material: LoadedMaterial = {
		id: "m1",
		name: "规则.pptx",
		kind: "pptx",
		processing: false,
		pages: [
			{
				n: 1,
				label: "Slide 1",
				text: "派单规则",
				outline: "总览",
				imageKey: "p/1.jpg",
			},
			{
				n: 2,
				label: "Slide 2",
				text: `${"甲".repeat(1000)}。${"乙".repeat(1000)}`,
				outline: "",
				imageKey: null,
			},
		],
	};

	it("indexes each page's text and its image", () => {
		const chunks = materialChunks("v1", [material]);
		expect(chunks.map((c) => c.key)).toEqual([
			"v1:material:m1:1:0",
			"v1:page:m1:1",
			"v1:material:m1:2:0",
			"v1:material:m1:2:1",
		]);
		expect(chunks[0]?.embedText).toBe("规则.pptx · Slide 1\n派单规则");
		expect(chunks[1]).toMatchObject({
			kind: "page",
			imageKey: "p/1.jpg",
			page: 1,
		});
		expect(chunks[2]?.text.endsWith("。")).toBe(true);
	});
});

describe("planIndexUpdate", () => {
	const chunks = transcriptChunks("v1", [cue(0, "a"), cue(200, "b")]);

	it("embeds new and changed chunks and removes the ones that are gone", () => {
		const first = planIndexUpdate(parseIndexManifest(null), chunks, "org");
		expect(first.upsert).toHaveLength(2);
		expect(first.remove).toEqual([]);

		const unchanged = planIndexUpdate(first.manifest, chunks, "org");
		expect(unchanged.upsert).toEqual([]);

		const edited = transcriptChunks("v1", [cue(0, "a2")]);
		const next = planIndexUpdate(first.manifest, edited, "org");
		expect(next.upsert.map((c) => c.key)).toEqual(["v1:transcript:0"]);
		expect(next.remove).toEqual(["v1:transcript:200000"]);
	});

	it("re-embeds everything when the meeting moves to another organization", () => {
		const first = planIndexUpdate(parseIndexManifest(null), chunks, "org");
		expect(
			planIndexUpdate(first.manifest, chunks, "other").upsert,
		).toHaveLength(2);
		const [chunk] = chunks;
		if (!chunk) throw new Error("expected a chunk");
		expect(chunkHash(chunk, "org")).not.toBe(chunkHash(chunk, "other"));
	});
});
