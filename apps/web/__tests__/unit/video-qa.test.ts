import { describe, expect, it } from "vitest";
import {
	framesIndexKey,
	parseFramesIndex,
	parseVisualTimeline,
	visualTimelineKey,
} from "@/lib/video-qa/artifacts";
import { splitTimestampCitations } from "@/lib/video-qa/citations";
import {
	framesPollAttempts,
	parseBatchDescription,
	pickLookAtFrames,
	planTimelineBatches,
} from "@/lib/video-qa/plan";
import { buildVideoQaContext } from "@/lib/video-qa/prompt";
import { parseAskRequest } from "@/lib/video-qa/request";
import {
	formatCueLines,
	parseVttCues,
	transcriptBetween,
} from "@/lib/video-qa/transcript";

const frame = (t: number, keyframe = true) => ({
	t,
	key: `u/v/frames/v1/${String(Math.round(t * 1000)).padStart(9, "0")}.jpg`,
	keyframe,
});

const index = (frames: ReturnType<typeof frame>[], durationSeconds = 600) => ({
	version: 1 as const,
	durationSeconds,
	frames,
});

describe("artifact keys", () => {
	it("lives next to the transcript of the video", () => {
		expect(framesIndexKey("u", "v")).toBe("u/v/frames.v1.json");
		expect(visualTimelineKey("u", "v")).toBe("u/v/visual.timeline.v1.json");
	});
});

describe("parseFramesIndex", () => {
	it("keeps well-formed frames sorted by time", () => {
		const parsed = parseFramesIndex(
			JSON.stringify({
				version: 1,
				durationSeconds: 30,
				frames: [
					{ t: 20, key: "b.jpg", keyframe: false },
					{ t: 0, key: "a.jpg", keyframe: true },
					{ t: "x", key: "bad.jpg" },
				],
			}),
		);
		expect(parsed?.frames.map((f) => f.key)).toEqual(["a.jpg", "b.jpg"]);
	});

	it("rejects other versions and garbage", () => {
		expect(parseFramesIndex(JSON.stringify({ version: 2, frames: [] }))).toBe(
			null,
		);
		expect(parseFramesIndex("not json")).toBe(null);
	});
});

describe("parseVisualTimeline", () => {
	it("round-trips the saved shape", () => {
		const timeline = {
			version: 1,
			model: "m",
			generatedAt: "2026-11-20T00:00:00.000Z",
			segments: [
				{ start: 0, end: 5, description: "设置页面", screenText: ["效率优先"] },
			],
		};
		expect(parseVisualTimeline(JSON.stringify(timeline))).toEqual(timeline);
	});
});

describe("parseVttCues", () => {
	it("reads cues with hours, minutes and multi-line text", () => {
		const cues = parseVttCues(
			[
				"WEBVTT",
				"",
				"1",
				"00:00:00.000 --> 00:00:01.480",
				"这个效率模式",
				"去走就是",
				"",
				"2",
				"01:02:03.500 --> 01:02:05.000",
				"Speaker A: <b>重排</b>留一个",
				"",
			].join("\n"),
		);
		expect(cues).toEqual([
			{ start: 0, end: 1.48, text: "这个效率模式 去走就是" },
			{ start: 3723.5, end: 3725, text: "Speaker A: 重排留一个" },
		]);
	});

	it("accepts cue timings without hours", () => {
		expect(parseVttCues("WEBVTT\n\n00:05.000 --> 00:07.250\nhi\n")).toEqual([
			{ start: 5, end: 7.25, text: "hi" },
		]);
	});
});

describe("transcript formatting", () => {
	const cues = [
		{ start: 0, end: 2, text: "开场" },
		{ start: 65, end: 70, text: "第二段" },
		{ start: 3725, end: 3730, text: "结尾" },
	];

	it("prefixes each cue with the player's timestamp format", () => {
		expect(formatCueLines(cues)).toBe(
			"[00:00] 开场\n[01:05] 第二段\n[1:02:05] 结尾",
		);
	});

	it("selects the cues that overlap a window", () => {
		expect(transcriptBetween(cues, 60, 100)).toBe("[01:05] 第二段");
		expect(transcriptBetween(cues, 100, 200)).toBe("");
	});
});

