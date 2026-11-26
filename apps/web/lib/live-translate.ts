import { createHash } from "node:crypto";
import type { LanguageCode } from "@cap/web-domain/src/Language";

/**
 * Live captions in another language. Each cue of the live transcript is
 * translated once with Amazon Translate and remembered by its text, so
 * viewers polling the growing transcript only pay for cues that are new or
 * whose text changed since the last poll.
 */

export const LIVE_TRANSLATION = {
	/** New cues translated per request; the rest show in the original until
	 * a later poll catches up. */
	MAX_NEW_CUES: 30,
	CONCURRENCY: 5,
	MAX_CACHED_CUES: 4_000,
} as const;

/** Amazon Translate's code for each caption language, where it differs. */
const TRANSLATE_CODES: Partial<Record<LanguageCode, string>> = {
	"zh-Hant": "zh-TW",
};

export const translateLanguageCode = (language: LanguageCode) =>
	TRANSLATE_CODES[language] ?? language;

/** The transcript's language ("zh", "en", or "zh-CN" style) as a source code
 * Amazon Translate accepts; "auto" when unknown. */
export function translateSourceCode(languageCode: string | null): string {
	const base = languageCode?.split("-")[0]?.toLowerCase();
	return base && /^[a-z]{2}$/.test(base) ? base : "auto";
}

export function isSameLanguage(source: string, target: LanguageCode) {
	return source !== "auto" && source === target;
}

export const liveTranslationKey = (
	ownerId: string,
	videoId: string,
	language: LanguageCode,
) => `${ownerId}/${videoId}/transcription.live.${language}.json`;

export type VttCue = { head: string[]; text: string };

export function parseVttCues(vtt: string): VttCue[] {
	const cues: VttCue[] = [];
	for (const block of vtt.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
		const lines = block.split("\n");
		const timing = lines.findIndex((line) => line.includes("-->"));
		if (timing === -1) continue;
		cues.push({
			head: lines.slice(0, timing + 1),
			text: lines
				.slice(timing + 1)
				.join("\n")
				.trim(),
		});
	}
	return cues;
}

export function buildVtt(cues: readonly VttCue[]): string {
	let output = "WEBVTT\n\n";
	for (const cue of cues) output += `${cue.head.join("\n")}\n${cue.text}\n\n`;
	return output;
}

export const cueHash = (text: string) =>
	createHash("sha256").update(text, "utf8").digest("base64url").slice(0, 22);

export function parseTranslationCache(raw: string | null): Map<string, string> {
	if (!raw) return new Map();
	try {
		const value = JSON.parse(raw) as { entries?: unknown };
		if (!value.entries || typeof value.entries !== "object") return new Map();
		return new Map(
			Object.entries(value.entries as Record<string, unknown>).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
	} catch {
		return new Map();
	}
}

export function serializeTranslationCache(cache: Map<string, string>) {
	const entries = [...cache.entries()].slice(-LIVE_TRANSLATION.MAX_CACHED_CUES);
	return JSON.stringify({ version: 1, entries: Object.fromEntries(entries) });
}

/**
 * Translate the cues of `vtt` that the cache doesn't have yet (at most
 * MAX_NEW_CUES, oldest first), keeping each cue's timing.
 */
export async function translateVtt(options: {
	vtt: string;
	cache: Map<string, string>;
	translate: (text: string) => Promise<string>;
}): Promise<{ vtt: string; added: number; complete: boolean }> {
	const cues = parseVttCues(options.vtt);
	const missing = [
		...new Set(
			cues
				.map((cue) => cue.text)
				.filter((text) => text && !options.cache.has(cueHash(text))),
		),
	];
	const batch = missing.slice(0, LIVE_TRANSLATION.MAX_NEW_CUES);

	let added = 0;
	for (let i = 0; i < batch.length; i += LIVE_TRANSLATION.CONCURRENCY) {
		const group = batch.slice(i, i + LIVE_TRANSLATION.CONCURRENCY);
		const results = await Promise.allSettled(
			group.map((text) => options.translate(text)),
		);
		for (const [offset, result] of results.entries()) {
			if (result.status !== "fulfilled" || !result.value.trim()) continue;
			options.cache.set(cueHash(group[offset] as string), result.value.trim());
			added++;
		}
	}

	return {
		vtt: buildVtt(
			cues.map((cue) => ({
				head: cue.head,
				text: options.cache.get(cueHash(cue.text)) ?? cue.text,
			})),
		),
		added,
		complete: added === missing.length,
	};
}
