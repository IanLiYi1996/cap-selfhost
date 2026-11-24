import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import { serverEnv } from "@cap/env";
import type { AssemblyAIEditResult } from "@/lib/edit-transcript";

export type WhisperWord = {
	text: string;
	start: number;
	end: number;
	confidence: number | null;
	/**
	 * Diarization label ("A", "B", ...). Optional rather than required: absent
	 * whenever diarization is off or its models are missing, and the mapper
	 * normalises it to null so the downstream contract stays `string | null`.
	 */
	speaker?: string | null;
};

export type WhisperResult = {
	language: string | null;
	model: string;
	durationSeconds: number;
	words: WhisperWord[];
};

const finite = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

export function parseWhisperResult(raw: unknown): WhisperResult {
	if (typeof raw !== "object" || raw === null || !("words" in raw)) {
		throw new Error("Whisper result is not an object with a words array");
	}

	const record = raw as Record<string, unknown>;
	if (!Array.isArray(record.words)) {
		throw new Error("Whisper result words is not an array");
	}

	const words: WhisperWord[] = [];
	for (const entry of record.words) {
		if (typeof entry !== "object" || entry === null) continue;
		const word = entry as Record<string, unknown>;
		const text = typeof word.text === "string" ? word.text.trim() : "";
		const start = finite(word.start);
		const end = finite(word.end);
		if (!text || start === null || end === null) continue;
		words.push({
			text,
			start,
			end,
			confidence: finite(word.confidence),
			// Absent whenever diarization is disabled or its models are missing —
			// the transcript is still valid, just without speaker attribution.
			speaker:
				typeof word.speaker === "string" && word.speaker ? word.speaker : null,
		});
	}

	return {
		language: typeof record.language === "string" ? record.language : null,
		model: typeof record.model === "string" ? record.model : "unknown",
		durationSeconds: finite(record.durationSeconds) ?? 0,
		words,
	};
}

/**
 * Whisper reports seconds; AssemblyAI — and therefore createEditTranscript —
 * expects milliseconds. Getting this wrong puts the whole timeline three
 * orders of magnitude out, so it lives here behind a unit test.
 */
export function whisperResultToEditResult(
	result: WhisperResult,
): AssemblyAIEditResult {
	return {
		language_code: result.language,
		speech_model_used:
			result.model === "aws-transcribe"
				? result.model
				: `whisper-${result.model}`,
		words: result.words.map((word) => ({
			text: word.text,
			start: Math.round(word.start * 1000),
			end: Math.round(word.end * 1000),
			confidence: word.confidence,
			// `?? null` not just `word.speaker`: the contract is `string | null`, and a
			// word built without the field would otherwise serialise as undefined.
			speaker: word.speaker ?? null,
			channel: null,
		})),
	};
}

export function isWhisperConfigured(): boolean {
	const env = serverEnv();
	return Boolean(
		env.WHISPER_CLUSTER_ARN &&
			env.WHISPER_TASK_DEFINITION_ARN &&
			env.WHISPER_SUBNET_IDS &&
			env.WHISPER_SECURITY_GROUP_ID,
	);
}

/**
 * Upstream gates batch transcription on ASSEMBLY_API_KEY in several places.
 * This predicate satisfies all of them from one definition so a self-hosted
 * Whisper deployment doesn't have to set an AssemblyAI key it will never use.
 */
export function isTranscriptionConfigured(): boolean {
	return (
		serverEnv().TRANSCRIPTION_BACKEND === "transcribe" ||
		isWhisperConfigured() ||
		Boolean(serverEnv().ASSEMBLY_API_KEY)
	);
}

