import type { MaterialKind } from "./extract";
import { type MaterialPage, pageOutline } from "./pages";

/**
 * How a recording's materials reach the Q&A model. Within the budget every
 * page goes into the cached context, which is the most accurate; past it the
 * context holds a directory (one line per page) and the model reads what it
 * needs through search_materials and read_material.
 */

export const MATERIALS_FULL_TEXT_BUDGET = 150_000;

export type LoadedMaterial = {
	id: string;
	name: string;
	kind: MaterialKind;
	pages: MaterialPage[];
	/** Still being rendered and described; its pages may change. */
	processing: boolean;
};

export type MaterialsContext = {
	mode: "full" | "directory" | "none";
	block: string;
};

const escapeAttribute = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const pageChars = (materials: readonly LoadedMaterial[]) =>
	materials.reduce(
		(sum, material) =>
			sum + material.pages.reduce((total, page) => total + page.text.length, 0),
		0,
	);

const openTag = (material: LoadedMaterial) =>
	`<material name="${escapeAttribute(material.name)}" pages="${material.pages.length}"${material.processing ? ' status="processing"' : ""}>`;

export function buildMaterialsContext(
	materials: readonly LoadedMaterial[],
	budget = MATERIALS_FULL_TEXT_BUDGET,
): MaterialsContext {
	const present = materials.filter((material) => material.pages.length > 0);
	if (present.length === 0) {
		return {
			mode: "none",
			block: "<materials>\n(none uploaded)\n</materials>",
		};
	}

	if (pageChars(present) <= budget) {
		const body = present
			.map(
				(material) =>
					`${openTag(material)}\n${material.pages
						.filter((page) => page.text)
						.map((page) => `[${page.label}]\n${page.text}`)
						.join("\n\n")}\n</material>`,
			)
			.join("\n");
		return { mode: "full", block: `<materials>\n${body}\n</materials>` };
	}

	const body = present
		.map(
			(material) =>
				`${openTag(material)}\n${material.pages
					.map((page) => `[${page.label}] ${pageOutline(page)}`)
					.join("\n")}\n</material>`,
		)
		.join("\n");
	return {
		mode: "directory",
		block: `<materials mode="directory">\nThe materials are too long to include in full. This is a directory: one line per page. Use search_materials to find passages and read_material to read pages.\n${body}\n</materials>`,
	};
}

export function findMaterial(
	materials: readonly LoadedMaterial[],
	reference: string,
): LoadedMaterial | null {
	const wanted = reference.replace(/^《|》$/g, "").trim();
	const lower = wanted.toLowerCase();
	return (
		materials.find((m) => m.id === wanted || m.name === wanted) ??
		materials.find((m) => m.name.toLowerCase() === lower) ??
		materials.find((m) => m.name.toLowerCase().includes(lower)) ??
		null
	);
}

/** Words for Latin text and character pairs for CJK, which has no spaces. */
export function searchTerms(text: string): string[] {
	const terms: string[] = [];
	const lower = text.toLowerCase();
	for (const word of lower.match(/[\p{L}\p{N}]+/gu) ?? []) {
		const cjk = [...word].filter((char) => /\p{Script=Han}/u.test(char));
		if (cjk.length === 0) {
			if (word.length > 1) terms.push(word);
			continue;
		}
		const chars = [...word];
		if (chars.length === 1) terms.push(word);
		for (let i = 0; i + 1 < chars.length; i++) {
			terms.push(`${chars[i]}${chars[i + 1]}`);
		}
	}
	return terms;
}

export type PageHit = {
	material: LoadedMaterial;
	page: MaterialPage;
	score: number;
};

/** BM25-style scoring over pages; the fallback before vector search exists. */
export function keywordSearch(
	materials: readonly LoadedMaterial[],
	query: string,
	limit = 8,
): PageHit[] {
	const terms = [...new Set(searchTerms(query))];
	if (terms.length === 0) return [];
	const pages = materials.flatMap((material) =>
		material.pages.map((page) => ({
			material,
			page,
			haystack: `${page.outline}\n${page.text}`.toLowerCase(),
		})),
	);
	if (pages.length === 0) return [];
	const averageLength =
		pages.reduce((sum, page) => sum + page.haystack.length, 0) / pages.length ||
		1;
	const documentFrequency = new Map(
		terms.map((term) => [
			term,
			pages.filter((page) => page.haystack.includes(term)).length,
		]),
	);

	const hits: PageHit[] = [];
	for (const { material, page, haystack } of pages) {
		let score = 0;
		for (const term of terms) {
			const df = documentFrequency.get(term) ?? 0;
			if (df === 0) continue;
			const tf = haystack.split(term).length - 1;
			if (tf === 0) continue;
			const idf = Math.log(1 + (pages.length - df + 0.5) / (df + 0.5));
			const norm = 1.2 * (0.25 + 0.75 * (haystack.length / averageLength));
			score += idf * ((tf * 2.2) / (tf + norm));
		}
		if (score > 0) hits.push({ material, page, score });
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function snippet(text: string, query: string, maxChars = 400): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= maxChars) return flat;
	const lower = flat.toLowerCase();
	const positions = searchTerms(query)
		.map((term) => lower.indexOf(term))
		.filter((index) => index >= 0);
	const center = positions.length > 0 ? Math.min(...positions) : 0;
	const start = Math.max(0, center - Math.floor(maxChars / 3));
	const end = Math.min(flat.length, start + maxChars);
	return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
