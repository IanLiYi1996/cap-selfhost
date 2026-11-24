import { describe, expect, it } from "vitest";
import { formatToWebVTT } from "@/lib/transcribe-utils";

/**
 * The cue-text prefix is the only channel through which diarization reaches
 * anything a user or the LLM sees: the transcript panel and the AI summary both
 * read `transcription.vtt`, and the summary is generated from its text.
 */

const word = (
	text: string,
	start: number,
	end: number,
	speaker?: string | null,
) => ({ text, start, end, speaker });

/** Cue payload lines only, in order. */
const cueTexts = (vtt: string): string[] =>
	vtt
		.split("\n\n")
		.slice(1)
		.filter(Boolean)
		.map((block) => block.split("\n").slice(2).join("\n"))
		.filter(Boolean);

describe("formatToWebVTT speaker labels", () => {
	it("names the speaker on the first cue", () => {
		const vtt = formatToWebVTT({
			words: [word("Hello", 0, 500, "A"), word("there.", 500, 1000, "A")],
		});

		expect(cueTexts(vtt)).toEqual(["Speaker A: Hello there."]);
	});

	it("only re-announces when the speaker actually changes", () => {
		const vtt = formatToWebVTT({
			words: [
				word("One.", 0, 500, "A"),
				word("Two.", 500, 1000, "A"),
				word("Three.", 1000, 1500, "B"),
				word("Four.", 1500, 2000, "B"),
			],
		});

		expect(cueTexts(vtt)).toEqual([
			"Speaker A: One.",
			"Two.",
			"Speaker B: Three.",
			"Four.",
		]);
	});

	// A cue that mixes speakers is worse than a short cue.
	it("breaks the cue at a speaker change even mid-sentence", () => {
		const vtt = formatToWebVTT({
			words: [
				word("我是", 0, 400, "A"),
				word("想", 400, 800, "A"),
				word("对", 800, 1200, "B"),
				word("啊", 1200, 1600, "B"),
			],
		});

		expect(cueTexts(vtt)).toEqual(["Speaker A: 我是想", "Speaker B: 对啊"]);
	});

	it("does not make a speaker reintroduce themselves after an unattributed word", () => {
		const vtt = formatToWebVTT({
			words: [
				word("One.", 0, 500, "A"),
				word("Uh.", 500, 1000, null),
				word("Two.", 1000, 1500, "A"),
			],
		});

		expect(cueTexts(vtt)).toEqual(["Speaker A: One.", "Uh.", "Two."]);
	});

	// The AssemblyAI path and any recording without diarization must be untouched.
	it("emits no labels at all when no word has a speaker", () => {
		const vtt = formatToWebVTT({
			words: [
				word("This", 0, 400),
				word("is", 400, 800),
				word("a test.", 800, 1200),
			],
		});

		expect(cueTexts(vtt)).toEqual(["This is a test."]);
		expect(vtt).not.toContain("Speaker");
	});

	it("still produces well-formed cues and timings with speakers present", () => {
		const vtt = formatToWebVTT({
			words: [word("我是", 1420, 2000, "A"), word("对啊", 2000, 3680, "B")],
		});

		expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
		expect(vtt).toContain("00:00:01.420 --> 00:00:02.000");
		expect(vtt).toContain("00:00:02.000 --> 00:00:03.680");
	});

	it("handles an empty word list", () => {
		expect(formatToWebVTT({ words: [] })).toBe("WEBVTT\n\n");
	});
});
