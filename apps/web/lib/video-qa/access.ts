import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import * as EffectRuntime from "@/lib/server";

type VideoRow = typeof videos.$inferSelect;

/** The video, if the current viewer may watch it: the share page's own rule. */
export async function loadViewableVideo(
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
