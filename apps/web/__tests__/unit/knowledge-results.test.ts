import { describe, expect, it } from "vitest";
import {
	dedupeHits,
	formatResultsForModel,
	groupResults,
	knowledgeHref,
	type MeetingInfo,
	resolveCitationHref,
} from "@/lib/knowledge/results";
import type { VectorHit } from "@/lib/knowledge/store";

const hit = (overrides: Partial<VectorHit>): VectorHit => ({
	key: "k",
	distance: 0.4,
	orgId: "org",
	videoId: "v1",
	ownerId: "u",
	recordedAt: 0,
	kind: "transcript",
	text: "派单规则",
	label: "00:10-01:20",
	start: 10,
	end: 80,
	materialId: null,
	materialName: null,
	page: null,
	imageKey: null,
	...overrides,
});

const meeting = (videoId: string, title: string): MeetingInfo => ({
	videoId,
	title,
	recordedAt: "2026-11-20T08:00:00.000Z",
	durationSeconds: 3600,
});

describe("links", () => {
	it("points at the moment or the material page on the share page", () => {
		expect(knowledgeHref(hit({ start: 75.6 }))).toBe("/s/v1?t=75");
		expect(knowledgeHref(hit({ materialId: "m1", page: 3, start: null }))).toBe(
			"/s/v1?tab=materials&material=m1&page=3",
		);
		expect(knowledgeHref(hit({ start: null }))).toBe("/s/v1");
	});

	it("turns the answer's cap:// citations into share-page links", () => {
		expect(resolveCitationHref("cap://video/v1?t=750")).toBe("/s/v1?t=750");
		expect(resolveCitationHref("cap://video/v1")).toBe("/s/v1");
		expect(resolveCitationHref("cap://material/v1/m-2?page=5")).toBe(
			"/s/v1?tab=materials&material=m-2&page=5",
		);
		expect(resolveCitationHref("cap://video/../admin")).toBeNull();
		expect(resolveCitationHref("cap://material/v1")).toBeNull();
		expect(resolveCitationHref("https://example.com")).toBeNull();
	});
});

describe("groupResults", () => {
	const meetings = new Map([
		["v1", meeting("v1", "周会")],
		["v2", meeting("v2", "评审")],
	]);

	it("keeps only meetings the viewer may see, best meeting first", () => {
		const { groups, results } = groupResults(
			[
				hit({ key: "a", videoId: "v2" }),
				hit({ key: "b", videoId: "hidden" }),
				hit({ key: "c", videoId: "v1", start: 300 }),
				hit({ key: "d", videoId: "v2", start: 900 }),
			],
			meetings,
		);
		expect(groups.map((g) => g.videoId)).toEqual(["v2", "v1"]);
		expect(groups[0]?.results.map((r) => r.ref)).toEqual(["R1", "R3"]);
		expect(results.map((r) => r.key)).toEqual(["a", "c", "d"]);
	});

	it("limits results per meeting", () => {
		const hits = [0, 100, 200, 300, 400].map((start) =>
			hit({ key: `t${start}`, start }),
		);
		expect(groupResults(hits, meetings, 2).results).toHaveLength(2);
	});

	it("labels material hits with the file and page", () => {
		const { results } = groupResults(
			[
				hit({
					kind: "material",
					materialId: "m1",
					materialName: "规则.pdf",
					label: "Page 3",
					page: 3,
					start: null,
				}),
			],
			meetings,
		);
		expect(results[0]?.label).toBe("《规则.pdf》 Page 3");
	});
});

describe("dedupeHits", () => {
	it("keeps one hit per material page and per screen moment", () => {
		const kept = dedupeHits([
			hit({ key: "text", kind: "material", materialId: "m1", page: 2 }),
			hit({ key: "image", kind: "page", materialId: "m1", page: 2 }),
			hit({ key: "frame", kind: "frame", start: 30 }),
			hit({ key: "visual", kind: "visual", start: 32 }),
			hit({ key: "said", kind: "transcript", start: 31 }),
		]);
		expect(kept.map((h) => h.key)).toEqual(["text", "frame", "said"]);
	});
});

describe("formatResultsForModel", () => {
	it("lists each meeting with refs, places and image markers", () => {
		const { groups } = groupResults(
			[
				hit({
					key: "f",
					kind: "frame",
					start: 61,
					imageKey: "f.jpg",
					label: "01:01",
				}),
			],
			new Map([["v1", meeting("v1", "周会")]]),
		);
		const text = formatResultsForModel(groups);
		expect(text).toContain(
			'Meeting "周会" (videoId v1, recorded 2026-11-20, 1:00:00 long)',
		);
		expect(text).toContain("[R1] frame · 01:01 · t=61s [has image]");
		expect(formatResultsForModel([])).toBe("No results.");
	});
});
