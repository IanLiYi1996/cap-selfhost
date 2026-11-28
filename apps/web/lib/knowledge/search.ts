import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { inArray } from "drizzle-orm";
import { runPromise } from "@/lib/server";
import type { Bucket } from "@/lib/video-materials/storage";
import { loadViewableVideo } from "@/lib/video-qa/access";
import { effectiveSettings } from "@/lib/video-qa/ask";
import { decodeStorageVideo } from "@/lib/video-storage";
import type { KnowledgeKind } from "./chunks";
import { purgeVideoKnowledge } from "./indexer";
import {
	groupResults,
	type KnowledgeGroup,
	type KnowledgeResult,
	type MeetingInfo,
} from "./results";
import { queryKnowledge, type VectorFilter } from "./store";

type VideoRow = typeof videos.$inferSelect;

export type ViewableMeeting = {
	info: MeetingInfo;
	video: VideoRow;
	bucket: Bucket;
};

/**
 * The meetings among `videoIds` the current viewer may see, by the share
 * page's own rule, leaving out meetings whose transcript is hidden (answers
 * quote it). Vectors of meetings that no longer exist are purged.
 */
export async function loadViewableMeetings(
	videoIds: readonly string[],
): Promise<Map<string, ViewableMeeting>> {
	const ids = [...new Set(videoIds)];
	const meetings = new Map<string, ViewableMeeting>();
	if (ids.length === 0) return meetings;

	const existing = new Set(
		(
			await db()
				.select({ id: videos.id })
				.from(videos)
				.where(inArray(videos.id, ids as Video.VideoId[]))
		).map((row) => row.id as string),
	);
	for (const id of ids) {
		if (!existing.has(id)) {
			void purgeVideoKnowledge(id).catch((error) =>
				console.warn(`[knowledge] purge of ${id} failed`, error),
			);
		}
	}

	await Promise.all(
		ids
			.filter((id) => existing.has(id))
			.map(async (id) => {
				const video = await loadViewableVideo(id as Video.VideoId);
				if (!video || video.isScreenshot) return;
				const settings = await effectiveSettings(video);
				if (settings.disableTranscript) return;
				const [bucket] = await Storage.getAccessForVideo(
					decodeStorageVideo(video),
				).pipe(runPromise);
				const metadata = (video.metadata as VideoMetadata | null) ?? {};
				meetings.set(id, {
					video,
					bucket,
					info: {
						videoId: id,
						title: metadata.aiTitle || video.name,
						recordedAt: new Date(video.createdAt).toISOString(),
						durationSeconds: video.duration ?? null,
					},
				});
			}),
	);
	return meetings;
}

export type SearchResponse = {
	groups: (KnowledgeGroup & {
		results: (KnowledgeResult & { thumbnailUrl: string | null })[];
	})[];
	results: KnowledgeResult[];
	meetings: Map<string, ViewableMeeting>;
};

export async function searchKnowledge(options: {
	orgId: string;
	query: string;
	kinds?: readonly KnowledgeKind[];
	topK?: number;
	perMeeting?: number;
	refPrefix?: string;
	withThumbnails?: boolean;
}): Promise<SearchResponse> {
	const filter: VectorFilter = options.kinds?.length
		? {
				$and: [{ orgId: options.orgId }, { kind: { $in: [...options.kinds] } }],
			}
		: { orgId: options.orgId };
	const hits = await queryKnowledge({
		query: options.query,
		filter,
		topK: options.topK ?? 60,
	});
	const meetings = await loadViewableMeetings(hits.map((hit) => hit.videoId));
	const infos = new Map(
		[...meetings].map(([id, meeting]) => [id, meeting.info] as const),
	);
	const { groups, results } = groupResults(
		hits,
		infos,
		options.perMeeting ?? 4,
		options.refPrefix ?? "R",
	);

	const withUrls = await Promise.all(
		groups.map(async (group) => ({
			...group,
			results: await Promise.all(
				group.results.map(async (result) => {
					const bucket = meetings.get(result.videoId)?.bucket;
					const thumbnailUrl =
						options.withThumbnails && result.imageKey && bucket
							? await bucket
									.getSignedObjectUrl(result.imageKey)
									.pipe(runPromise)
									.catch(() => null)
							: null;
					return { ...result, thumbnailUrl };
				}),
			),
		})),
	);
	return { groups: withUrls, results, meetings };
}
