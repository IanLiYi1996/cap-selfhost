import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { organizationMembers, type videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import type { User, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { runPromise } from "@/lib/server";
import { loadViewableVideo } from "@/lib/video-qa/access";
import { decodeStorageVideo } from "@/lib/video-storage";
import { extractMaterialText, materialKind } from "./extract";
import {
	addMaterial,
	MAX_MATERIAL_BYTES,
	MAX_MATERIAL_TEXT_CHARS,
	MAX_MATERIALS,
	type MaterialEntry,
	materialFileKey,
	materialsManifestKey,
	materialTextKey,
	parseMaterialsManifest,
	removeMaterial,
} from "./manifest";
import { type Bucket, readText, updateJsonObject } from "./storage";

type VideoRow = typeof videos.$inferSelect;

export type MaterialsAccess =
	| { status: "ok"; video: VideoRow; bucket: Bucket; canManage: boolean }
	| { status: "not_found" };

/**
 * Anyone who can view the video can read its materials (and Q&A uses them);
 * the owner and members of the video's organisation can add and remove them.
 */
export async function loadMaterialsAccess(
	videoId: Video.VideoId,
	userId: User.UserId,
): Promise<MaterialsAccess> {
	const video = await loadViewableVideo(videoId);
	if (!video || video.isScreenshot) return { status: "not_found" };

	let canManage = video.ownerId === userId;
	if (!canManage) {
		const [membership] = await db()
			.select({ id: organizationMembers.id })
			.from(organizationMembers)
			.where(
				and(
					eq(organizationMembers.organizationId, video.orgId),
					eq(organizationMembers.userId, userId),
				),
			)
			.limit(1);
		canManage = Boolean(membership);
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);
	return { status: "ok", video, bucket, canManage };
}

export async function listMaterials(bucket: Bucket, video: VideoRow) {
	return parseMaterialsManifest(
		await readText(bucket, materialsManifestKey(video.ownerId, video.id)),
	).materials;
}

export type UploadOutcome =
	| { ok: true; material: MaterialEntry }
	| {
			ok: false;
			status: number;
			error: string;
	  };

export async function uploadMaterial(
	bucket: Bucket,
	video: VideoRow,
	userId: string,
	file: File,
): Promise<UploadOutcome> {
	const kind = materialKind(file.name);
	if (!kind) {
		return {
			ok: false,
			status: 415,
			error: `${file.name}: only PDF, Word, PowerPoint, Excel, HTML, Markdown, text, CSV and JSON files are supported.`,
		};
	}
	if (file.size > MAX_MATERIAL_BYTES) {
		return {
			ok: false,
			status: 413,
			error: `${file.name} is larger than ${MAX_MATERIAL_BYTES / 1024 / 1024} MB.`,
		};
	}

	const bytes = new Uint8Array(await file.arrayBuffer());
	let text: string;
	try {
		text = await extractMaterialText(file.name, bytes);
	} catch (error) {
		console.error(
			`[materials] ${video.id}: could not read ${file.name}`,
			error,
		);
		return {
			ok: false,
			status: 422,
			error: `${file.name} could not be read. Is it a valid, unencrypted file?`,
		};
	}
	if (!text.trim()) {
		return {
			ok: false,
			status: 422,
			error: `${file.name} has no text to read (a scanned PDF or an image-only document?).`,
		};
	}

	const material: MaterialEntry = {
		id: randomUUID(),
		name: file.name,
		kind,
		size: file.size,
		uploadedAt: new Date().toISOString(),
		uploadedBy: userId,
		textChars: text.length,
	};
	const { ownerId, id: videoId } = video;

	// Stored first and referenced last: a failed upload leaves only unreferenced
	// objects, never a manifest entry without its text.
	await bucket
		.putObject(
			materialFileKey(ownerId, videoId, material.id, file.name),
			bytes,
			{
				contentType: file.type || "application/octet-stream",
			},
		)
		.pipe(runPromise);
	await bucket
		.putObject(materialTextKey(ownerId, videoId, material.id), text, {
			contentType: "text/plain; charset=utf-8",
		})
		.pipe(runPromise);

	const added = await updateJsonObject<
		{ ok: true } | { ok: false; reason: "too_many" | "too_much_text" }
	>(bucket, materialsManifestKey(ownerId, videoId), (raw) => {
		const result = addMaterial(parseMaterialsManifest(raw), material);
		return result.ok
			? { next: result.manifest, result: { ok: true as const } }
			: { abort: result };
	});
	if (!added.ok) {
		return {
			ok: false,
			status: 409,
			error:
				added.reason === "too_many"
					? `A video can have at most ${MAX_MATERIALS} materials.`
					: `Materials for one video can hold about ${MAX_MATERIAL_TEXT_CHARS.toLocaleString("en")} characters of text in total; ${file.name} would go over that.`,
		};
	}
	return { ok: true, material };
}

export async function deleteMaterial(
	bucket: Bucket,
	video: VideoRow,
	materialId: string,
): Promise<boolean> {
	const removed = await updateJsonObject<MaterialEntry | null>(
		bucket,
		materialsManifestKey(video.ownerId, video.id),
		(raw) => {
			const result = removeMaterial(parseMaterialsManifest(raw), materialId);
			return result.removed
				? { next: result.manifest, result: result.removed }
				: { abort: null };
		},
	);
	if (!removed) return false;

	await Promise.all(
		[
			materialFileKey(video.ownerId, video.id, removed.id, removed.name),
			materialTextKey(video.ownerId, video.id, removed.id),
		].map((key) =>
			bucket
				.deleteObject(key)
				.pipe(runPromise)
				.catch(() => undefined),
		),
	);
	return true;
}

export async function materialDownloadUrl(
	bucket: Bucket,
	video: VideoRow,
	materialId: string,
): Promise<string | null> {
	const material = (await listMaterials(bucket, video)).find(
		(m) => m.id === materialId,
	);
	if (!material) return null;
	// Always as an attachment: an uploaded HTML file must download, not render.
	return bucket
		.getSignedDownloadUrl(
			materialFileKey(video.ownerId, video.id, material.id, material.name),
			material.name,
		)
		.pipe(runPromise);
}

export type MaterialText = { name: string; text: string };

export async function loadMaterialTexts(
	bucket: Bucket,
	video: VideoRow,
): Promise<MaterialText[]> {
	const materials = await listMaterials(bucket, video);
	const texts = await Promise.all(
		materials.map(async (material) => ({
			name: material.name,
			text:
				(await readText(
					bucket,
					materialTextKey(video.ownerId, video.id, material.id),
				)) ?? "",
		})),
	);
	return texts.filter((material) => material.text.trim());
}
