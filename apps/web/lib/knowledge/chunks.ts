import { createHash } from "node:crypto";
import { formatPlayerTime } from "@/lib/player-time";
import type { LoadedMaterial } from "@/lib/video-materials/context";
import type { FramesIndex, TimelineSegment } from "@/lib/video-qa/artifacts";
import type { TranscriptCue } from "@/lib/video-qa/transcript";

/**
 * A meeting cut into the pieces the knowledge index stores: transcript
 * passages, screen segments and keyframes, the summary and its chapters, and
 * material pages with their images. Each has a stable key, so re-indexing
 * overwrites instead of duplicating.
 */

export type KnowledgeKind =
	| "transcript"
	| "visual"
	| "frame"
	| "summary"
	| "chapter"
	| "material"
	| "page";

export const KNOWLEDGE_KINDS: readonly KnowledgeKind[] = [
	"transcript",
	"visual",
	"frame",
	"summary",
	"chapter",
	"material",
	"page",
];

export type KnowledgeChunk = {
	key: string;
	kind: KnowledgeKind;
	/** What the full-text search matches, and what results show. */
	text: string;
	/** Text that is embedded; empty for image chunks. */
	embedText: string;
	/** Storage key of the image that is embedded instead of text. */
	imageKey: string | null;
	label: string;
	start: number | null;
	end: number | null;
	materialId: string | null;
	materialName: string | null;
	page: number | null;
};

export const TRANSCRIPT_CHUNK_CHARS = 800;
export const TRANSCRIPT_CHUNK_SECONDS = 90;
export const MATERIAL_CHUNK_CHARS = 1_500;
export const STORED_TEXT_CHARS = 8_000;

const clip = (text: string, max = STORED_TEXT_CHARS) =>
	text.length > max ? text.slice(0, max) : text;

const span = (start: number, end: number) =>
	`${formatPlayerTime(start)}-${formatPlayerTime(end)}`;

const base = {
	imageKey: null,
	materialId: null,
	materialName: null,
	page: null,
};

export function transcriptChunks(
	videoId: string,
	cues: readonly TranscriptCue[],
): KnowledgeChunk[] {
	const chunks: KnowledgeChunk[] = [];
	let group: TranscriptCue[] = [];
	let chars = 0;
	const flush = () => {
		const first = group[0];
		const last = group.at(-1);
		if (!first || !last) return;
		const text = group.map((cue) => cue.text).join(" ");
		chunks.push({
			...base,
			key: `${videoId}:transcript:${Math.round(first.start * 1000)}`,
			kind: "transcript",
			text: clip(text),
			embedText: text,
			label: span(first.start, last.end),
			start: first.start,
			end: last.end,
		});
		group = [];
		chars = 0;
	};
	for (const cue of cues) {
		const first = group[0];
		if (
			first &&
			(chars + cue.text.length > TRANSCRIPT_CHUNK_CHARS ||
				cue.end - first.start > TRANSCRIPT_CHUNK_SECONDS)
		) {
			flush();
		}
		group.push(cue);
		chars += cue.text.length;
	}
	flush();
	return chunks;
}

const segmentText = (segment: TimelineSegment) =>
	[segment.description, ...segment.screenText].join("\n");

export function visualChunks(
	videoId: string,
	segments: readonly TimelineSegment[],
): KnowledgeChunk[] {
	return segments.map((segment) => {
		const text = segmentText(segment);
		return {
			...base,
			key: `${videoId}:visual:${Math.round(segment.start * 1000)}`,
			kind: "visual",
			text: clip(text),
			embedText: text,
			label: span(segment.start, segment.end),
			start: segment.start,
			end: segment.end,
		};
	});
}

/** Keyframes are embedded as images; their text is the screen segment they
 * fall in, so keyword search finds them too. */
export function frameChunks(
	videoId: string,
	frames: FramesIndex | null,
	segments: readonly TimelineSegment[],
): KnowledgeChunk[] {
	return (frames?.frames ?? [])
		.filter((frame) => frame.keyframe)
		.map((frame) => {
			const segment = segments.find(
				(s) => s.start <= frame.t && frame.t < s.end,
			);
			return {
				...base,
				key: `${videoId}:frame:${Math.round(frame.t * 1000)}`,
				kind: "frame",
				text: clip(segment ? segmentText(segment) : ""),
				embedText: "",
				imageKey: frame.key,
				label: formatPlayerTime(frame.t),
				start: frame.t,
				end: frame.t,
			};
		});
}

