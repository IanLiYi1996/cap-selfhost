import { getCurrentUser } from "@cap/database/auth/session";
import type { Video } from "@cap/web-domain";
import type { NextRequest } from "next/server";
import { runPromise } from "@/lib/server";
import {
	loadMaterialPages,
	loadMaterialsAccess,
} from "@/lib/video-materials/materials";

export const dynamic = "force-dynamic";

/** A material page by page, with signed URLs for the page images. */
export async function GET(
	_request: NextRequest,
	props: RouteContext<"/api/videos/[videoId]/materials/[materialId]/text">,
) {
	const user = await getCurrentUser();
	if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const { videoId, materialId } = (await props.params) as {
		videoId: Video.VideoId;
		materialId: string;
	};
	const access = await loadMaterialsAccess(videoId, user.id);
	if (access.status !== "ok") {
		return Response.json({ error: "Video not found." }, { status: 404 });
	}
	const loaded = await loadMaterialPages(
		access.bucket,
		access.video,
		materialId,
	);
	if (!loaded) {
		return Response.json({ error: "Material not found." }, { status: 404 });
	}
	const pages = await Promise.all(
		loaded.pages.map(async (page) => ({
			n: page.n,
			label: page.label,
			text: page.text,
			outline: page.outline,
			imageUrl: page.imageKey
				? await access.bucket
						.getSignedObjectUrl(page.imageKey)
						.pipe(runPromise)
						.catch(() => null)
				: null,
		})),
	);
	return Response.json({ pages }, { headers: { "Cache-Control": "no-store" } });
}
