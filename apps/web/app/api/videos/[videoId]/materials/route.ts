import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import type { Video } from "@cap/web-domain";
import type { NextRequest } from "next/server";
import {
	listMaterials,
	loadMaterialsAccess,
	uploadMaterial,
} from "@/lib/video-materials/materials";

export const dynamic = "force-dynamic";

const MAX_FILES_PER_REQUEST = 10;

export async function GET(
	_request: NextRequest,
	props: RouteContext<"/api/videos/[videoId]/materials">,
) {
	const user = await getCurrentUser();
	if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const { videoId } = (await props.params) as { videoId: Video.VideoId };
	const access = await loadMaterialsAccess(videoId, user.id);
	if (access.status !== "ok") {
		return Response.json({ error: "Video not found." }, { status: 404 });
	}
	const materials = await listMaterials(access.bucket, access.video);
	return Response.json(
		{
			canManage: access.canManage,
			materials: materials.map(({ id, name, kind, size, uploadedAt }) => ({
				id,
				name,
				kind,
				size,
				uploadedAt,
			})),
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}

export async function POST(
	request: NextRequest,
	props: RouteContext<"/api/videos/[videoId]/materials">,
) {
	const user = isCrossSiteCookieWrite(request) ? null : await getCurrentUser();
	if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const { videoId } = (await props.params) as { videoId: Video.VideoId };
	const access = await loadMaterialsAccess(videoId, user.id);
	if (access.status !== "ok") {
		return Response.json({ error: "Video not found." }, { status: 404 });
	}
	if (!access.canManage) {
		return Response.json(
			{
				error:
					"Only the owner and members of its organization can add materials.",
			},
			{ status: 403 },
		);
	}

	let files: File[];
	try {
		files = (await request.formData())
			.getAll("file")
			.filter((value): value is File => value instanceof File);
	} catch {
		return Response.json(
			{ error: "Expected a multipart upload." },
			{ status: 400 },
		);
	}
	if (files.length === 0 || files.length > MAX_FILES_PER_REQUEST) {
		return Response.json(
			{ error: `Upload 1 to ${MAX_FILES_PER_REQUEST} files at a time.` },
			{ status: 400 },
		);
	}

	const results = [];
	for (const file of files) {
		const outcome = await uploadMaterial(
			access.bucket,
			access.video,
			user.id,
			file,
		);
		results.push(
			outcome.ok
				? { name: file.name, ok: true as const, id: outcome.material.id }
				: { name: file.name, ok: false as const, error: outcome.error },
		);
	}
	const anyFailed = results.some((result) => !result.ok);
	return Response.json({ results }, { status: anyFailed ? 207 : 201 });
}
