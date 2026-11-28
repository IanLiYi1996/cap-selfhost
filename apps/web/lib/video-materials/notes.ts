import { extractJsonObject } from "@/lib/video-qa/plan";
import { MAX_DESCRIBED_PAGES, type PageNote, parsePageNotes } from "./pages";

export const NOTE_BATCH_SIZE = 6;
const PAGE_TEXT_CHARS = 3_000;

export const PAGE_NOTES_INSTRUCTIONS = `You prepare pages of a meeting document so that questions about it can be answered later. For each page you receive its image and the text extracted from it (which can be empty, partial or out of order).

Return JSON only, no prose and no code fence:
{"pages":[{"page":<number>,"outline":"<text>","visual":"<text>","text":"<text>"}]}

- One entry per page you were given, with its number.
- outline: one short sentence saying what the page is about, in the document's language. It goes into a table of contents.
- visual: what the image shows that the extracted text does not: charts (type, axes, and every value or bar you can read), tables (as rows "a | b | c"), diagrams and flowcharts (the boxes and arrows in order), screenshots (application, screen, important values), photos and handwriting. Copy numbers, names and labels exactly. Empty string when the page is plain text already covered by the extracted text.
- text: only when the extracted text is empty or clearly missing most of the page (a scan or an image of text): the page's text, transcribed in reading order. Otherwise an empty string.
- Never invent content that is not on the page.`;

export function planNoteBatches(
	pageNumbers: readonly number[],
	size = NOTE_BATCH_SIZE,
	max = MAX_DESCRIBED_PAGES,
): number[][] {
	const pages = [...pageNumbers].sort((a, b) => a - b).slice(0, max);
	const batches: number[][] = [];
	for (let i = 0; i < pages.length; i += size) {
		batches.push(pages.slice(i, i + size));
	}
	return batches;
}

export function pagePromptText(
	materialName: string,
	label: string,
	text: string,
): string {
	const trimmed = text.trim();
	const clipped =
		trimmed.length > PAGE_TEXT_CHARS
			? `${trimmed.slice(0, PAGE_TEXT_CHARS)}…`
			: trimmed;
	return `${materialName} · ${label}\nExtracted text:\n${clipped || "(none)"}`;
}

/** The model's notes for one batch, kept to the pages it was given. */
export function parseNotesResponse(
	text: string,
	batch: readonly number[],
): PageNote[] {
	const wanted = new Set(batch);
	return parsePageNotes(JSON.stringify(extractJsonObject(text) ?? {})).filter(
		(note) => wanted.has(note.n),
	);
}