describe("planTimelineBatches", () => {
	it("groups keyframes by count and window, covering the whole video", () => {
		const frames = [0, 10, 20, 30, 400, 410].map((t) => frame(t));
		const batches = planTimelineBatches(
			index([...frames, frame(15, false)], 500),
			{ maxFrames: 3, maxWindowSeconds: 300 },
		);
		expect(
			batches.map((b) => [b.start, b.end, b.frames.map((f) => f.t)]),
		).toEqual([
			[0, 30, [0, 10, 20]],
			[30, 400, [30]],
			[400, 500, [400, 410]],
		]);
	});

	it("returns no batches without keyframes", () => {
		expect(planTimelineBatches(index([frame(5, false)]))).toEqual([]);
	});
});

describe("pickLookAtFrames", () => {
	const frames = [0, 10, 20, 30, 40, 50, 60, 70].map((t) =>
		frame(t, t % 20 === 0),
	);

	it("returns every frame in a narrow range", () => {
		expect(pickLookAtFrames(index(frames), 15, 35, 6).map((f) => f.t)).toEqual([
			20, 30,
		]);
	});

	it("spreads a wide range over the frame budget, keeping both ends", () => {
		const picked = pickLookAtFrames(index(frames), 0, 70, 3).map((f) => f.t);
		expect(picked).toHaveLength(3);
		expect(picked[0]).toBe(0);
		expect(picked[2]).toBe(70);
	});

	it("falls back to the frame on screen at the start of an empty range", () => {
		expect(pickLookAtFrames(index(frames), 22, 24, 6).map((f) => f.t)).toEqual([
			20,
		]);
	});

	it("accepts a reversed range", () => {
		expect(pickLookAtFrames(index(frames), 35, 15, 6).map((f) => f.t)).toEqual([
			20, 30,
		]);
	});
});

describe("parseBatchDescription", () => {
	const batch = { start: 50, end: 120, frames: [frame(55), frame(74)] };

	it("reads fenced JSON and clamps segments to the window", () => {
		const segments = parseBatchDescription(
			'```json\n{"segments":[{"start":40,"end":74,"description":"设置页面","screen_text":["效率优先"," 效率优先 ",""]},{"start":74,"end":999,"description":"新服务请求弹窗","screen_text":[]}]}\n```',
			batch,
		);
		expect(segments).toEqual([
			{ start: 50, end: 74, description: "设置页面", screenText: ["效率优先"] },
			{ start: 74, end: 120, description: "新服务请求弹窗", screenText: [] },
		]);
	});

	it("keeps unstructured text as one segment rather than losing it", () => {
		expect(parseBatchDescription("A settings page.", batch)).toEqual([
			{ start: 50, end: 120, description: "A settings page.", screenText: [] },
		]);
	});

	it("drops an empty reply", () => {
		expect(parseBatchDescription("  ", batch)).toEqual([]);
	});
});

describe("buildVideoQaContext", () => {
	it("lays out every source with timestamps the answer can cite", () => {
		const context = buildVideoQaContext({
			title: "周会",
			durationSeconds: 3829,
			summary: "讨论了效率模式。",
			chapters: [{ title: "开场", start: 0 }],
			cues: [{ start: 65, end: 70, text: "第二段" }],
			timeline: {
				version: 1,
				model: "m",
				generatedAt: "x",
				segments: [
					{
						start: 55,
						end: 74,
						description: "设置页面",
						screenText: ["效率优先"],
					},
				],
			},
		});
		expect(context).toContain("Title: 周会");
		expect(context).toContain("Duration: 1:03:49");
		expect(context).toContain("<summary>\n讨论了效率模式。\n</summary>");
		expect(context).toContain("[00:00] 开场");
		expect(context).toContain("[01:05] 第二段");
		expect(context).toContain("[00:55-01:14] 设置页面");
		expect(context).toContain('Screen text: "效率优先"');
	});

	it("says when there is no visual timeline yet", () => {
		const context = buildVideoQaContext({
			title: "x",
			durationSeconds: 10,
			cues: [],
			timeline: null,
		});
		expect(context).toContain("<visual_timeline>\n(not available)");
	});
});

