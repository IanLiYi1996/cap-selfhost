import { joinFragments } from "@/lib/text-join";

export interface AssemblyAIWord {
	text: string;
	start: number;
	end: number;
	confidence?: number;
	/** Diarization label ("A", "B", ...). Null or absent when unknown. */
	speaker?: string | null;
}

/**
 * Prefix marking who is speaking, emitted only when the speaker changes.
 *
 * This is the only channel through which speaker information reaches anything
 * downstream: the transcript panel and the AI summary both read
 * `transcription.vtt`, and the summary is generated from its text. A recording
 * of several people otherwise summarises as one undifferentiated monologue.
 *
 * A plain prefix rather than a WebVTT `<v A>` voice span, because `parseVTT` is
 * hand-rolled and has no tag handling — a voice span would render literally.
 */
const speakerPrefix = (speaker: string | null | undefined): string =>
	speaker ? `Speaker ${speaker}: ` : "";

export interface AssemblyAIResult {
	words?: readonly AssemblyAIWord[] | null;
}

export function formatTimestamp(milliseconds: number): string {
	const totalMilliseconds = Math.max(0, Math.round(milliseconds));
	const hours = Math.floor(totalMilliseconds / 3_600_000);
	const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
	const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
	const millis = totalMilliseconds % 1_000;

	return `${hours.toString().padStart(2, "0")}:${minutes
		.toString()
		.padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${millis
		.toString()
		.padStart(3, "0")}`;
}

export function formatToWebVTT(result: AssemblyAIResult): string {
	let output = "WEBVTT\n\n";
	let captionIndex = 1;
	const words = result.words;

	if (!words || words.length === 0) {
		return output;
	}

	let group: string[] = [];
	let start = formatTimestamp(words[0]?.start ?? 0);
	let wordCount = 0;
	// Who the current cue belongs to, and who the last emitted prefix named, so
	// the label appears on change instead of on every cue.
	let groupSpeaker = words[0]?.speaker ?? null;
	let announcedSpeaker: string | null = null;

	const flush = (endMs: number, nextWord: AssemblyAIWord | undefined) => {
		// An unattributed stretch does not clear the announcement: otherwise a
		// single unlabelled word between two of A's cues makes A introduce
		// themselves again.
		const announce = groupSpeaker !== null && groupSpeaker !== announcedSpeaker;
		if (announce) announcedSpeaker = groupSpeaker;

		const text = `${announce ? speakerPrefix(groupSpeaker) : ""}${joinFragments(group)}`;
		output += `${captionIndex}\n${start} --> ${formatTimestamp(endMs)}\n${text}\n\n`;

		captionIndex++;
		group = [];
		wordCount = 0;
		start = nextWord ? formatTimestamp(nextWord.start) : start;
		groupSpeaker = nextWord?.speaker ?? null;
	};

	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (!word) continue;

		group.push(word.text);
		wordCount++;

		const nextWord = words[i + 1];
		// A cue must never mix speakers, so a change forces a break regardless of
		// how short the cue is.
		const speakerChanges =
			nextWord !== undefined &&
			(nextWord.speaker ?? null) !== (word.speaker ?? null);
		const shouldBreak =
			/[,.!?;:]$/.test(word.text) ||
			(nextWord && nextWord.start - word.end > 500) ||
			wordCount === 8 ||
			speakerChanges;

		if (shouldBreak) flush(word.end, nextWord);
	}

	if (group.length > 0) {
		const lastWord = words[words.length - 1];
		if (lastWord) flush(lastWord.end, undefined);
	}

	return output;
}
