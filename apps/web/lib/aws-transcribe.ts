import {
	ConflictException,
	DeleteTranscriptionJobCommand,
	GetTranscriptionJobCommand,
	type LanguageCode,
	StartTranscriptionJobCommand,
	TranscribeClient,
} from "@aws-sdk/client-transcribe";
import { serverEnv } from "@cap/env";
import type { WhisperResult, WhisperWord } from "@/lib/whisper";

/**
 * Amazon Transcribe as the batch backend. Measured against Whisper medium on
 * two real Chinese meetings (64 and 80 min): 6-7 min instead of 1-1h45, usable
 * speaker labels (4 and 7 speakers where Whisper produced 48 and 91), full
 * punctuation, and 工单 recognised where Whisper wrote 公单. It is weaker on
 * English terms inside Chinese speech (Agent, GraphRAG, mock).
 */

export const AWS_TRANSCRIBE_MODEL = "aws-transcribe";

const OUTPUT_VERSION = 1;
const DEFAULT_LANGUAGE_OPTIONS = ["zh-CN", "en-US"];
const MAX_SPEAKER_LABELS = 10;
const POLL_INTERVAL_MS = 10_000;

const LANGUAGE_CODES: Record<string, string> = {
	zh: "zh-CN",
	en: "en-US",
	es: "es-US",
	fr: "fr-FR",
	de: "de-DE",
	pt: "pt-BR",
	it: "it-IT",
	nl: "nl-NL",
	pl: "pl-PL",
	ru: "ru-RU",
	tr: "tr-TR",
	ja: "ja-JP",
	ko: "ko-KR",
	ar: "ar-SA",
	hi: "hi-IN",
	fa: "fa-IR",
	he: "he-IL",
};

export type TranscribePurpose = "transcript" | "edit-transcript";

export const isAwsTranscribeConfigured = () =>
	serverEnv().TRANSCRIPTION_BACKEND === "transcribe";

export const transcribeJobName = (
	videoId: string,
	purpose: TranscribePurpose,
) => `cap-${videoId}-${purpose}-v${OUTPUT_VERSION}`;

export const transcribeOutputKey = (
	userId: string,
	videoId: string,
	purpose: TranscribePurpose,
) => `${userId}/${videoId}/transcribe.${purpose}.v${OUTPUT_VERSION}.json`;

/** Languages a live stream identifies between (Transcribe Streaming takes
 * at most five). */
export function streamingLanguageOptions(
	configuredOptions: string | undefined,
): string[] {
	const configured = (configuredOptions ?? "")
		.split(",")
		.map((code) => code.trim())
		.filter((code) => /^[a-z]{2}-[A-Z]{2}$/.test(code));
	return (configured.length > 0 ? configured : DEFAULT_LANGUAGE_OPTIONS).slice(
		0,
		5,
	);
}

/**
 * The video's language setting is the language its AI summary is written in,
 * not necessarily the one spoken, so it joins the candidates instead of
 * forcing recognition (forcing English on a Chinese meeting is unusable).
 */
export function transcribeLanguageSettings(
	language: string,
	configuredOptions: string | undefined,
):
	| { IdentifyLanguage: true; LanguageOptions: string[] }
	| { LanguageCode: string } {
	const configured = (configuredOptions ?? "")
		.split(",")
		.map((code) => code.trim())
		.filter(Boolean);
	const options = configured.length > 0 ? configured : DEFAULT_LANGUAGE_OPTIONS;
	const requested = LANGUAGE_CODES[language];
	const candidates =
		requested && !options.includes(requested)
			? [...options, requested]
			: options;

	if (candidates.length === 1 && candidates[0]) {
		return { LanguageCode: candidates[0] };
	}
	return { IdentifyLanguage: true, LanguageOptions: candidates };
}

const toNumber = (value: unknown): number | null => {
	const parsed = typeof value === "string" ? Number(value) : value;
	return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
};

const speakerLetter = (label: unknown): string | null => {
	const match = typeof label === "string" ? label.match(/^spk_(\d+)$/) : null;
	if (!match?.[1]) return null;
	const index = Number(match[1]);
	return index < 26 ? String.fromCharCode(65 + index) : `S${index + 1}`;
};

