export type CitationPart =
	| { kind: "text"; text: string }
	| { kind: "time"; label: string; seconds: number };

const TIME = String.raw`(?:\d{1,2}:)?\d{1,2}:[0-5]\d`;
const CITATION = new RegExp(
	String.raw`\[(${TIME})(?:\s*[-–~]\s*${TIME})?\]`,
	"g",
);

const toSeconds = (value: string) =>
	value.split(":").reduce((total, part) => total * 60 + Number(part), 0);

export function splitTimestampCitations(text: string): CitationPart[] {
	const parts: CitationPart[] = [];
	let cursor = 0;

	for (const match of text.matchAll(CITATION)) {
		const start = match.index ?? 0;
		if (start > cursor)
			parts.push({ kind: "text", text: text.slice(cursor, start) });
		parts.push({
			kind: "time",
			label: match[0].slice(1, -1),
			seconds: toSeconds(match[1] ?? "0"),
		});
		cursor = start + match[0].length;
	}

	if (cursor < text.length)
		parts.push({ kind: "text", text: text.slice(cursor) });
	return parts;
}