const DEFAULT_POLL_ATTEMPTS = 120;
const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * How long to wait for the Whisper task, scaled to the recording.
 *
 * A flat 120 attempts (10 minutes) silently capped transcription at roughly
 * eight minutes of audio: a 31-minute recording needs ~36 minutes of inference,
 * so the poll gave up long before the task it was waiting for could finish, and
 * the transcription failed while the task went on to succeed.
 *
 * The costs are badly asymmetric, so this is deliberately generous. Overshooting
 * spends a few S3 lookups on a job that already failed. Undershooting discards a
 * transcription that was going to work, and the user has to notice and retry.
 *
 * Two hours as a floor, 4x duration beyond that. Measured throughput is ~1.15x
 * realtime for `medium` int8 on 4 vCPU plus ~0.09x for diarization, so 4x also
 * leaves room for `large-v3`, which is roughly 3x slower than `medium` and is
 * the obvious upgrade if Chinese accuracy ever needs it.
 *
 * The better shape is to watch the task itself — a STOPPED task with no output
 * is a definitive failure, and a RUNNING one should be waited on however long it
 * takes — but the task role only holds `ecs:RunTask`, so that needs an IAM
 * change first.
 */
export function whisperPollAttempts(
	videoDurationMs: number,
	intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): number {
	const floorMs = 2 * 60 * 60 * 1000;
	const budgetMs = Math.max(floorMs, 4 * Math.max(0, videoDurationMs));
	return Math.max(DEFAULT_POLL_ATTEMPTS, Math.ceil(budgetMs / intervalMs));
}

/**
 * Bumped whenever the task's output semantics change — model, word merging,
 * simplified-Chinese conversion, diarization.
 *
 * The version is what makes reusing an existing artifact safe (see the
 * skip-if-present check in the transcribe workflow): an object written by an
 * older pipeline lives under an older key and is simply never found, instead of
 * being silently reused and reintroducing the behaviour that was just fixed.
 */
const WHISPER_OUTPUT_VERSION = 2;

export function whisperOutputKey(userId: string, videoId: string): string {
	return `${userId}/${videoId}/whisper.words.v${WHISPER_OUTPUT_VERSION}.json`;
}

export async function startWhisperTask(params: {
	bucket: string;
	inputKey: string;
	outputKey: string;
	language?: string;
	environment?: Record<string, string>;
}): Promise<string> {
	const env = serverEnv();
	const client = new ECSClient({ region: env.CAP_AWS_REGION });

	const response = await client.send(
		new RunTaskCommand({
			cluster: env.WHISPER_CLUSTER_ARN,
			taskDefinition: env.WHISPER_TASK_DEFINITION_ARN,
			launchType: "FARGATE",
			networkConfiguration: {
				awsvpcConfiguration: {
					subnets: (env.WHISPER_SUBNET_IDS ?? "")
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean),
					securityGroups: [env.WHISPER_SECURITY_GROUP_ID ?? ""],
					assignPublicIp: "DISABLED",
				},
			},
			overrides: {
				containerOverrides: [
					{
						name: "whisper",
						environment: [
							{ name: "INPUT_BUCKET", value: params.bucket },
							{ name: "INPUT_KEY", value: params.inputKey },
							{ name: "OUTPUT_KEY", value: params.outputKey },
							...(params.language
								? [{ name: "LANGUAGE", value: params.language }]
								: []),
							...Object.entries(params.environment ?? {}).map(
								([name, value]) => ({ name, value }),
							),
						],
					},
				],
			},
		}),
	);

	const failure = response.failures?.[0];
	if (failure) {
		throw new Error(
			`Failed to start whisper task: ${failure.reason ?? "unknown"} ${failure.detail ?? ""}`.trim(),
		);
	}

	const taskArn = response.tasks?.[0]?.taskArn;
	if (!taskArn) throw new Error("RunTask returned no task ARN");
	return taskArn;
}

const wait = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

export async function pollWhisperOutput(
	readOutput: () => Promise<string | null>,
	options?: {
		attempts?: number;
		intervalMs?: number;
		sleep?: (ms: number) => Promise<void>;
	},
): Promise<WhisperResult> {
	const attempts = options?.attempts ?? DEFAULT_POLL_ATTEMPTS;
	const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const sleep = options?.sleep ?? wait;

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const body = await readOutput();
			if (body) return parseWhisperResult(JSON.parse(body));
		} catch (error) {
			// A missing object and a transient S3 error look the same from here;
			// both are worth another attempt within the overall budget.
			console.warn("[whisper] poll attempt failed", error);
		}
		if (attempt < attempts - 1) await sleep(intervalMs);
	}

	throw new Error(
		`Whisper task did not produce output after ${attempts} attempts`,
	);
}
