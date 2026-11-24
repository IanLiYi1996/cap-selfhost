import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({ serverEnv: () => ({}), buildEnv: {} }));

import {
	parseTranscribeResult,
	transcribeJobName,
	transcribeLanguageSettings,
	transcribeOutputKey,
} from "@/lib/aws-transcribe";
import { whisperResultToEditResult } from "@/lib/whisper";

const item = (
	content: string,
	start: number | null,
	end: number | null,
	extra: Record<string, unknown> = {},
) =>
	start === null
		? { type: "punctuation", alternatives: [{ content }], ...extra }
		: {
				type: "pronunciation",
				start_time: String(start),
				end_time: String(end),
				alternatives: [{ content, confidence: "0.9" }],
				...extra,
			};

describe("parseTranscribeResult", () => {
	it("maps items to words, attaching punctuation to the word before it", () => {
		const result = parseTranscribeResult({
			results: {
				language_code: "zh-CN",
				items: [
					item("工单", 0.5, 0.9, { speaker_label: "spk_0" }),
					item("，", null, null),
					item("工程师", 1, 1.6, { speaker_label: "spk_1" }),
					item("。", null, null),
				],
			},
		});

		expect(result).toEqual({
			language: "zh",
			model: "aws-transcribe",
			durationSeconds: 1.6,
			words: [
				{ text: "工单，", start: 0.5, end: 0.9, confidence: 0.9, speaker: "A" },
				{ text: "工程师。", start: 1, end: 1.6, confidence: 0.9, speaker: "B" },
			],
		});
	});

	it("leaves speaker null without diarization and skips unusable items", () => {
		const result = parseTranscribeResult({
			results: {
				items: [
					item("。", null, null),
					item("hello", 2, 2.4),
					{ type: "pronunciation", alternatives: [{ content: "x" }] },
					item("  ", 3, 3.1),
				],
			},
		});

		expect(result.language).toBe(null);
		expect(result.words).toEqual([
			{ text: "hello", start: 2, end: 2.4, confidence: 0.9, speaker: null },
		]);
	});

	it("rejects output without items", () => {
		expect(() => parseTranscribeResult({ results: {} })).toThrow();
		expect(() => parseTranscribeResult(null)).toThrow();
	});

	it("names the engine in the edit transcript instead of calling it whisper", () => {
		const result = parseTranscribeResult({
			results: { items: [item("hi", 0, 0.5)] },
		});
		expect(whisperResultToEditResult(result).speech_model_used).toBe(
			"aws-transcribe",
		);
	});
});

describe("transcribeLanguageSettings", () => {
	it("identifies among the configured languages when the video says auto", () => {
		expect(transcribeLanguageSettings("auto", "zh-CN,en-US")).toEqual({
			IdentifyLanguage: true,
			LanguageOptions: ["zh-CN", "en-US"],
		});
	});

	it("adds the video's language as a candidate rather than forcing it", () => {
		expect(transcribeLanguageSettings("ja", "zh-CN,en-US")).toEqual({
			IdentifyLanguage: true,
			LanguageOptions: ["zh-CN", "en-US", "ja-JP"],
		});
		expect(transcribeLanguageSettings("zh", "zh-CN,en-US")).toEqual({
			IdentifyLanguage: true,
			LanguageOptions: ["zh-CN", "en-US"],
		});
	});

	it("uses a single language directly, since identification needs two", () => {
		expect(transcribeLanguageSettings("auto", "zh-CN")).toEqual({
			LanguageCode: "zh-CN",
		});
	});

	it("falls back to Mandarin and English when nothing is configured", () => {
		expect(transcribeLanguageSettings("bn", undefined)).toEqual({
			IdentifyLanguage: true,
			LanguageOptions: ["zh-CN", "en-US"],
		});
	});
});

describe("job identity", () => {
	it("is stable per video and purpose so retries reuse one job", () => {
		expect(transcribeJobName("abc123", "transcript")).toBe(
			"cap-abc123-transcript-v1",
		);
		expect(transcribeOutputKey("u", "abc123", "transcript")).toBe(
			"u/abc123/transcribe.transcript.v1.json",
		);
	});
});
