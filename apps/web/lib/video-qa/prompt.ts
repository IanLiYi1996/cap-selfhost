import { formatPlayerTime } from "@/lib/player-time";
import type { TimelineSegment, VisualTimeline } from "./artifacts";
import type { TimelineBatch } from "./plan";
import { formatCueLines, type TranscriptCue } from "./transcript";

export const VIDEO_QA_INSTRUCTIONS = `You answer questions about one recording (a meeting or a screen recording). The recording is given to you as text: a transcript of what was said, a visual timeline of what was on screen, and an AI summary with chapters.

Grounding:
- Answer from this recording only. If the recording does not cover the question, say so plainly instead of filling the gap from general knowledge. If the user explicitly asks for outside knowledge, keep it clearly separate from what the recording says.
- After each claim, cite where it comes from with the timestamp in square brackets, exactly as written in the context: [05:03], or [1:02:05] past the first hour. Cite a span as [05:03-06:10]. Only cite times that appear in the context or fall inside a timeline segment, and never invent one.
- The transcript is automatic speech recognition. It can contain homophone and terminology errors, especially in Chinese, and may lack punctuation. Read it for meaning, and when you quote it, quote what it says.
- Speaker identity is not known. Do not attribute statements to a named person unless the name is spoken or shown on screen; otherwise say "someone" or describe the role. Lines prefixed "Speaker A:" come from unreliable automatic speaker separation; treat the label as a hint, not a fact.
- Text shown on screen is listed under "Screen text". Quote it verbatim when it matters, such as names, numbers, error messages, code, and settings.

Looking at the screen:
- Use the look_at tool when the answer depends on visual detail the timeline does not spell out, such as an exact value, the state of a UI, code, or a chart, or when the visual timeline is not available. Ask for a narrow range (under about 60 seconds) around the moment you need. Use it at most three times per answer.
- Treat what you see in frames as evidence like any other, and cite its time.

Style:
- Reply in the language of the user's latest question.
- Lead with the answer. Keep it short unless the user asks for detail; use a list when there are several points.`;

const formatSpan = (start: number, end: number) =>
	`${formatPlayerTime(start)}-${formatPlayerTime(end)}`;

const formatSegment = (segment: TimelineSegment) => {
	const lines = [
		`[${formatSpan(segment.start, segment.end)}] ${segment.description}`,
	];
	if (segment.screenText.length > 0) {
		lines.push(
			`  Screen text: ${segment.screenText.map((text) => JSON.stringify(text)).join(" | ")}`,
		);
	}
	return lines.join("\n");
};

export function buildVideoQaContext(input: {
	title: string;
	durationSeconds: number;
	summary?: string | null;
	chapters?: { title: string; start: number }[] | null;
	cues: TranscriptCue[];
	timeline: VisualTimeline | null;
}): string {
	const chapters = input.chapters?.length
		? input.chapters
				.map(
					(chapter) => `[${formatPlayerTime(chapter.start)}] ${chapter.title}`,
				)
				.join("\n")
		: "(none)";
	const timeline = input.timeline?.segments.length
		? input.timeline.segments.map(formatSegment).join("\n")
		: "(not available)";

	return [
		"<recording>",
		`Title: ${input.title}`,
		`Duration: ${formatPlayerTime(input.durationSeconds)}`,
		"</recording>",
		"",
		"<summary>",
		input.summary?.trim() || "(none)",
		"</summary>",
		"",
		"<chapters>",
		chapters,
		"</chapters>",
		"",
		"<transcript>",
		formatCueLines(input.cues) || "(empty)",
		"</transcript>",
		"",
		"<visual_timeline>",
		timeline,
		"</visual_timeline>",
	].join("\n");
}

export const TIMELINE_INSTRUCTIONS = `You build a searchable timeline of what is on screen in a recording. You receive frames sampled where the screen changed, each labelled with its time, and the transcript of what was said in the same window.

Return JSON only, no prose and no code fence:
{"segments":[{"start":<seconds>,"end":<seconds>,"description":"<text>","screen_text":["<text>", ...]}]}

- One segment per distinct screen or state, in time order, together covering the whole window. start and end are seconds inside the window.
- description: one to three sentences on what is shown and what happens: the application, page, slide or document; what is opened, typed, changed or pointed at. Use the transcript only to understand what the screen shows, not to summarise the talk. Write it in the language of the transcript, or of the on-screen text when there is no transcript.
- screen_text: the important visible text, copied verbatim in its original language and spelling: titles, headings, selected menu items and options, field values, numbers, code, error messages, URLs, and names shown on video-call tiles. Skip operating-system chrome and browser tab strips. At most 15 items.
- Do not describe faces or guess who people are. A video-call grid is "a video call with N participants" plus the names shown on the tiles.`;

export function buildBatchPrompt(batch: TimelineBatch, transcript: string) {
	return {
		header: `Window: ${batch.start.toFixed(1)}s-${batch.end.toFixed(1)}s (${formatSpan(batch.start, batch.end)}). ${batch.frames.length} frames follow.`,
		frameLabel: (t: number) =>
			`Frame at ${t.toFixed(1)}s (${formatPlayerTime(t)})`,
		footer: `Transcript in this window:\n${transcript || "(no speech)"}`,
	};
}
