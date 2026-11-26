import JSZip from "jszip";

export type MaterialKind = "pdf" | "docx" | "pptx" | "xlsx" | "html" | "text";

const KINDS: Record<string, MaterialKind> = {
	pdf: "pdf",
	docx: "docx",
	pptx: "pptx",
	xlsx: "xlsx",
	html: "html",
	htm: "html",
	md: "text",
	markdown: "text",
	txt: "text",
	csv: "text",
	tsv: "text",
	json: "text",
};

export const SUPPORTED_MATERIAL_EXTENSIONS = Object.keys(KINDS);

export function materialKind(name: string): MaterialKind | null {
	const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
	return (match?.[1] && KINDS[match[1]]) || null;
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function decodeEntities(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
		(whole, entity: string) => {
			if (entity[0] === "#") {
				const code =
					entity[1]?.toLowerCase() === "x"
						? Number.parseInt(entity.slice(2), 16)
						: Number.parseInt(entity.slice(1), 10);
				return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
			}
			return ENTITIES[entity.toLowerCase()] ?? whole;
		},
	);
}

function tidy(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t ]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const BLOCK_TAGS =
	"address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul";

export function htmlToText(html: string): string {
	const text = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|head|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, "")
		.replace(/<\/(td|th)>\s*/gi, "\t")
		.replace(new RegExp(`<\\/?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
		.replace(/<[^>]+>/g, "");

	return tidy(
		decodeEntities(text)
			.split("\n")
			.map((line) => line.replace(/[ \t]+$/, "").replace(/^[ ]+/, ""))
			.filter((line) => line.trim())
			.join("\n"),
	);
}

const xmlText = (xml: string, tag: string) =>
	[
		...xml.matchAll(
			new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g"),
		),
	]
		.map((match) => decodeEntities(match[1] ?? ""))
		.join("");

const paragraphs = (xml: string, paragraphTag: string, textTag: string) =>
	xml
		.split(new RegExp(`<\\/${paragraphTag}>`))
		.map((chunk) => xmlText(chunk, textTag))
		.filter((line) => line.trim());

const byNumber = (prefix: RegExp) => (a: string, b: string) =>
	Number(a.match(prefix)?.[1] ?? 0) - Number(b.match(prefix)?.[1] ?? 0);

async function docxText(bytes: Uint8Array): Promise<string> {
	const archive = await JSZip.loadAsync(bytes);
	const xml = (await archive.file("word/document.xml")?.async("string")) ?? "";
	return paragraphs(
		xml.replace(/<w:tab\/>/g, "<w:t>\t</w:t>"),
		"w:p",
		"w:t",
	).join("\n");
}

async function pptxText(bytes: Uint8Array): Promise<string> {
	const archive = await JSZip.loadAsync(bytes);
	const slideNumber = /slide(\d+)\.xml$/;
	const slides = Object.keys(archive.files)
		.filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
		.sort(byNumber(slideNumber));

	const parts: string[] = [];
	for (const path of slides) {
		const xml = (await archive.file(path)?.async("string")) ?? "";
		const lines = paragraphs(xml, "a:p", "a:t");
		if (lines.length > 0) {
			parts.push(
				`[Slide ${path.match(slideNumber)?.[1]}]\n${lines.join("\n")}`,
			);
		}
	}
	return parts.join("\n\n");
}

async function xlsxText(bytes: Uint8Array): Promise<string> {
	const archive = await JSZip.loadAsync(bytes);
	const shared = [
		...(
			(await archive.file("xl/sharedStrings.xml")?.async("string")) ?? ""
		).matchAll(/<si>([\s\S]*?)<\/si>/g),
	].map((match) => xmlText(match[1] ?? "", "t"));
	const workbook =
		(await archive.file("xl/workbook.xml")?.async("string")) ?? "";
	const names = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map(
		(m) => decodeEntities(m[1] ?? ""),
	);

	const sheetNumber = /sheet(\d+)\.xml$/;
	const sheets = Object.keys(archive.files)
		.filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
		.sort(byNumber(sheetNumber));

	const parts: string[] = [];
	for (const [index, path] of sheets.entries()) {
		const xml = (await archive.file(path)?.async("string")) ?? "";
		const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)]
			.map((row) =>
				[...(row[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)]
					.map(([, attributes = "", body = ""]) => {
						if (/\bt="s"/.test(attributes)) {
							return shared[Number(xmlText(body, "v"))] ?? "";
						}
						if (/\bt="inlineStr"/.test(attributes)) return xmlText(body, "t");
						return xmlText(body, "v");
					})
					.join("\t"),
			)
			.filter((row) => row.trim());
		if (rows.length > 0) {
			parts.push(`[Sheet ${names[index] ?? index + 1}]\n${rows.join("\n")}`);
		}
	}
	return parts.join("\n\n");
}

async function pdfText(bytes: Uint8Array): Promise<string> {
	const { extractText, getDocumentProxy } = await import("unpdf");
	const document = await getDocumentProxy(new Uint8Array(bytes));
	const { text } = await extractText(document, { mergePages: false });
	return text
		.map((page, index) =>
			page.trim() ? `[Page ${index + 1}]\n${page.trim()}` : "",
		)
		.filter(Boolean)
		.join("\n\n");
}

export async function extractMaterialText(
	name: string,
	bytes: Uint8Array,
): Promise<string> {
	const kind = materialKind(name);
	switch (kind) {
		case "pdf":
			return tidy(await pdfText(bytes));
		case "docx":
			return tidy(await docxText(bytes));
		case "pptx":
			return tidy(await pptxText(bytes));
		case "xlsx":
			return tidy(await xlsxText(bytes));
		case "html":
			return htmlToText(new TextDecoder().decode(bytes));
		case "text":
			return tidy(new TextDecoder().decode(bytes));
		default:
			throw new Error(`Unsupported material type: ${name}`);
	}
}
