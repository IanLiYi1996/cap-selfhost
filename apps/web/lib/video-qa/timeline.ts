import type { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Option } from "effect";
import { start } from "workflow/api";
import { decodeStorageVideo } from "@/lib/video-storage";
import { isWhisperConfigured } from "@/lib/whisper";
import { runWorkflowPromise } from "@/lib/workflow-runtime";
import { visualTimelineWorkflow } from "@/workflows/visual-timeline";
import { visualTimelineKey, visualTimelineLockKey } from "./artifacts";

export type VisualTimelineState =
	| "ready"
	| "pending"
	| "started"
	| "unavailable";

// Longer than the slowest run we expect (a two-hour recording: keyframes in a
// few minutes, then one describe call per ~10 frames), so a crashed run frees
// the video for a retry the next time someone asks, without a sweeper.
const LOCK_TTL_MS = 3 * 60 * 60 * 1000;

type VideoRow = typeof videos.$inferSelect;

/**
 * The keyframe task reads the source through the Whisper task role, which only
 * reaches the deployment's own bucket, so videos in a user-configured bucket
 * have no visual timeline (they still get transcript-only answers).
 */
export const canBuildVisualTimeline = (video: VideoRow) =>
	!video.isScreenshot && !video.bucket && isWhisperConfigured();

export async function ensureVisualTimeline(
	video: VideoRow,
): Promise<VisualTimelineState> {
	if (!canBuildVisualTimeline(video)) return "unavailable";

	const userId = video.ownerId;
	const videoId = video.id;
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	const existing = await bucket
		.headObject(visualTimelineKey(userId, videoId))
		.pipe(runWorkflowPromise)
		.then(() => true)
		.catch(() => false);
	if (existing) return "ready";

	const lockKey = visualTimelineLockKey(userId, videoId);
	const lockedAt = await bucket
		.getObject(lockKey)
		.pipe(runWorkflowPromise)
		.then((object) => (Option.isSome(object) ? Number(object.value) : null))
		.catch(() => null);
	if (lockedAt && Date.now() - lockedAt < LOCK_TTL_MS) return "pending";

	await bucket
		.putObject(lockKey, String(Date.now()), { contentType: "text/plain" })
		.pipe(runWorkflowPromise);
	await start(visualTimelineWorkflow, [{ videoId, userId }]);
	console.log(`[visual-timeline] Started for video ${videoId}`);
	return "started";
}
