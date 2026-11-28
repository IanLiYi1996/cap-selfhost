import { describe, expect, it } from "vitest";
import {
	buildMaterialsContext,
	findMaterial,
	keywordSearch,
	type LoadedMaterial,
	searchTerms,
	snippet,
} from "@/lib/video-materials/context";
import {
	composePages,
	contentToText,
	type MaterialPage,
	pageOutline,
	pagesFromText,
	parsePageNotes,
	parsePagesIndex,
	selectPages,
} from "@/lib/video-materials/pages";

const page = (n: number, text: string, outline = ""): MaterialPage => ({
	n,
	label: `Page ${n}`,
	text,
	outline,
	imageKey: null,
});

const material = (
	name: string,
	pages: MaterialPage[],
	id = name,
): LoadedMaterial => ({ id, name, kind: "pdf", pages, processing: false });

describe("pages", () => {
	it("reads the render task's index, in page order", () => {
		const index = parsePagesIndex(
			JSON.stringify({
				pageCount: 3,
				pages: [
					{ n: 2, key: "k2", width: 1280, height: 720, text: "B" },
					{ n: 1, key: "k1", width: 1280, height: 720, text: "A" },
					{ key: "broken" },
				],
			}),
		);
		expect(index?.pageCount).toBe(3);
		expect(index?.pages.map((p) => p.n)).toEqual([1, 2]);
		expect(parsePagesIndex("{")).toBeNull();
	});

	it("folds the model's notes into each page, using its text for scanned pages", () => {
		const index = parsePagesIndex(
			JSON.stringify({
				pages: [
					{ n: 1, key: "k1", text: "派单规则" },
					{ n: 2, key: "k2", text: "" },
				],
			}),
		);
		const notes = parsePageNotes(
			JSON.stringify({
				pages: [
					{ page: 1, outline: "规则总览", visual: "流程图：接单→派单→上门" },
					{ page: 2, outline: "扫描页", visual: "", text: "手写的排期表" },
				],
			}),
		);
		const pages = composePages(
			"pptx",
			index ?? { pageCount: 0, pages: [] },
			notes,
		);
		expect(pages).toEqual([
			{
				n: 1,
				label: "Slide 1",
				text: "派单规则\n[Figures] 流程图：接单→派单→上门",
				outline: "规则总览",
				imageKey: "k1",
			},
			{
				n: 2,
				label: "Slide 2",
				text: "手写的排期表",
				outline: "扫描页",
				imageKey: "k2",
			},
		]);
		expect(contentToText(pages)).toBe(
			"[Slide 1]\n派单规则\n[Figures] 流程图：接单→派单→上门\n\n[Slide 2]\n手写的排期表",
		);
	});

	it("splits upload-time text on its page markers", () => {
		expect(
			pagesFromText("pdf", "[Page 1]\n第一页\n\n[Page 2]\n第二页").map((p) => [
				p.label,
				p.text,
			]),
		).toEqual([
			["Page 1", "第一页"],
			["Page 2", "第二页"],
		]);
		expect(pagesFromText("html", "正文")).toMatchObject([
			{ n: 1, label: "Document", text: "正文" },
		]);
		expect(pagesFromText("text", "  ")).toEqual([]);
	});

	it("outlines a page by its note or its first words", () => {
		expect(pageOutline(page(1, "x", "大纲"))).toBe("大纲");
		expect(pageOutline(page(1, "a ".repeat(100), ""), 10)).toBe("a a a a a …");
	});

	it("selects requested pages by number or range, within the limit", () => {
		const pages = [1, 2, 3, 4, 5, 6].map((n) => page(n, `p${n}`));
		expect(selectPages(pages, [2, "4-5"], 10).map((p) => p.n)).toEqual([
			2, 4, 5,
		]);
		expect(selectPages(pages, ["1-6"], 3).map((p) => p.n)).toEqual([1, 2, 3]);
		expect(selectPages(pages, ["x", 99], 3)).toEqual([]);
	});
});

describe("materials context", () => {
	const small = [material("a.pdf", [page(1, "短内容", "大纲一")])];

	it("puts every page in the context within the budget", () => {
		const context = buildMaterialsContext(small, 1000);
		expect(context.mode).toBe("full");
		expect(context.block).toContain('<material name="a.pdf" pages="1">');
		expect(context.block).toContain("[Page 1]\n短内容");
	});

	it("lists one line per page past the budget", () => {
		const big = [
			material("big.pdf", [
				page(1, "长".repeat(120), "第一页讲派单"),
				page(2, "长".repeat(120)),
			]),
		];
		const context = buildMaterialsContext(big, 100);
		expect(context.mode).toBe("directory");
		expect(context.block).toContain("[Page 1] 第一页讲派单");
		expect(context.block).toContain("[Page 2] 长长长");
		expect(context.block).not.toContain("长".repeat(120));
	});

	it("says when there are no materials", () => {
		expect(buildMaterialsContext([]).mode).toBe("none");
	});

	it("finds a material by id, exact or partial name", () => {
		const materials = [
			material("派单规则.pdf", [], "m1"),
			material("Budget.xlsx", [], "m2"),
		];
		expect(findMaterial(materials, "m2")?.name).toBe("Budget.xlsx");
		expect(findMaterial(materials, "《派单规则.pdf》")?.id).toBe("m1");
		expect(findMaterial(materials, "budget")?.id).toBe("m2");
		expect(findMaterial(materials, "nothing")).toBeNull();
	});
});

describe("keyword search", () => {
	it("splits Chinese into character pairs and keeps Latin words", () => {
		expect(searchTerms("派单规则 GraphRAG")).toEqual([
			"派单",
			"单规",
			"规则",
			"graphrag",
		]);
	});

	it("ranks the pages that match the query", () => {
		const materials = [
			material("a.pdf", [
				page(1, "会议议程和参会人员"),
				page(2, "派单规则：体验优先、效率优先，派单时考虑距离"),
				page(3, "预算表"),
			]),
			material("b.pdf", [page(1, "派单看板的截图")]),
		];
		const hits = keywordSearch(materials, "派单规则");
		expect(hits[0]?.page.n).toBe(2);
		expect(hits.map((hit) => `${hit.material.name}#${hit.page.n}`)).toContain(
			"b.pdf#1",
		);
		expect(hits.some((hit) => hit.page.n === 3)).toBe(false);
	});

	it("cuts a snippet around the first match", () => {
		const text = `${"无关内容".repeat(100)}派单规则在这里${"后文".repeat(100)}`;
		const cut = snippet(text, "派单规则", 40);
		expect(cut).toContain("派单规则");
		expect(cut.startsWith("…")).toBe(true);
	});
});
