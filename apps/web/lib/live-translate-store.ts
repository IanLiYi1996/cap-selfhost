import {
	TranslateClient,
	TranslateTextCommand,
} from "@aws-sdk/client-translate";
import { serverEnv } from "@cap/env";
import type { LanguageCode } from "@cap/web-domain/src/Language";
import type { LiveTranscriptArtifact } from "@/lib/live-transcribe-core";
import {
	isSameLanguage,
	liveTranslationKey,
	parseTranslationCache,
	serializeTranslationCache,
	translateLanguageCode,
	translateSourceCode,
	translateVtt,
} from "@/lib/live-translate";
import { runPromise } from "@/lib/server";
import { type Bucket, readText } from "@/lib/video-materials/storage";

let client: TranslateClient | null = null;

export const isLiveTranslationEnabled = () =>
	serverEnv().LIVE_TRANSLATE_BACKEND === "aws-translate";

/** Polls from several viewers for the same transcript share one round of
 * translation instead of each paying for the same new cues. */
const inFlight = new Map<string, Promise<string | null>>();

export function translateLiveTranscript(options: {
	bucket: Bucket;
	ownerId: string;
	videoId: string;
	artifact: LiveTranscriptArtifact;
	language: LanguageCode;
}): Promise<string | null> {
	if (!isLiveTranslationEnabled()) return Promise.resolve(null);
	const source = translateSourceCode(options.artifact.languageCode);
	if (isSameLanguage(source, options.language)) {
		return Promise.resolve(options.artifact.vtt);
	}

	const key = liveTranslationKey(
		options.ownerId,
		options.videoId,
		options.language,
	);
	const running = inFlight.get(key);
	if (running) return running;
	const work = translate(options, key, source).finally(() =>
		inFlight.delete(key),
	);
	inFlight.set(key, work);
	return work;
}

async function translate(
	options: Parameters<typeof translateLiveTranscript>[0],
	key: string,
	source: string,
): Promise<string | null> {
	try {
		client ??= new TranslateClient({ region: serverEnv().CAP_AWS_REGION });
		const translator = client;
		const cache = parseTranslationCache(await readText(options.bucket, key));
		const target = translateLanguageCode(options.language);
		const result = await translateVtt({
			vtt: options.artifact.vtt,
			cache,
			translate: async (text) =>
				(
					await translator.send(
						new TranslateTextCommand({
							Text: text,
							SourceLanguageCode: source,
							TargetLanguageCode: target,
						}),
					)
				).TranslatedText ?? "",
		});
		if (result.added > 0) {
			await options.bucket
				.putObject(key, serializeTranslationCache(cache), {
					contentType: "application/json",
				})
				.pipe(runPromise);
		}
		return result.vtt;
	} catch (error) {
		console.warn(
			`[liveTranslate] ${options.videoId} → ${options.language} failed`,
			error,
		);
		return null;
	}
}