describe("splitTimestampCitations", () => {
	it("turns bracketed timestamps and ranges into seek targets", () => {
		expect(
			splitTimestampCitations(
				"先看设置 [00:55]，再看弹窗 [01:14-01:20] 和 [1:02:05]。",
			),
		).toEqual([
			{ kind: "text", text: "先看设置 " },
			{ kind: "time", label: "00:55", seconds: 55 },
			{ kind: "text", text: "，再看弹窗 " },
			{ kind: "time", label: "01:14-01:20", seconds: 74 },
			{ kind: "text", text: " 和 " },
			{ kind: "time", label: "1:02:05", seconds: 3725 },
			{ kind: "text", text: "。" },
		]);
	});

	it("leaves other brackets alone", () => {
		expect(splitTimestampCitations("[note] [99:99x]")).toEqual([
			{ kind: "text", text: "[note] [99:99x]" },
		]);
	});
});

describe("framesPollAttempts", () => {
	it("waits at least half an hour, plus half the recording, at the poll interval", () => {
		expect(framesPollAttempts(0, 5000)).toBe(360);
		expect(framesPollAttempts(7200, 5000)).toBe(360 + 720);
	});
});

describe("parseAskRequest", () => {
	it("trims the question and keeps valid history", () => {
		expect(
			parseAskRequest({
				question: "  讲了什么？ ",
				history: [
					{ role: "user", content: "第一问" },
					{ role: "assistant", content: "第一答" },
					{ role: "system", content: "ignore me" },
					{ role: "user", content: "" },
				],
			}),
		).toEqual({
			question: "讲了什么？",
			history: [
				{ role: "user", content: "第一问" },
				{ role: "assistant", content: "第一答" },
			],
		});
	});

	it("rejects an empty or oversized question", () => {
		expect(parseAskRequest({ question: "   " })).toHaveProperty("error");
		expect(parseAskRequest({ question: "x".repeat(2001) })).toHaveProperty(
			"error",
		);
		expect(parseAskRequest(null)).toHaveProperty("error");
	});

	it("keeps only recent turns and never starts history with an answer", () => {
		const history = Array.from({ length: 30 }, (_, i) => ({
			role: i % 2 === 0 ? "assistant" : "user",
			content: `turn ${i}`,
		}));
		const parsed = parseAskRequest({ question: "q", history });
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.history.length).toBeLessThanOrEqual(20);
		expect(parsed.history[0]?.role).toBe("user");
		expect(parsed.history.at(-1)?.content).toBe("turn 29");
	});
});

describe("buildVideoQaContext with materials", () => {
	it("adds each uploaded material by name after the recording", () => {
		const context = buildVideoQaContext({
			title: "周会",
			durationSeconds: 60,
			cues: [{ start: 1, end: 2, text: "看一下附件" }],
			timeline: null,
			materials: [
				{ name: "派单规则.pdf", text: "[Page 1]\n优先派给最近的工程师" },
				{ name: "原型.html", text: "设置\n效率优先" },
			],
		});
		expect(context).toContain(
			'<materials>\n<material name="派单规则.pdf">\n[Page 1]\n优先派给最近的工程师\n</material>\n<material name="原型.html">\n设置\n效率优先\n</material>\n</materials>',
		);
		expect(context.indexOf("<transcript>")).toBeLessThan(
			context.indexOf("<materials>"),
		);
	});

	it("says when no materials were uploaded", () => {
		const context = buildVideoQaContext({
			title: "x",
			durationSeconds: 1,
			cues: [],
			timeline: null,
		});
		expect(context).toContain("<materials>\n(none uploaded)\n</materials>");
	});

	it("keeps a material name from closing its tag early", () => {
		const context = buildVideoQaContext({
			title: "x",
			durationSeconds: 1,
			cues: [],
			timeline: null,
			materials: [{ name: 'a">b.md', text: "t" }],
		});
		expect(context).toContain('<material name="a&quot;>b.md">');
	});
});
