import { describe, expect, it, vi } from "vitest";
import {
	buildVtt,
	cueHash,
	isSameLanguage,
	LIVE_TRANSLATION,
	parseTranslationCache,
	parseVttCues,
	serializeTranslationCache,
	translateLanguageCode,
	translateSourceCode,
	translateVtt,
} from "@/lib/live-translate";

const vtt = (...texts: string[]) =>
	`WEBVTT\n\n${texts
		.map(
			(text, i) =>
				`${i + 1}\n00:00:0${i}.000 --> 00:00:0${i + 1}.000\n${text}\n\n`,
		)
		.join("")}`;

describe("VTT cues", () => {
	it("round-trips cue numbers, timings and text", () => {
		const source = vtt("你好", "A: 第二句");
		const cues = parseVttCues(source);
		expect(cues).toEqual([
			{ head: ["1", "00:00:00.000 --> 00:00:01.000"], text: "你好" },
			{ head: ["2", "00:00:01.000 --> 00:00:02.000"], text: "A: 第二句" },
		]);
		expect(buildVtt(cues)).toBe(source);
	});
});

describe("language codes", () => {
	it("maps caption languages to Amazon Translate codes", () => {
		expect(translateLanguageCode("zh-Hant")).toBe("zh-TW");
		expect(translateLanguageCode("ja")).toBe("ja");
	});

	it("uses the transcript language as the source, or auto", () => {
		expect(translateSourceCode("zh")).toBe("zh");
		expect(translateSourceCode("en-US")).toBe("en");
		expect(translateSourceCode(null)).toBe("auto");
		expect(isSameLanguage("zh", "zh")).toBe(true);
		expect(isSameLanguage("auto", "en")).toBe(false);
	});
});

describe("translateVtt", () => {
	it("translates only cues it has not seen, keeping timings", async () => {
		const cache = new Map([[cueHash("你好"), "Hello"]]);
		const translate = vi.fn(async (text: string) => `EN(${text})`);
		const result = await translateVtt({
			vtt: vtt("你好", "开会"),
			cache,
			translate,
		});
		expect(translate).toHaveBeenCalledTimes(1);
		expect(translate).toHaveBeenCalledWith("开会");
		expect(result).toEqual({
			vtt: vtt("Hello", "EN(开会)"),
			added: 1,
			complete: true,
		});
		expect(cache.get(cueHash("开会"))).toBe("EN(开会)");
	});

	it("keeps the original text for a cue that failed or was left for later", async () => {
		const translate = async (text: string) => {
			if (text === "句0") throw new Error("throttled");
			return `T${text}`;
		};
		const result = await translateVtt({
			vtt: vtt("句0", "句1"),
			cache: new Map(),
			translate,
		});
		expect(parseVttCues(result.vtt).map((cue) => cue.text)).toEqual([
			"句0",
			"T句1",
		]);
		expect(result.complete).toBe(false);
	});

	it(`translates at most ${LIVE_TRANSLATION.MAX_NEW_CUES} new cues per call`, async () => {
		const cues = Array.from(
			{ length: LIVE_TRANSLATION.MAX_NEW_CUES + 5 },
			(_, i) => ({
				head: [`${i + 1}`, "00:00:00.000 --> 00:00:01.000"],
				text: `句${i}`,
			}),
		);
		const translate = vi.fn(async (text: string) => `T${text}`);
		const result = await translateVtt({
			vtt: buildVtt(cues),
			cache: new Map(),
			translate,
		});
		expect(translate).toHaveBeenCalledTimes(LIVE_TRANSLATION.MAX_NEW_CUES);
		expect(result.complete).toBe(false);
	});
});

describe("translation cache", () => {
	it("survives a round trip and ignores a broken file", () => {
		const cache = new Map([["k", "v"]]);
		expect(parseTranslationCache(serializeTranslationCache(cache))).toEqual(
			cache,
		);
		expect(parseTranslationCache("{")).toEqual(new Map());
		expect(parseTranslationCache(null)).toEqual(new Map());
	});
});
