import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { fetchStorageUrl } from "@/lib/storage-fetch";
import {
	findMaterial,
	keywordSearch,
	type LoadedMaterial,
	type MaterialsContext,
	snippet,
} from "@/lib/video-materials/context";
import { selectPages } from "@/lib/video-materials/pages";
import type { Bucket } from "@/lib/video-materials/storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

const READ_MAX_PAGES = 10;
const READ_MAX_CHARS = 60_000;
const LOOK_MAX_PAGES = 6;
const MAX_CALLS = { search: 6, read: 6, look: 3 };

export type MaterialSearch = (
	query: string,
	materials: readonly LoadedMaterial[],
	limit: number,
) => Promise<{ material: LoadedMaterial; pageNumber: number; text: string }[]>;

/** Until the knowledge index exists, search scores the pages in memory. */
export const keywordMaterialSearch: MaterialSearch = async (
	query,
	materials,
	limit,
) =>
	keywordSearch(materials, query, limit).map((hit) => ({
		material: hit.material,
		pageNumber: hit.page.n,
		text: hit.page.text,
	}));

const pagesInput = z
	.array(z.union([z.number().int().min(1), z.string()]))
	.min(1)
	.describe('Page numbers or ranges, e.g. [3, "5-7"]');

export function createMaterialTools(options: {
	bucket: Bucket;
	materials: LoadedMaterial[];
	context: MaterialsContext;
	search?: MaterialSearch;
}) {
	const { bucket, materials, context } = options;
	const search = options.search ?? keywordMaterialSearch;
	const calls = { search: 0, read: 0, look: 0 };
	const over = (kind: keyof typeof calls) => {
		calls[kind] += 1;
		return calls[kind] > MAX_CALLS[kind];
	};
	const unknown = (reference: string) => ({
		error: `No material matches "${reference}". Materials: ${materials.map((m) => m.name).join(", ")}`,
	});

	const tools: ToolSet = {};

	if (context.mode === "directory") {
		tools.search_materials = tool({
			description:
				"Search this recording's materials for passages about a topic. Returns the best-matching pages with a snippet each; then read_material to read them in full.",
			inputSchema: z.object({
				query: z
					.string()
					.min(1)
					.describe("What to look for, in the materials' language"),
				material: z
					.string()
					.optional()
					.describe("Limit the search to one material, by name"),
			}),
			execute: async ({ query, material }) => {
				if (over("search")) return { note: "search limit reached", hits: [] };
				const scope = material ? findMaterial(materials, material) : null;
				if (material && !scope) return unknown(material);
				const hits = await search(query, scope ? [scope] : materials, 8);
				return {
					hits: hits.map((hit) => {
						const page = hit.material.pages.find((p) => p.n === hit.pageNumber);
						return {
							material: hit.material.name,
							page: page?.label ?? `Page ${hit.pageNumber}`,
							pageNumber: hit.pageNumber,
							snippet: snippet(hit.text, query),
						};
					}),
				};
			},
		});

		tools.read_material = tool({
			description: `Read pages of a material in full (text and notes on its figures). Up to ${READ_MAX_PAGES} pages per call.`,
			inputSchema: z.object({
				material: z.string().describe("The material's name"),
				pages: pagesInput,
			}),
			execute: async ({ material, pages }) => {
				if (over("read")) return { note: "read limit reached", pages: [] };
				const found = findMaterial(materials, material);
				if (!found) return unknown(material);
				let budget = READ_MAX_CHARS;
				const picked = selectPages(found.pages, pages, READ_MAX_PAGES).map(
					(page) => {
						const text = page.text.slice(0, Math.max(0, budget));
						budget -= text.length;
						return { page: page.label, text };
					},
				);
				return {
					material: found.name,
					pages: picked,
					note:
						picked.length > 0
							? undefined
							: `No such pages; ${found.name} has ${found.pages.length} pages.`,
				};
			},
		});
	}

	if (materials.some((m) => m.pages.some((page) => page.imageKey))) {
		tools.look_at_material = tool({
			description: `Look at pages of a material as images, to read a chart, table, diagram, screenshot or layout exactly. Up to ${LOOK_MAX_PAGES} pages per call, at most three calls per answer.`,
			inputSchema: z.object({
				material: z.string().describe("The material's name"),
				pages: pagesInput,
			}),
			execute: async ({ material, pages }) => {
				if (over("look"))
					return { note: "look_at_material limit reached", images: [] };
				const found = findMaterial(materials, material);
				if (!found) return { note: unknown(material).error, images: [] };
				const picked = selectPages(found.pages, pages, LOOK_MAX_PAGES).filter(
					(page) => page.imageKey,
				);
				const images = await Promise.all(
					picked.map(async (page) => {
						const url = await bucket
							.getInternalSignedObjectUrl(page.imageKey as string)
							.pipe(runWorkflowPromise);
						const response = await fetchStorageUrl(url);
						if (!response.ok) return null;
						return {
							label: `${found.name} ${page.label}`,
							data: new Uint8Array(await response.arrayBuffer()),
						};
					}),
				);
				const ok = images.filter((image) => image !== null);
				return {
					note:
						ok.length > 0
							? `${ok.length} pages of ${found.name}.`
							: `No page images for those pages of ${found.name}.`,
					images: ok,
				};
			},
			toModelOutput: ({ output }) => ({
				type: "content",
				value: [
					{ type: "text", text: output.note },
					...output.images.flatMap((image) => [
						{ type: "text" as const, text: image.label },
						{
							type: "file" as const,
							data: { type: "data" as const, data: image.data },
							mediaType: "image/jpeg",
						},
					]),
				],
			}),
		});
	}

	return tools;
}
