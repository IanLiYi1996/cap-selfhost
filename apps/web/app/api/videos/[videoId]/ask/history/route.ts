import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import type { Video } from "@cap/web-domain";
import type { NextRequest } from "next/server";
import { runPromise } from "@/lib/server";
import { loadMaterialsAccess } from "@/lib/video-materials/materials";
import { readText } from "@/lib/video-materials/storage";
import { askHistoryKey, parseAskHistory } from "@/lib/video-qa/history";

export const dynamic = "force-dynamic";

async function viewerHistory(
	request: NextRequest,
	props: RouteContext<"/api/videos/[videoId]/ask/history">,
	write: boolean,
) {
	const user =
		write && isCrossSiteCookieWrite(request) ? null : await getCurrentUser();
	if (!user)
		return {
			error: Response.json({ error: "Sign in first." }, { status: 401 }),
		};
	const { videoId } = (await props.params) as { videoId: Video.VideoId };
	const access = await loadMaterialsAccess(videoId, user.id);
	if (access.status !== "ok") {
		return {
			error: Response.json({ error: "Video not found." }, { status: 404 }),
		};
	}
	return {
		access,
		key: askHistoryKey(access.video.ownerId, videoId, user.id),
	};
}

export async function GET(
	request: NextRequest,
	props: RouteContext<"/api/videos/[videoId]/ask/history">,
) {
	const loaded = await viewerHistory(request, props, false);
	if ("error" in loaded) return loaded.error;
	const turns = parseAskHistory(
		await readText(loaded.access.bucket, loaded.key),
	);
	return Response.json(
		{ turns: turns.map(({ role, content }) => ({ role, content })) },
		{ headers: { "Cache-Control": "no-store" } },
	);
}

export async function DELETE(
	request: NextRequest,
	props: RouteContext<"/api/videos/[videoId]/ask/history">,
) {
	const loaded = await viewerHistory(request, props, true);
	if ("error" in loaded) return loaded.error;
	await loaded.access.bucket
		.deleteObject(loaded.key)
		.pipe(runPromise)
		.catch(() => undefined);
	return Response.json({ ok: true });
}
