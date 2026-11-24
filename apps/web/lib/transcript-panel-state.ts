/**
 * Decisions for the share page's transcript panel that are easy to get wrong and
 * hard to see: when a spinner has to give up, and when "nothing to show" must be
 * stated instead of rendering an empty list.
 *
 * Both live here rather than inline in the component so they can be tested
 * without a DOM.
 */

/** Statuses that mean the transcription has not reached a terminal state. */
export const isTranscriptionUnresolved = (
	status: string | null | undefined,
): boolean => !status || status === "PROCESSING";

/**
 * Transcription was never queued at all. Queueing is a couple of database
 * writes, so anything past a few minutes is a stall, not slowness.
 */
const NEVER_QUEUED_BUDGET_MS = 5 * 60 * 1000;

/**
 * How long a non-terminal transcription may sit before the UI calls it stalled.
 *
 * `PROCESSING` needs a more generous budget than a missing status: the claim is
 * taken around video-creation time, so the elapsed time being measured also
 * covers the recording itself and the upload. The multiplier is measured rather
 * than guessed — Whisper `medium` int8 on 4 vCPU transcribed a 361s recording in
 * about 7 minutes (~1.15x realtime) and a 51s one in about 66s including task
 * cold start. 2.5x covers the recording (1x), the inference (~1.2x) and slack,
 * on top of a flat five minutes for cold start and upload.
 *
 * Being too strict here would label a still-running transcription as failed,
 * which is worse than a spinner — hence the early retry offer below rather than
 * an aggressive timeout.
 */
export function transcriptStallBudgetMs(
	status: string | null | undefined,
	durationSeconds: number | null | undefined,
): number {
	if (status !== "PROCESSING") return NEVER_QUEUED_BUDGET_MS;
	return (
		NEVER_QUEUED_BUDGET_MS + 2.5 * 1000 * Math.max(0, durationSeconds ?? 0)
	);
}

/**
 * True once the owner should be offered a retry *while still waiting*, before
 * the hard stall timeout.
 *
 * The point is that waiting is never a dead end. A long recording has a stall
 * budget measured in tens of minutes, and staring at a spinner with no way to
 * act on it is the complaint this exists to answer. Offering at half the budget
 * scales with the recording the same way the timeout does, and the flat
 * five-minute component guarantees the offer never appears before 2.5 minutes —
 * early enough to be useful, late enough not to invite restarting a
 * transcription that simply has not got going yet.
 */
export function shouldOfferEarlyRetry({
	status,
	createdAt,
	durationSeconds,
	nowMs,
	retryTriggered = false,
}: {
	status: string | null | undefined;
	createdAt: Date | string | number;
	durationSeconds?: number | null;
	nowMs: number;
	retryTriggered?: boolean;
}): boolean {
	if (retryTriggered) return false;
	if (!isTranscriptionUnresolved(status)) return false;

	const createdMs = new Date(createdAt).getTime();
	if (Number.isNaN(createdMs)) return false;

	return (
		nowMs - createdMs > transcriptStallBudgetMs(status, durationSeconds) / 2
	);
}

/**
 * True once a non-terminal transcription has outlived its budget.
 *
 * A `PROCESSING` row has no server-side reaper — the workflow only writes ERROR
 * from its catch block, so a task killed mid-run leaves the claim in place
 * forever. Without this the panel spins until the page is reloaded by hand.
 */
export function hasTranscriptionStalled({
	status,
	createdAt,
	durationSeconds,
	nowMs,
	retryTriggered = false,
}: {
	status: string | null | undefined;
	createdAt: Date | string | number;
	durationSeconds?: number | null;
	nowMs: number;
	retryTriggered?: boolean;
}): boolean {
	if (retryTriggered) return false;
	if (!isTranscriptionUnresolved(status)) return false;

	const createdMs = new Date(createdAt).getTime();
	// An unparseable timestamp must not be read as "created at the epoch", which
	// would declare every such video stalled on first render.
	if (Number.isNaN(createdMs)) return false;

	return nowMs - createdMs > transcriptStallBudgetMs(status, durationSeconds);
}

/**
 * True when a finished transcription has no cues to render.
 *
 * Covers both "the fetch failed" and "the VTT was genuinely empty" — Whisper
 * returns zero words for a track that carries only a noise floor, which yields a
 * valid but cue-less `WEBVTT` file. Either way the panel must say so; falling
 * through to the normal view would render an empty list with no explanation.
 */
export function hasNoTranscriptToShow({
	status,
	hasCues,
	isFetching,
	isTranslating,
}: {
	status: string | null | undefined;
	hasCues: boolean;
	isFetching: boolean;
	isTranslating: boolean;
}): boolean {
	if (status !== "COMPLETE") return false;
	// Still resolving: a spinner is correct, and translation swaps the cue list
	// out from under us.
	if (isFetching || isTranslating) return false;
	return !hasCues;
}
