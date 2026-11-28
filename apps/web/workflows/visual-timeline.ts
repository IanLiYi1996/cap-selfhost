import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { resolveRecordingObjectKey } from "@cap/web-backend/src/Storage/recording-output";
import type { Video } from "@cap/web-domain";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { getAiModel } from "@/lib/ai/provider";
import { runWithAiProviders } from "@/lib/ai/run";
import { queueKnowledgeIndex } from "@/lib/knowledge/queue";
import { fetchStorageUrl } from "@/lib/storage-fetch";
import {
	framesIndexKey,
	framesPrefix,
	parseFramesIndex,
	type TimelineSegment,
	type VisualTimeline,
	visualTimelineKey,
	visualTimelineLockKey,
} from "@/lib/video-qa/artifacts";
import {
	framesPollAttempts,
	parseBatchDescription,
	planTimelineBatches,
	type TimelineBatch,
} from "@/lib/video-qa/plan";
import { buildBatchPrompt, TIMELINE_INSTRUCTIONS } from "@/lib/video-qa/prompt";
import { parseVttCues, transcriptBetween } from "@/lib/video-qa/transcript";
import { decodeStorageVideo } from "@/lib/video-storage";
import { startWhisperTask } from "@/lib/whisper";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

interface VisualTimelinePayload {
	videoId: string;
	userId: string;
}

type PreparedFrames =
	| { status: "ready"; batches: TimelineBatch[] }
	| { status: "skipped"; reason: string };

const POLL_INTERVAL_MS = 5000;
const DESCRIBE_TIMEOUT_MS = 3 * 60 * 1000;
const DESCRIBE_MAX_OUTPUT_TOKENS = 4000;

export async function visualTimelineWorkflow(payload: VisualTimelinePayload) {
	"use workflow";

	const { videoId, userId } = payload;

	try {
		const prepared = await prepareFrames(videoId, userId);
		if (prepared.status !== "ready") {
			return { success: false, message: prepared.reason };
		}

		const segments: TimelineSegment[] = [];
		for (const batch of prepared.batches) {
			segments.push(...(await describeBatch(videoId, userId, batch)));
		}

		if (segments.length === 0) {
			return { success: false, message: "No batch could be described" };
		}
		await saveTimeline(videoId, userId, segments);
		return { success: true, message: `${segments.length} segments` };
	} finally {
		await releaseLock(videoId, userId);
	}
}

async function loadVideoBucket(videoId: string) {
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);
	if (!video) return null;
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	return { video, bucket };
}

const wait = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

async function prepareFrames(
	videoId: string,
	userId: string,
): Promise<PreparedFrames> {
	"use step";

	const loaded = await loadVideoBucket(videoId);
	if (!loaded) return { status: "skipped", reason: "Video not found" };
	const { video, bucket } = loaded;

	const indexKey = framesIndexKey(userId, videoId);
	const readIndex = async () => {
		const object = await bucket.getObject(indexKey).pipe(runWorkflowPromise);
		return Option.isSome(object) ? parseFramesIndex(object.value) : null;
	};

	let index = await readIndex();
	if (!index) {
		// The keyframe task reads raw S3 keys, but recent recordings keep the
		// muxed file under .recording/outputs/ and only resolve result.mp4
		// through the storage layer, so pass it the physical key.
		const sourceKey = resolveRecordingObjectKey(
			video,
			`${userId}/${videoId}/result.mp4`,
		);
		const hasSource = await bucket
			.headObject(sourceKey)
			.pipe(runWorkflowPromise)
			.then(() => true)
			.catch(() => false);
		if (!hasSource)
			return { status: "skipped", reason: `No source video at ${sourceKey}` };

		await startWhisperTask({
			bucket: serverEnv().CAP_AWS_BUCKET,
			inputKey: sourceKey,
			outputKey: indexKey,
			environment: {
				TASK_MODE: "keyframes",
				FRAMES_PREFIX: framesPrefix(userId, videoId),
			},
		});

		const attempts = framesPollAttempts(video.duration ?? 0, POLL_INTERVAL_MS);
		for (let attempt = 0; attempt < attempts && !index; attempt += 1) {
			await wait(POLL_INTERVAL_MS);
			index = await readIndex().catch(() => null);
		}
		if (!index) {
			throw new Error(
				`Keyframe task produced no index after ${attempts} polls`,
			);
		}
	}

	const batches = planTimelineBatches(index);
	console.log(
		`[visual-timeline] ${videoId}: ${index.frames.length} frames, ${batches.length} batches`,
	);
	return batches.length > 0
		? { status: "ready", batches }
		: { status: "skipped", reason: "No keyframes" };
}

