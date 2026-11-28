import type { MaterialKind } from "./extract";

/**
 * A material page by page: the render task's text and image for each page,
 * the model's notes on it, and the combined content Q&A reads.
 */

export type RenderedPage = {
	n: number;
	key: string;
	width: number;
	height: number;
	text: string;
};

export type PagesIndex = { pageCount: number; pages: RenderedPage[] };

export type PageNote = {
	n: number;
	outline: string;
	visual: string;
	/** Text read off the image, for pages without a text layer. */
	text: string;
};

export type MaterialPage = {
	n: number;
	label: string;
	text: string;
	outline: string;
	imageKey: string | null;
};

export type MaterialContent = { version: 1; pages: MaterialPage[] };

const base = (ownerId: string, videoId: string, id: string) =>
	`${ownerId}/${videoId}/materials/${id}`;

export const pagesIndexKey = (o: string, v: string, id: string) =>
	`${base(o, v, id)}/pages.v1.json`;
export const pageImagesPrefix = (o: string, v: string, id: string) =>
	`${base(o, v, id)}/pages/`;
export const pageNotesKey = (o: string, v: string, id: string) =>
	`${base(o, v, id)}/notes.v1.json`;
export const materialContentKey = (o: string, v: string, id: string) =>
	`${base(o, v, id)}/content.v1.json`;

/** Kinds the render task turns into page images. */
export const RENDERED_KINDS = new Set<MaterialKind>([
	"pdf",
	"docx",
	"pptx",
	"xlsx",
]);

export const MAX_DESCRIBED_PAGES = 300;

export const pageLabel = (kind: MaterialKind, n: number) =>
	kind === "pptx" ? `Slide ${n}` : `Page ${n}`;

const asString = (value: unknown) => (typeof value === "string" ? value : "");

export function parsePagesIndex(raw: string | null): PagesIndex | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as { pageCount?: unknown; pages?: unknown };
		if (!Array.isArray(value.pages)) return null;
		const pages = value.pages.flatMap((page): RenderedPage[] => {
			if (!page || typeof page !== "object") return [];
			const { n, key, width, height, text } = page as Record<string, unknown>;
			if (typeof n !== "number" || typeof key !== "string") return [];
			return [
				{
					n,
					key,
					width: typeof width === "number" ? width : 0,
					height: typeof height === "number" ? height : 0,
					text: asString(text),
				},
			];
		});
		return {
			pageCount:
				typeof value.pageCount === "number" ? value.pageCount : pages.length,
			pages: pages.sort((a, b) => a.n - b.n),
		};
	} catch {
		return null;
	}
}

export function parsePageNotes(raw: string | null): PageNote[] {
	if (!raw) return [];
	try {
		const value = JSON.parse(raw) as { pages?: unknown };
		if (!Array.isArray(value.pages)) return [];
		return value.pages.flatMap((note): PageNote[] => {
			if (!note || typeof note !== "object") return [];
			const record = note as Record<string, unknown>;
			const n = typeof record.n === "number" ? record.n : Number(record.page);
			if (!Number.isInteger(n) || n < 1) return [];
			return [
				{
					n,
					outline: asString(record.outline).trim(),
					visual: asString(record.visual).trim(),
					text: asString(record.text).trim(),
				},
			];
		});
	} catch {
		return [];
	}
}

/** Pages from the upload-time text, which marks pages and slides itself. */
export function pagesFromText(
	kind: MaterialKind,
	text: string,
): MaterialPage[] {
	const marker = /^\[(Page|Slide|Sheet) ([^\]]+)\]$/gm;
	const matches = [...text.matchAll(marker)];
	if (matches.length === 0) {
		const trimmed = text.trim();
		return trimmed
			? [
					{
						n: 1,
						label: kind === "html" || kind === "text" ? "Document" : "Page 1",
						text: trimmed,
						outline: "",
						imageKey: null,
					},
				]
			: [];
	}
	return matches.map((match, index) => {
		const start = (match.index ?? 0) + match[0].length;
		const end = matches[index + 1]?.index ?? text.length;
		return {
			n: index + 1,
			label: `${match[1]} ${match[2]}`,
			text: text.slice(start, end).trim(),
			outline: "",
			imageKey: null,
		};
	});
}

/** Rendered pages with the model's notes folded in. */
export function composePages(
	kind: MaterialKind,
	index: PagesIndex,
	notes: readonly PageNote[],
): MaterialPage[] {
	const byPage = new Map(notes.map((note) => [note.n, note]));
	return index.pages.map((page) => {
		const note = byPage.get(page.n);
		const body = page.text.trim() || note?.text || "";
		const visual = note?.visual ? `\n[Figures] ${note.visual}` : "";
		return {
			n: page.n,
			label: pageLabel(kind, page.n),
			text: `${body}${visual}`.trim(),
			outline: note?.outline ?? "",
			imageKey: page.key,
		};
	});
}

export function contentToText(pages: readonly MaterialPage[]): string {
	return pages
		.filter((page) => page.text)
		.map((page) => `[${page.label}]\n${page.text}`)
		.join("\n\n");
}

export function parseMaterialContent(
	raw: string | null,
): MaterialPage[] | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as { pages?: unknown };
		if (!Array.isArray(value.pages)) return null;
		return value.pages.flatMap((page): MaterialPage[] => {
			if (!page || typeof page !== "object") return [];
			const record = page as Record<string, unknown>;
			if (typeof record.n !== "number") return [];
			return [
				{
					n: record.n,
					label: asString(record.label) || `Page ${record.n}`,
					text: asString(record.text),
					outline: asString(record.outline),
					imageKey:
						typeof record.imageKey === "string" ? record.imageKey : null,
				},
			];
		});
	} catch {
		return null;
	}
}

/** One line per page for the materials directory: the model's outline, or
 * the start of the page when there is none. */
export function pageOutline(page: MaterialPage, maxChars = 80): string {
	if (page.outline) return page.outline;
	const flat = page.text.replace(/\s+/g, " ").trim();
	return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/** Page numbers a model asked for, as listed or as ranges ("3-5"), limited. */
export function selectPages(
	pages: readonly MaterialPage[],
	requested: readonly (number | string)[],
	limit: number,
): MaterialPage[] {
	const wanted = new Set<number>();
	for (const item of requested) {
		const match = String(item).match(/^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/);
		if (!match) continue;
		const from = Number(match[1]);
		const to = match[2] ? Number(match[2]) : from;
		for (let n = from; n <= Math.min(to, from + limit); n++) wanted.add(n);
	}
	return pages.filter((page) => wanted.has(page.n)).slice(0, limit);
}
