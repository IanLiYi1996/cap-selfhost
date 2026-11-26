import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
	extractMaterialText,
	htmlToText,
	materialKind,
} from "@/lib/video-materials/extract";

async function zip(files: Record<string, string>) {
	const archive = new JSZip();
	for (const [path, content] of Object.entries(files))
		archive.file(path, content);
	return new Uint8Array(await archive.generateAsync({ type: "uint8array" }));
}

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("materialKind", () => {
	it("recognises supported documents by extension, case-insensitively", () => {
		expect(materialKind("Plan.PDF")).toBe("pdf");
		expect(materialKind("spec.docx")).toBe("docx");
		expect(materialKind("deck.pptx")).toBe("pptx");
		expect(materialKind("budget.xlsx")).toBe("xlsx");
		expect(materialKind("prototype.html")).toBe("html");
		expect(materialKind("notes.htm")).toBe("html");
		expect(materialKind("README.md")).toBe("text");
		expect(materialKind("data.csv")).toBe("text");
	});

	it("rejects everything else", () => {
		expect(materialKind("old.doc")).toBe(null);
		expect(materialKind("photo.png")).toBe(null);
		expect(materialKind("archive.zip")).toBe(null);
		expect(materialKind("noextension")).toBe(null);
	});
});

describe("htmlToText", () => {
	it("keeps visible text and structure, drops scripts, styles and tags", () => {
		const text = htmlToText(
			"<html><head><title>T</title><style>p{color:red}</style></head><body>" +
				"<h1>工单流程</h1><p>体验优先 &amp; 效率优先</p><script>alert(1)</script>" +
				"<ul><li>安装</li><li>维修</li></ul><table><tr><td>A</td><td>B</td></tr></table></body></html>",
		);
		expect(text).toBe("工单流程\n体验优先 & 效率优先\n安装\n维修\nA\tB");
	});
});

describe("extractMaterialText", () => {
	it("reads plain text and markdown as UTF-8", async () => {
		expect(await extractMaterialText("a.md", utf8("# 标题\n\n正文"))).toBe(
			"# 标题\n\n正文",
		);
	});

	it("reads a Word document paragraph by paragraph", async () => {
		const docx = await zip({
			"word/document.xml":
				'<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:t xml:space="preserve"> 继续</w:t></w:r></w:p>' +
				"<w:p><w:r><w:t>第二段 &lt;重要&gt;</w:t></w:r></w:p></w:body></w:document>",
		});
		expect(await extractMaterialText("spec.docx", docx)).toBe(
			"第一段 继续\n第二段 <重要>",
		);
	});

	it("reads slides in order, labelled by number", async () => {
		const pptx = await zip({
			"ppt/slides/slide10.xml":
				"<p:sld><a:p><a:r><a:t>结尾</a:t></a:r></a:p></p:sld>",
			"ppt/slides/slide2.xml":
				"<p:sld><a:p><a:r><a:t>派单</a:t></a:r></a:p><a:p><a:r><a:t>看板</a:t></a:r></a:p></p:sld>",
			"ppt/slides/slide1.xml":
				"<p:sld><a:p><a:r><a:t>封面</a:t></a:r></a:p></p:sld>",
		});
		expect(await extractMaterialText("deck.pptx", pptx)).toBe(
			"[Slide 1]\n封面\n\n[Slide 2]\n派单\n看板\n\n[Slide 10]\n结尾",
		);
	});

	it("reads spreadsheet rows with shared and inline strings", async () => {
		const xlsx = await zip({
			"xl/workbook.xml":
				'<workbook><sheets><sheet name="排期" sheetId="1"/></sheets></workbook>',
			"xl/sharedStrings.xml":
				"<sst><si><t>工程师</t></si><si><t>时段</t></si></sst>",
			"xl/worksheets/sheet1.xml":
				'<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>' +
				'<row><c t="inlineStr"><is><t>李</t></is></c><c><v>9.5</v></c></row></sheetData></worksheet>',
		});
		expect(await extractMaterialText("plan.xlsx", xlsx)).toBe(
			"[Sheet 排期]\n工程师\t时段\n李\t9.5",
		);
	});

	it("reads a PDF page by page", async () => {
		const pdf = await PDFDocument.create();
		const font = await pdf.embedFont(StandardFonts.Helvetica);
		pdf.addPage().drawText("Dispatch rules", { x: 50, y: 700, font, size: 18 });
		pdf.addPage().drawText("Second page", { x: 50, y: 700, font, size: 18 });
		const bytes = await pdf.save();

		const text = await extractMaterialText("rules.pdf", bytes);
		expect(text).toContain("[Page 1]");
		expect(text).toContain("Dispatch rules");
		expect(text).toContain("[Page 2]");
		expect(text).toContain("Second page");
	});

	it("rejects an unsupported type", async () => {
		await expect(extractMaterialText("photo.png", utf8("x"))).rejects.toThrow(
			"Unsupported",
		);
	});
});