async function describeBatch(
	videoId: string,
	userId: string,
	batch: TimelineBatch,
): Promise<TimelineSegment[]> {
	"use step";

	const loaded = await loadVideoBucket(videoId);
	if (!loaded) return [];
	const { bucket } = loaded;

	const vtt = await bucket
		.getObject(`${userId}/${videoId}/transcription.vtt`)
		.pipe(runWorkflowPromise);
	const transcript = Option.isSome(vtt)
		? transcriptBetween(parseVttCues(vtt.value), batch.start, batch.end)
		: "";

	const images = await Promise.all(
		batch.frames.map(async (frame) => {
			const url = await bucket
				.getInternalSignedObjectUrl(frame.key)
				.pipe(runWorkflowPromise);
			const response = await fetchStorageUrl(url);
			if (!response.ok) return null;
			return {
				t: frame.t,
				bytes: new Uint8Array(await response.arrayBuffer()),
			};
		}),
	);

	const prompt = buildBatchPrompt(batch, transcript);
	const content = [
		{ type: "text" as const, text: prompt.header },
		...images.flatMap((image) =>
			image
				? [
						{ type: "text" as const, text: prompt.frameLabel(image.t) },
						{
							type: "image" as const,
							image: image.bytes,
							mediaType: "image/jpeg",
						},
					]
				: [],
		),
		{ type: "text" as const, text: prompt.footer },
	];

	try {
		const text = await runWithAiProviders("generation", async (selection) => {
			const result = await generateText({
				model: selection.model(),
				instructions: TIMELINE_INSTRUCTIONS,
				messages: [{ role: "user", content }],
				maxOutputTokens: DESCRIBE_MAX_OUTPUT_TOKENS,
				abortSignal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
			});
			return result.text;
		});
		return parseBatchDescription(text, batch);
	} catch (error) {
		// One failed window should not cost the rest of the timeline; the gap only
		// means look_at has to fill it at question time.
		console.error(
			`[visual-timeline] ${videoId}: describing ${batch.start}-${batch.end}s failed`,
			error,
		);
		return [];
	}
}

async function saveTimeline(
	videoId: string,
	userId: string,
	segments: TimelineSegment[],
): Promise<void> {
	"use step";

	const loaded = await loadVideoBucket(videoId);
	if (!loaded) return;

	const timeline: VisualTimeline = {
		version: 1,
		model: getAiModel("generation")?.modelId ?? "",
		generatedAt: new Date().toISOString(),
		segments,
	};
	await loaded.bucket
		.putObject(visualTimelineKey(userId, videoId), JSON.stringify(timeline), {
			contentType: "application/json",
		})
		.pipe(runWorkflowPromise);
	console.log(
		`[visual-timeline] ${videoId}: saved ${segments.length} segments`,
	);
	await queueKnowledgeIndex(videoId);
}

async function releaseLock(videoId: string, userId: string): Promise<void> {
	"use step";

	const loaded = await loadVideoBucket(videoId);
	if (!loaded) return;
	await loaded.bucket
		.deleteObject(visualTimelineLockKey(userId, videoId))
		.pipe(runWorkflowPromise)
		.catch(() => undefined);
}
