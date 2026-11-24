import { formatPlayerTime } from "@/lib/player-time";

export type TranscriptCue = { start: number; end: number; text: string };

const TIMING =
	/^((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)/;

function parseCueTime(value: string): number {
	const parts = value.split(":").map(Number);
	return parts.reduce((total, part) => total * 60 + part, 0);
}

export function parseVttCues(vtt: string): TranscriptCue[] {
	const cues: TranscriptCue[] = [];
	const lines = vtt.replace(/\r\n?/g, "\n").split("\n");

	for (let i = 0; i < lines.length; i += 1) {
		const timing = lines[i]?.trim().match(TIMING);
		if (!timing?.[1] || !timing[2]) continue;

		const text: string[] = [];
		let j = i + 1;
		while (j < lines.length && lines[j]?.trim()) {
			text.push((lines[j] ?? "").replace(/<[^>]+>/g, "").trim());
			j += 1;
		}
		i = j;

		const joined = text.filter(Boolean).join(" ");
		if (!joined) continue;
		cues.push({
			start: parseCueTime(timing[1]),
			end: parseCueTime(timing[2]),
			text: joined,
		});
	}

	return cues;
}

export const formatCueLines = (cues: TranscriptCue[]) =>
	cues.map((cue) => `[${formatPlayerTime(cue.start)}] ${cue.text}`).join("\n");

export const transcriptBetween = (
	cues: TranscriptCue[],
	start: number,
	end: number,
) => formatCueLines(cues.filter((cue) => cue.end > start && cue.start < end));
