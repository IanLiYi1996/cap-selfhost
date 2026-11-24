import { db } from "@cap/database";
import {
	organizations,
	spaces,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import {
	provideOptionalAuth,
	resolveEffectiveVideoRules,
	Storage,
	VideosPolicy,
} from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { type SystemModelMessage, tool } from "ai";
import { eq } from "drizzle-orm";
import { Effect, Exit, Option } from "effect";
import { z } from "zod";
import { formatPlayerTime } from "@/lib/player-time";
import * as EffectRuntime from "@/lib/server";
import { runPromise } from "@/lib/server";
import { fetchStorageUrl } from "@/lib/storage-fetch";
import { decodeStorageVideo } from "@/lib/video-storage";
import {
	type FramesIndex,
	framesIndexKey,
	parseFramesIndex,
	parseVisualTimeline,
	visualTimelineKey,
} from "./artifacts";
import { pickLookAtFrames } from "./plan";
import { buildVideoQaContext, VIDEO_QA_INSTRUCTIONS } from "./prompt";
import { ensureVisualTimeline, type VisualTimelineState } from "./timeline";
import { parseVttCues } from "./transcript";

export { type AskRequest, type AskTurn, parseAskRequest } from "./request";

// ~1M tokens is the model's window; Chinese runs about one token per
// character, so this leaves room for the answer and a few look_at frames.
const MAX_CONTEXT_CHARS = 700_000;
const LOOK_AT_MAX_FRAMES = 6;
const LOOK_AT_MAX_CALLS = 3;

type VideoRow = typeof videos.$inferSelect;
type Bucket = Effect.Effect.Success<
	ReturnType<typeof Storage.getAccessForVideo>
>[0];

export type AskContext =
	| {
			status: "ok";
			instructions: SystemModelMessage[];
			framesIndex: FramesIndex | null;
			bucket: Bucket;
			timelineState: VisualTimelineState;
	  }
	| { status: "not_found" | "disabled" | "not_ready" | "too_long" };

async function loadViewableVideo(
	videoId: Video.VideoId,
): Promise<VideoRow | null> {
	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;
		return yield* Effect.promise(() =>
			db().select().from(videos).where(eq(videos.id, videoId)).limit(1),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	return Exit.isSuccess(exit) ? (exit.value[0] ?? null) : null;
}

async function effectiveSettings(video: VideoRow) {
	const [[organization], sharedSpaces] = await Promise.all([
		db()
			.select({ settings: organizations.settings })
			.from(organizations)
			.where(eq(organizations.id, video.orgId))
			.limit(1),
		db()
			.select({
				id: spaces.id,
				name: spaces.name,
				organizationId: spaces.organizationId,
				settings: spaces.settings,
			})
			.from(spaceVideos)
			.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
			.where(eq(spaceVideos.videoId, video.id)),
	]);

	return resolveEffectiveVideoRules({
		videoSettings: video.settings,
		organizationSettings: organization?.settings,
		spaces: sharedSpaces.filter((space) => space.id !== space.organizationId),
	}).settings;
}

async function readText(bucket: Bucket, key: string): Promise<string | null> {
	const object = await bucket
		.getObject(key)
		.pipe(runPromise)
		.catch(() => Option.none<string>());
	return Option.isSome(object) ? object.value : null;
}

export async function loadAskContext(
	videoId: Video.VideoId,
): Promise<AskContext> {
	const video = await loadViewableVideo(videoId);
	if (!video || video.isScreenshot) return { status: "not_found" };

	const settings = await effectiveSettings(video);
	// Answers quote the transcript, so a video that hides its transcript must
	// not expose it through Q&A either.
	if (settings.disableTranscript) return { status: "disabled" };
	if (video.transcriptionStatus !== "COMPLETE") return { status: "not_ready" };

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);
	const userId = video.ownerId;

	const [vtt, timelineRaw, framesRaw] = await Promise.all([
		readText(bucket, `${userId}/${videoId}/transcription.vtt`),
		readText(bucket, visualTimelineKey(userId, videoId)),
		readText(bucket, framesIndexKey(userId, videoId)),
	]);
	if (!vtt) return { status: "not_ready" };

	const timeline = timelineRaw ? parseVisualTimeline(timelineRaw) : null;
	const framesIndex = framesRaw ? parseFramesIndex(framesRaw) : null;
	const metadata = (video.metadata as VideoMetadata | null) ?? {};
	const cues = parseVttCues(vtt);

	const context = buildVideoQaContext({
		title: metadata.aiTitle || video.name,
		durationSeconds: video.duration ?? cues.at(-1)?.end ?? 0,
		summary: settings.disableSummary ? null : metadata.summary,
		chapters: settings.disableChapters ? null : metadata.chapters,
		cues,
		timeline,
	});
	if (context.length > MAX_CONTEXT_CHARS) return { status: "too_long" };

	const timelineState: VisualTimelineState = timeline
		? "ready"
		: await ensureVisualTimeline(video).catch((error) => {
				console.error(`[video-qa] ensureVisualTimeline ${videoId}`, error);
				return "unavailable" as const;
			});

	return {
		status: "ok",
		bucket,
		framesIndex,
		timelineState,
		instructions: [
			{ role: "system", content: VIDEO_QA_INSTRUCTIONS },
			{
				role: "system",
				content: context,
				// The per-video context is the long, stable prefix of every turn, so
				// follow-up questions read it from the cache instead of paying for it
				// again.
				providerOptions: {
					bedrock: { cachePoint: { type: "default" } },
					anthropic: { cacheControl: { type: "ephemeral" } },
				},
			},
		],
	};
}

export function createLookAtTool(bucket: Bucket, framesIndex: FramesIndex) {
	let calls = 0;

	return tool({
		description: `Look at frames of the recording between two times, in seconds from the start. Returns up to ${LOOK_AT_MAX_FRAMES} frames, each labelled with its timestamp. Ask for a narrow range around the moment you need.`,
		inputSchema: z.object({
			start: z.number().min(0).describe("Start of the range, in seconds"),
			end: z.number().min(0).describe("End of the range, in seconds"),
		}),
		execute: async ({ start, end }) => {
			calls += 1;
			if (calls > LOOK_AT_MAX_CALLS) {
				return { note: "look_at limit reached for this answer.", frames: [] };
			}

			const picked = pickLookAtFrames(
				framesIndex,
				start,
				end,
				LOOK_AT_MAX_FRAMES,
			);
			const frames = await Promise.all(
				picked.map(async (frame) => {
					const url = await bucket
						.getInternalSignedObjectUrl(frame.key)
						.pipe(runPromise);
					const response = await fetchStorageUrl(url);
					if (!response.ok) return null;
					return {
						t: frame.t,
						data: new Uint8Array(await response.arrayBuffer()),
					};
				}),
			);
			const found = frames.filter((frame) => frame !== null);
			return {
				note:
					found.length > 0
						? `${found.length} frames between ${formatPlayerTime(start)} and ${formatPlayerTime(end)}.`
						: "No frames are available for this range.",
				frames: found,
			};
		},
		toModelOutput: ({ output }) => ({
			type: "content",
			value: [
				{ type: "text", text: output.note },
				...output.frames.flatMap((frame) => [
					{
						type: "text" as const,
						text: `Frame at [${formatPlayerTime(frame.t)}]`,
					},
					{
						type: "file" as const,
						data: { type: "data" as const, data: frame.data },
						mediaType: "image/jpeg",
					},
				]),
			],
		}),
	});
}