export function parseTranscribeResult(raw: unknown): WhisperResult {
	const results =
		raw && typeof raw === "object"
			? (raw as { results?: unknown }).results
			: undefined;
	const items =
		results && typeof results === "object"
			? (results as { items?: unknown }).items
			: undefined;
	if (!Array.isArray(items)) {
		throw new Error("Amazon Transcribe output has no results.items array");
	}

	const words: WhisperWord[] = [];
	for (const entry of items) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const alternative = Array.isArray(record.alternatives)
			? (record.alternatives[0] as Record<string, unknown> | undefined)
			: undefined;
		const content =
			typeof alternative?.content === "string"
				? alternative.content.trim()
				: "";
		if (!content) continue;

		if (record.type === "punctuation") {
			const previous = words.at(-1);
			if (previous) previous.text += content;
			continue;
		}

		const start = toNumber(record.start_time);
		const end = toNumber(record.end_time);
		if (start === null || end === null) continue;
		words.push({
			text: content,
			start,
			end,
			confidence: toNumber(alternative?.confidence),
			speaker: speakerLetter(record.speaker_label),
		});
	}

	const languageCode = (results as { language_code?: unknown }).language_code;
	return {
		language:
			typeof languageCode === "string"
				? (languageCode.split("-")[0] ?? null)
				: null,
		model: AWS_TRANSCRIBE_MODEL,
		durationSeconds: words.at(-1)?.end ?? 0,
		words,
	};
}

const wait = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

async function getJob(client: TranscribeClient, jobName: string) {
	try {
		const response = await client.send(
			new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
		);
		return response.TranscriptionJob ?? null;
	} catch (error) {
		if (error instanceof Error && error.name === "BadRequestException") {
			return null;
		}
		throw error;
	}
}

export async function runTranscribeJob(params: {
	bucket: string;
	inputKey: string;
	outputKey: string;
	jobName: string;
	language: string;
	readOutput: () => Promise<string | null>;
	maxWaitMs: number;
}): Promise<WhisperResult> {
	// Both transcription paths (early-from-segments and post-mux) and step
	// retries can reach this for one video, so the deterministic job name and
	// the stored output make every caller converge on a single job.
	const existing = await params.readOutput();
	if (existing) return parseTranscribeResult(JSON.parse(existing));

	const env = serverEnv();
	const client = new TranscribeClient({ region: env.CAP_AWS_REGION });

	let job = await getJob(client, params.jobName);
	// FAILED needs a fresh job; COMPLETED here means its output was removed
	// (the output check above found nothing), so it is rerun the same way.
	if (
		job?.TranscriptionJobStatus === "FAILED" ||
		job?.TranscriptionJobStatus === "COMPLETED"
	) {
		await client.send(
			new DeleteTranscriptionJobCommand({
				TranscriptionJobName: params.jobName,
			}),
		);
		job = null;
	}

	if (!job) {
		const settings = transcribeLanguageSettings(
			params.language,
			env.TRANSCRIBE_LANGUAGE_OPTIONS,
		);
		const languageSettings =
			"LanguageCode" in settings
				? { LanguageCode: settings.LanguageCode as LanguageCode }
				: {
						IdentifyLanguage: true,
						LanguageOptions: settings.LanguageOptions as LanguageCode[],
					};
		try {
			await client.send(
				new StartTranscriptionJobCommand({
					TranscriptionJobName: params.jobName,
					Media: { MediaFileUri: `s3://${params.bucket}/${params.inputKey}` },
					OutputBucketName: params.bucket,
					OutputKey: params.outputKey,
					Settings: {
						ShowSpeakerLabels: true,
						MaxSpeakerLabels: MAX_SPEAKER_LABELS,
					},
					...languageSettings,
				}),
			);
			console.log(`[aws-transcribe] Started ${params.jobName}`);
		} catch (error) {
			if (!(error instanceof ConflictException)) throw error;
		}
	}

	const deadline = Date.now() + params.maxWaitMs;
	while (Date.now() < deadline) {
		const current = await getJob(client, params.jobName);
		const status = current?.TranscriptionJobStatus;
		if (status === "FAILED") {
			throw new Error(
				`Amazon Transcribe job ${params.jobName} failed: ${current?.FailureReason ?? "unknown"}`,
			);
		}
		if (status === "COMPLETED") {
			const output = await params.readOutput();
			if (output) return parseTranscribeResult(JSON.parse(output));
		}
		await wait(POLL_INTERVAL_MS);
	}

	throw new Error(
		`Amazon Transcribe job ${params.jobName} did not finish within ${Math.round(params.maxWaitMs / 60000)} min`,
	);
}