export function summaryChunks(
	videoId: string,
	title: string,
	summary: string | null | undefined,
	chapters: readonly { title: string; start: number }[] | null | undefined,
): KnowledgeChunk[] {
	const chunks: KnowledgeChunk[] = [];
	if (summary?.trim()) {
		const text = `${title}\n${summary.trim()}`;
		chunks.push({
			...base,
			key: `${videoId}:summary:0`,
			kind: "summary",
			text: clip(text),
			embedText: text,
			label: "Summary",
			start: null,
			end: null,
		});
	}
	const sorted = [...(chapters ?? [])].sort((a, b) => a.start - b.start);
	sorted.forEach((chapter, index) => {
		const next = sorted[index + 1];
		chunks.push({
			...base,
			key: `${videoId}:chapter:${Math.round(chapter.start * 1000)}`,
			kind: "chapter",
			text: chapter.title,
			embedText: `${title}: ${chapter.title}`,
			label: formatPlayerTime(chapter.start),
			start: chapter.start,
			end: next?.start ?? null,
		});
	});
	return chunks;
}

function splitText(text: string, max: number): string[] {
	if (text.length <= max) return [text];
	const parts: string[] = [];
	let rest = text;
	while (rest.length > max) {
		const window = rest.slice(0, max);
		const cut = Math.max(
			window.lastIndexOf("\n"),
			window.lastIndexOf("。"),
			window.lastIndexOf(". "),
		);
		const at = cut > max / 2 ? cut + 1 : max;
		parts.push(rest.slice(0, at).trim());
		rest = rest.slice(at);
	}
	if (rest.trim()) parts.push(rest.trim());
	return parts;
}

export function materialChunks(
	videoId: string,
	materials: readonly LoadedMaterial[],
): KnowledgeChunk[] {
	return materials.flatMap((material) =>
		material.pages.flatMap((page) => {
			const located = {
				...base,
				materialId: material.id,
				materialName: material.name,
				page: page.n,
				label: page.label,
				start: null,
				end: null,
			};
			const texts = page.text.trim()
				? splitText(page.text.trim(), MATERIAL_CHUNK_CHARS)
				: [];
			const textChunks = texts.map(
				(text, part): KnowledgeChunk => ({
					...located,
					key: `${videoId}:material:${material.id}:${page.n}:${part}`,
					kind: "material",
					text: clip(text),
					embedText: `${material.name} · ${page.label}\n${text}`,
				}),
			);
			const imageChunk: KnowledgeChunk[] = page.imageKey
				? [
						{
							...located,
							key: `${videoId}:page:${material.id}:${page.n}`,
							kind: "page",
							text: clip(
								`${page.outline}\n${page.text}`.trim(),
								MATERIAL_CHUNK_CHARS,
							),
							embedText: "",
							imageKey: page.imageKey,
						},
					]
				: [];
			return [...textChunks, ...imageChunk];
		}),
	);
}

/** Everything a stored vector depends on, so a changed chunk is re-embedded
 * and an unchanged one is not. */
export function chunkHash(chunk: KnowledgeChunk, orgId: string): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				orgId,
				chunk.kind,
				chunk.embedText,
				chunk.imageKey,
				chunk.text,
				chunk.label,
				chunk.start,
				chunk.end,
				chunk.materialName,
			]),
		)
		.digest("base64url")
		.slice(0, 22);
}

export type IndexManifest = { version: 1; chunks: Record<string, string> };

export function parseIndexManifest(raw: string | null): IndexManifest {
	if (!raw) return { version: 1, chunks: {} };
	try {
		const value = JSON.parse(raw) as { chunks?: unknown };
		if (!value.chunks || typeof value.chunks !== "object") {
			return { version: 1, chunks: {} };
		}
		return {
			version: 1,
			chunks: Object.fromEntries(
				Object.entries(value.chunks as Record<string, unknown>).filter(
					(entry): entry is [string, string] => typeof entry[1] === "string",
				),
			),
		};
	} catch {
		return { version: 1, chunks: {} };
	}
}

export function planIndexUpdate(
	previous: IndexManifest,
	chunks: readonly KnowledgeChunk[],
	orgId: string,
) {
	const next: Record<string, string> = {};
	const upsert: KnowledgeChunk[] = [];
	for (const chunk of chunks) {
		const hash = chunkHash(chunk, orgId);
		next[chunk.key] = hash;
		if (previous.chunks[chunk.key] !== hash) upsert.push(chunk);
	}
	const remove = Object.keys(previous.chunks).filter((key) => !(key in next));
	return { upsert, remove, manifest: { version: 1 as const, chunks: next } };
}

export const knowledgeManifestKey = (ownerId: string, videoId: string) =>
	`${ownerId}/${videoId}/knowledge.v1.json`;
