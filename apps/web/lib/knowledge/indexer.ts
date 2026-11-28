import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Storage } from "@cap/web-backend/src/Storage/index";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { fetchStorageUrl } from "@/lib/storage-fetch";
import { loadMaterials } from "@/lib/video-materials/materials";
import { readText } from "@/lib/video-materials/storage";
import {
	framesIndexKey,
	parseFramesIndex,
	parseVisualTimeline,
	visualTimelineKey,
} from "@/lib/video-qa/artifacts";
import { parseVttCues } from "@/lib/video-qa/transcript";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";
import {
	frameChunks,
	type KnowledgeChunk,
	knowledgeManifestKey,
	materialChunks,
	parseIndexManifest,
	planIndexUpdate,
	summaryChunks,
	transcriptChunks,
	visualChunks,
} from "./chunks";
import { deleteKeys, embed, putChunks, queryKnowledge } from "./store";

const EMBED_CONCURRENCY = 8;

async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await fn(items[index] as T);
			}
		}),
	);
	return results;
}

export type IndexOutcome =
	| { status: "missing" }
	| {
			status: "indexed";
			chunks: number;
			embedded: number;
			removed: number;
			failed: number;
	  };

/**
 * Bring one meeting's vectors in line with its transcript, screen timeline,
 * summary and materials. Only chunks whose content changed are embedded
 * again; chunks that no longer exist are deleted.
 */
export async function indexVideoKnowledge(
	videoId: string,
): Promise<IndexOutcome> {
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);
	if (!video) return { status: "missing" };

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	const { ownerId } = video;
	const metadata = (video.metadata as VideoMetadata | null) ?? {};

	const [vtt, timelineRaw, framesRaw, materials, manifestRaw] =
		await Promise.all([
			readText(bucket, `${ownerId}/${videoId}/transcription.vtt`),
			readText(bucket, visualTimelineKey(ownerId, videoId)),
			readText(bucket, framesIndexKey(ownerId, videoId)),
			loadMaterials(bucket, video),
			readText(bucket, knowledgeManifestKey(ownerId, videoId)),
		]);
	const segments =
		(timelineRaw ? parseVisualTimeline(timelineRaw) : null)?.segments ?? [];
	const frames = framesRaw ? parseFramesIndex(framesRaw) : null;

	const chunks: KnowledgeChunk[] = video.isScreenshot
		? []
		: [
				...transcriptChunks(videoId, vtt ? parseVttCues(vtt) : []),
				...visualChunks(videoId, segments),
				...frameChunks(videoId, frames, segments),
				...summaryChunks(
					videoId,
					metadata.aiTitle || video.name,
					metadata.summary,
					metadata.chapters,
				),
				...materialChunks(videoId, materials),
			];

	const plan = planIndexUpdate(
		parseIndexManifest(manifestRaw),
		chunks,
		video.orgId,
	);

	const embedded = await mapLimit(
		plan.upsert,
		EMBED_CONCURRENCY,
		async (chunk) => {
			try {
				if (chunk.imageKey) {
					const url = await bucket
						.getInternalSignedObjectUrl(chunk.imageKey)
						.pipe(runWorkflowPromise);
					const response = await fetchStorageUrl(url);
					if (!response.ok) throw new Error(`image ${response.status}`);
					const image = new Uint8Array(await response.arrayBuffer());
					return { chunk, vector: await embed({ image }, "GENERIC_INDEX") };
				}
				if (!chunk.embedText.trim()) return null;
				return {
					chunk,
					vector: await embed({ text: chunk.embedText }, "GENERIC_INDEX"),
				};
			} catch (error) {
				console.warn(
					`[knowledge] ${videoId}: could not embed ${chunk.key}`,
					error instanceof Error ? error.message : error,
				);
				return null;
			}
		},
	);
	const ok = embedded.filter((item) => item !== null);
	const failedKeys = new Set(
		plan.upsert
			.map((chunk) => chunk.key)
			.filter((key) => !ok.some((item) => item.chunk.key === key)),
	);

	await putChunks(
		{
			orgId: video.orgId,
			videoId,
			ownerId,
			recordedAt: Math.floor(new Date(video.createdAt).getTime() / 1000),
		},
		ok,
	);
	await deleteKeys(plan.remove);

	// A chunk that failed to embed is left out, so the next run retries it.
	const manifest = {
		version: 1 as const,
		chunks: Object.fromEntries(
			Object.entries(plan.manifest.chunks).filter(
				([key]) => !failedKeys.has(key),
			),
		),
	};
	await bucket
		.putObject(
			knowledgeManifestKey(ownerId, videoId),
			JSON.stringify(manifest),
			{
				contentType: "application/json",
			},
		)
		.pipe(runWorkflowPromise);

	return {
		status: "indexed",
		chunks: chunks.length,
		embedded: ok.length,
		removed: plan.remove.length,
		failed: failedKeys.size,
	};
}

/**
 * Remove a deleted meeting's vectors. Its manifest went with its files, so
 * the vectors are found by querying the index filtered to the meeting.
 */
export async function purgeVideoKnowledge(videoId: string): Promise<number> {
	let removed = 0;
	for (let round = 0; round < 50; round++) {
		const hits = await queryKnowledge({
			query: "meeting",
			filter: { videoId },
			topK: 100,
		});
		if (hits.length === 0) break;
		await deleteKeys(hits.map((hit) => hit.key));
		removed += hits.length;
	}
	return removed;
}
