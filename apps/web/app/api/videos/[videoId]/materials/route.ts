import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import type { Video } from "@cap/web-domain";
import type { NextRequest } from "next/server";
import { start } from "workflow/api";
import { queueKnowledgeIndex } from "@/lib/knowledge/queue";
import {
	listMaterials,
	loadMaterialsAccess,
	uploaderNames,
	uploadMaterial,
} from "@/lib/video-materials/materials";
import { materialProcessingWorkflow } from "@/workflows/material-processing";

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
	const names = await uploaderNames(materials);
	return Response.json(
		{
			canManage: access.canManage,
			materials: materials.map((material) => ({
				id: material.id,
				name: material.name,
				kind: material.kind,
				size: material.size,
				uploadedAt: material.uploadedAt,
				uploadedBy: names.get(material.uploadedBy) ?? null,
				textChars: material.textChars,
				status: material.status ?? "ready",
				pageCount: material.pageCount ?? null,
				hasImages: material.hasImages ?? false,
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
		if (outcome.ok && outcome.material.status === "processing") {
			await start(materialProcessingWorkflow, [
				{ videoId: access.video.id, materialId: outcome.material.id },
			]).catch((error) =>
				console.error(
					`[materials] ${access.video.id}: could not start processing ${outcome.material.id}`,
					error,
				),
			);
		}
		results.push(
			outcome.ok
				? { name: file.name, ok: true as const, id: outcome.material.id }
				: { name: file.name, ok: false as const, error: outcome.error },
		);
	}
	// Materials still being processed queue indexing when they finish.
	if (results.some((result) => result.ok)) {
		await queueKnowledgeIndex(access.video.id);
	}
	const anyFailed = results.some((result) => !result.ok);
	return Response.json({ results }, { status: anyFailed ? 207 : 201 });
}
