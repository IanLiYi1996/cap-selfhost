import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { organizationMembers, users, type videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import type { User, Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { runPromise } from "@/lib/server";
import { loadViewableVideo } from "@/lib/video-qa/access";
import { decodeStorageVideo } from "@/lib/video-storage";
import type { LoadedMaterial } from "./context";
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
import {
	type MaterialPage,
	materialContentKey,
	pagesFromText,
	parseMaterialContent,
	RENDERED_KINDS,
} from "./pages";
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
	const rendered = RENDERED_KINDS.has(kind);
	// A scan has no text layer; its pages are read off their images later.
	if (!text.trim() && !rendered) {
		return {
			ok: false,
			status: 422,
			error: `${file.name} has no text to read.`,
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
		status: rendered ? "processing" : "ready",
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

	await deleteMaterialObjects(bucket, video, removed.id).catch((error) =>
		console.warn(
			`[materials] ${video.id}: cleanup of ${removed.id} failed`,
			error,
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

export async function uploaderNames(
	materials: readonly MaterialEntry[],
): Promise<Map<string, string>> {
	const ids = [...new Set(materials.map((m) => m.uploadedBy))];
	if (ids.length === 0) return new Map();
	const rows = await db()
		.select({ id: users.id, name: users.name, email: users.email })
		.from(users)
		.where(inArray(users.id, ids as User.UserId[]));
	return new Map(rows.map((row) => [row.id, row.name || row.email]));
}

/** The original, its text, page images and notes: everything under the
 * material's folder. */
async function deleteMaterialObjects(
	bucket: Bucket,
	video: VideoRow,
	materialId: string,
) {
	const prefix = `${video.ownerId}/${video.id}/materials/${materialId}/`;
	let continuationToken: string | undefined;
	do {
		const listed = await bucket
			.listObjects({ prefix, continuationToken })
			.pipe(runPromise);
		const keys = (listed.Contents ?? []).flatMap((object) =>
			object.Key ? [{ Key: object.Key }] : [],
		);
		if (keys.length > 0) await bucket.deleteObjects(keys).pipe(runPromise);
		continuationToken = listed.IsTruncated
			? listed.NextContinuationToken
			: undefined;
	} while (continuationToken);
}

async function pagesOf(
	bucket: Bucket,
	video: VideoRow,
	material: MaterialEntry,
): Promise<MaterialPage[]> {
	const content = parseMaterialContent(
		await readText(
			bucket,
			materialContentKey(video.ownerId, video.id, material.id),
		),
	);
	if (content) return content;
	const text =
		(await readText(
			bucket,
			materialTextKey(video.ownerId, video.id, material.id),
		)) ?? "";
	return pagesFromText(material.kind, text);
}

/** Every material page by page, as the Q&A model reads them. */
export async function loadMaterials(
	bucket: Bucket,
	video: VideoRow,
): Promise<LoadedMaterial[]> {
	const materials = await listMaterials(bucket, video);
	return Promise.all(
		materials.map(async (material) => ({
			id: material.id,
			name: material.name,
			kind: material.kind,
			pages: await pagesOf(bucket, video, material),
			processing: material.status === "processing",
		})),
	);
}

export async function loadMaterialPages(
	bucket: Bucket,
	video: VideoRow,
	materialId: string,
): Promise<{ material: MaterialEntry; pages: MaterialPage[] } | null> {
	const material = (await listMaterials(bucket, video)).find(
		(m) => m.id === materialId,
	);
	if (!material) return null;
	return { material, pages: await pagesOf(bucket, video, material) };
}
