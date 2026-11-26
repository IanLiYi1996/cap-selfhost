import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import type { Video } from "@cap/web-domain";
import type { NextRequest } from "next/server";
import {
	deleteMaterial,
	loadMaterialsAccess,
	materialDownloadUrl,
} from "@/lib/video-materials/materials";

export const dynamic = "force-dynamic";

type Props = RouteContext<"/api/videos/[videoId]/materials/[materialId]">;

export async function GET(_request: NextRequest, props: Props) {
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
	const url = await materialDownloadUrl(
		access.bucket,
		access.video,
		materialId,
	);
	if (!url)
		return Response.json({ error: "Material not found." }, { status: 404 });
	return new Response(null, {
		status: 302,
		headers: { Location: url, "Cache-Control": "no-store" },
	});
}

export async function DELETE(request: NextRequest, props: Props) {
	const user = isCrossSiteCookieWrite(request) ? null : await getCurrentUser();
	if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const { videoId, materialId } = (await props.params) as {
		videoId: Video.VideoId;
		materialId: string;
	};
	const access = await loadMaterialsAccess(videoId, user.id);
	if (access.status !== "ok") {
		return Response.json({ error: "Video not found." }, { status: 404 });
	}
	if (!access.canManage) {
		return Response.json(
			{
				error:
					"Only the owner and members of its organization can remove materials.",
			},
			{ status: 403 },
		);
	}
	const removed = await deleteMaterial(access.bucket, access.video, materialId);
	return removed
		? Response.json({ ok: true })
		: Response.json({ error: "Material not found." }, { status: 404 });
}
