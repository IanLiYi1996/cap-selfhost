import { describe, expect, it } from "vitest";
import {
	appendHistory,
	askHistoryKey,
	MAX_STORED_TURNS,
	parseAskHistory,
} from "@/lib/video-qa/history";

describe("askHistoryKey", () => {
	it("keeps one file per viewer under the video", () => {
		expect(askHistoryKey("owner", "video", "viewer")).toBe(
			"owner/video/ask-history/viewer.v1.json",
		);
	});
});

describe("parseAskHistory", () => {
	it("keeps valid turns in order", () => {
		const raw = JSON.stringify({
			version: 1,
			turns: [
				{ role: "user", content: "问", at: "t1" },
				{ role: "assistant", content: "答", at: "t2" },
				{ role: "system", content: "x", at: "t3" },
				{ role: "user", content: "", at: "t4" },
			],
		});
		expect(parseAskHistory(raw)).toEqual([
			{ role: "user", content: "问", at: "t1" },
			{ role: "assistant", content: "答", at: "t2" },
		]);
	});

	it("treats a missing or broken file as no history", () => {
		expect(parseAskHistory(null)).toEqual([]);
		expect(parseAskHistory("{")).toEqual([]);
	});
});

describe("appendHistory", () => {
	it("adds a question and its answer", () => {
		const next = appendHistory(
			null,
			"问题",
			"回答",
			"2026-11-26T00:00:00.000Z",
		);
		expect(JSON.parse(next)).toEqual({
			version: 1,
			turns: [
				{ role: "user", content: "问题", at: "2026-11-26T00:00:00.000Z" },
				{ role: "assistant", content: "回答", at: "2026-11-26T00:00:00.000Z" },
			],
		});
	});

	it("keeps only the most recent turns, starting with a question", () => {
		let raw: string | null = null;
		for (let i = 0; i < MAX_STORED_TURNS; i++) {
			raw = appendHistory(raw, `q${i}`, `a${i}`, "t");
		}
		const turns = parseAskHistory(raw);
		expect(turns).toHaveLength(MAX_STORED_TURNS);
		expect(turns[0]?.role).toBe("user");
		expect(turns.at(-1)?.content).toBe(`a${MAX_STORED_TURNS - 1}`);
	});
});
