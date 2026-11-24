import { describe, expect, it } from "vitest";
import {
	appendFragment,
	joinFragments,
	needsSpaceBetween,
} from "@/lib/text-join";

describe("needsSpaceBetween", () => {
	it("spaces Latin words apart", () => {
		expect(needsSpaceBetween("Hello", "world")).toBe(true);
	});

	it("never spaces CJK apart", () => {
		expect(needsSpaceBetween("我是", "想")).toBe(false);
		expect(needsSpaceBetween("こんにちは", "世界")).toBe(false);
		expect(needsSpaceBetween("カタカナ", "です")).toBe(false);
	});

	it("drops the space when either side of the boundary is CJK", () => {
		// Whisper reports no space here either, so inventing one is wrong.
		expect(needsSpaceBetween("放", "feature")).toBe(false);
		expect(needsSpaceBetween("feature", "但是")).toBe(false);
	});

	it("treats CJK and fullwidth punctuation as no-space", () => {
		expect(needsSpaceBetween("好。", "然后")).toBe(false);
		expect(needsSpaceBetween("对吧", "，是")).toBe(false);
		expect(needsSpaceBetween("说「", "对")).toBe(false);
	});

	it("keeps spacing Korean, which is written with spaces", () => {
		expect(needsSpaceBetween("안녕", "하세요")).toBe(true);
	});

	it("reports no boundary at all for empty fragments", () => {
		expect(needsSpaceBetween("", "world")).toBe(false);
		expect(needsSpaceBetween("Hello", "")).toBe(false);
	});

	it("does not split an astral-plane character mid-surrogate", () => {
		// U+20000 is a CJK Extension B ideograph; a naive charAt would see a lone
		// surrogate and fall through to spacing it.
		expect(needsSpaceBetween("\u{20000}", "字")).toBe(false);
		expect(needsSpaceBetween("字", "\u{20000}")).toBe(false);
	});
});

describe("joinFragments", () => {
	it("leaves English captions exactly as before", () => {
		// The AssemblyAI path must be untouched by the CJK handling.
		expect(joinFragments(["This", "is", "a", "test"])).toBe("This is a test");
	});

	// The regression: Whisper's Chinese "words" are sub-word tokens, so a space
	// join lands spaces mid-word.
	it("reproduces Chinese without inserted spaces", () => {
		expect(
			joinFragments(["我是", "想", "往", "里", "腾", "我", "跟你", "说"]),
		).toBe("我是想往里腾我跟你说");
	});

	it("keeps an embedded English word attached to its Chinese neighbours", () => {
		expect(joinFragments(["我", "肯", "定", "不", "放", "feature"])).toBe(
			"我肯定不放feature",
		);
	});

	it("handles an empty list and empty fragments", () => {
		expect(joinFragments([])).toBe("");
		expect(joinFragments(["", "我是", ""])).toBe("我是");
	});
});

describe("appendFragment", () => {
	it("returns the other side when one is empty", () => {
		expect(appendFragment("", "我是")).toBe("我是");
		expect(appendFragment("我是", "")).toBe("我是");
	});

	it("stitches Chinese cues without a seam", () => {
		expect(appendFragment("我是想往里腾我跟你说", "那个第七章")).toBe(
			"我是想往里腾我跟你说那个第七章",
		);
	});

	it("still separates English sentences", () => {
		expect(appendFragment("First one.", "Second one.")).toBe(
			"First one. Second one.",
		);
	});
});
