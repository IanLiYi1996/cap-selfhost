import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import type { Video } from "@cap/web-domain";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { runWithAiProviders } from "@/lib/ai/run";
import { queueKnowledgeIndex } from "@/lib/knowledge/queue";
import { fetchStorageUrl } from "@/lib/storage-fetch";
import {
	type MaterialEntry,
	materialFileKey,
	materialsManifestKey,
	materialTextKey,
	parseMaterialsManifest,
} from "@/lib/video-materials/manifest";
import {
	PAGE_NOTES_INSTRUCTIONS,
	pagePromptText,
	parseNotesResponse,
	planNoteBatches,
} from "@/lib/video-materials/notes";
import {
	composePages,
	contentToText,
	type MaterialPage,
	materialContentKey,
	type PageNote,
	pageImagesPrefix,
	pageLabel,
	pagesFromText,
	pagesIndexKey,
	parsePagesIndex,
	RENDERED_KINDS,
} from "@/lib/video-materials/pages";
import { readText, updateJsonObject } from "@/lib/video-materials/storage";
import { decodeStorageVideo } from "@/lib/video-storage";
import { startWhisperTask } from "@/lib/whisper";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

interface MaterialProcessingPayload {
	videoId: string;
	materialId: string;
}

type Rendered =
	| { status: "ready"; pages: number[] }
	| { status: "skipped" | "failed"; reason: string }
	| { status: "gone" };

const POLL_INTERVAL_MS = 5_000;
const RENDER_POLLS = 180;
const DESCRIBE_TIMEOUT_MS = 3 * 60 * 1000;
const DESCRIBE_MAX_OUTPUT_TOKENS = 8_000;

/**
 * After upload: render the material's pages to images, have the generation
 * model write notes on each page (figures, tables, scans), and store the
 * combined page-by-page content Q&A reads. The text extracted at upload stays
 * in use until this finishes, and if any step fails.
 */
export async function materialProcessingWorkflow(
	payload: MaterialProcessingPayload,
) {
	"use workflow";

	const { videoId, materialId } = payload;
	const rendered = await renderMaterialPages(videoId, materialId);
	if (rendered.status === "gone") {
		return { success: false, message: "Material was removed" };
	}

	const notes: PageNote[] = [];
	if (rendered.status === "ready") {
		for (const batch of planNoteBatches(rendered.pages)) {
			notes.push(...(await describeMaterialPages(videoId, materialId, batch)));
		}
	}

	return await finishMaterial(videoId, materialId, rendered.status, notes);
}

async function loadTarget(videoId: string, materialId: string) {
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);
	if (!video) return null;
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	const read = (key: string) => readText(bucket, key);
	const material = parseMaterialsManifest(
		await read(materialsManifestKey(video.ownerId, video.id)),
	).materials.find((m) => m.id === materialId);
	return material ? { video, bucket, material, read } : null;
}

const wait = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

async function renderMaterialPages(
	videoId: string,
	materialId: string,
): Promise<Rendered> {
	"use step";

	const target = await loadTarget(videoId, materialId);
	if (!target) return { status: "gone" };
	const { video, material, read } = target;
	if (!RENDERED_KINDS.has(material.kind)) {
		return { status: "skipped", reason: `${material.kind} has no pages` };
	}
	const env = serverEnv();
	if (!env.WHISPER_CLUSTER_ARN || !env.WHISPER_TASK_DEFINITION_ARN) {
		return { status: "skipped", reason: "No render task configured" };
	}

	const indexKey = pagesIndexKey(video.ownerId, video.id, material.id);
	let index = parsePagesIndex(await read(indexKey));
	if (!index) {
		await startWhisperTask({
			bucket: env.CAP_AWS_BUCKET,
			inputKey: materialFileKey(
				video.ownerId,
				video.id,
				material.id,
				material.name,
			),
			outputKey: indexKey,
			environment: {
				TASK_MODE: "render-pages",
				PAGES_PREFIX: pageImagesPrefix(video.ownerId, video.id, material.id),
			},
		});
		for (let attempt = 0; attempt < RENDER_POLLS && !index; attempt += 1) {
			await wait(POLL_INTERVAL_MS);
			index = parsePagesIndex(await read(indexKey));
		}
		if (!index) {
			return { status: "failed", reason: "Render task produced no pages" };
		}
	}

	console.log(
		`[materials] ${videoId}/${materialId}: rendered ${index.pages.length} of ${index.pageCount} pages`,
	);
	return { status: "ready", pages: index.pages.map((page) => page.n) };
}

async function describeMaterialPages(
	videoId: string,
	materialId: string,
	batch: number[],
): Promise<PageNote[]> {
	"use step";

	const target = await loadTarget(videoId, materialId);
	if (!target) return [];
	const { video, bucket, material, read } = target;
	const index = parsePagesIndex(
		await read(pagesIndexKey(video.ownerId, video.id, material.id)),
	);
	const pages = (index?.pages ?? []).filter((page) => batch.includes(page.n));

	const content = (
		await Promise.all(
			pages.map(async (page) => {
				const url = await bucket
					.getInternalSignedObjectUrl(page.key)
					.pipe(runWorkflowPromise);
				const response = await fetchStorageUrl(url);
				if (!response.ok) return [];
				return [
					{
						type: "text" as const,
						text: pagePromptText(
							material.name,
							`${pageLabel(material.kind, page.n)} (page ${page.n})`,
							page.text,
						),
					},
					{
						type: "image" as const,
						image: new Uint8Array(await response.arrayBuffer()),
						mediaType: "image/jpeg",
					},
				];
			}),
		)
	).flat();
	if (content.length === 0) return [];

	try {
		const text = await runWithAiProviders("generation", async (selection) => {
			const result = await generateText({
				model: selection.model(),
				instructions: PAGE_NOTES_INSTRUCTIONS,
				messages: [{ role: "user", content }],
				maxOutputTokens: DESCRIBE_MAX_OUTPUT_TOKENS,
				abortSignal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
			});
			return result.text;
		});
		return parseNotesResponse(text, batch);
	} catch (error) {
		// The pages still have their text layer; only these notes are missing.
		console.error(
			`[materials] ${videoId}/${materialId}: notes for pages ${batch[0]}-${batch.at(-1)} failed`,
			error,
		);
		return [];
	}
}

async function finishMaterial(
	videoId: string,
	materialId: string,
	rendered: Exclude<Rendered["status"], "gone">,
	notes: PageNote[],
) {
	"use step";

	const target = await loadTarget(videoId, materialId);
	if (!target) return { success: false, message: "Material was removed" };
	const { video, bucket, material, read } = target;
	const { ownerId } = video;

	let pages: MaterialPage[];
	const index =
		rendered === "ready"
			? parsePagesIndex(
					await read(pagesIndexKey(ownerId, video.id, material.id)),
				)
			: null;
	if (index) {
		pages = composePages(material.kind, index, notes);
	} else {
		pages = pagesFromText(
			material.kind,
			(await read(materialTextKey(ownerId, video.id, material.id))) ?? "",
		);
	}
	const text = contentToText(pages);

	await bucket
		.putObject(
			materialContentKey(ownerId, video.id, material.id),
			JSON.stringify({ version: 1, pages }),
			{ contentType: "application/json" },
		)
		.pipe(runWorkflowPromise);
	await bucket
		.putObject(materialTextKey(ownerId, video.id, material.id), text, {
			contentType: "text/plain; charset=utf-8",
		})
		.pipe(runWorkflowPromise);

	const status: MaterialEntry["status"] = text.trim() ? "ready" : "failed";
	await updateJsonObject<null>(
		bucket,
		materialsManifestKey(ownerId, video.id),
		(raw) => {
			const manifest = parseMaterialsManifest(raw);
			if (!manifest.materials.some((m) => m.id === material.id)) {
				return { abort: null };
			}
			const changes = {
				status,
				pageCount: pages.length,
				hasImages: Boolean(index),
				textChars: text.length,
			};
			return {
				next: {
					...manifest,
					materials: manifest.materials.map((m) =>
						m.id === material.id ? { ...m, ...changes } : m,
					),
				},
				result: null,
			};
		},
	);
	console.log(
		`[materials] ${videoId}/${materialId}: ${status}, ${pages.length} pages, ${notes.length} notes, ${text.length} chars`,
	);
	await queueKnowledgeIndex(videoId);
	return { success: status === "ready", message: `${pages.length} pages` };
}
