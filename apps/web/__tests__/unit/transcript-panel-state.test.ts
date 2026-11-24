import { describe, expect, it } from "vitest";
import {
	hasNoTranscriptToShow,
	hasTranscriptionStalled,
	isTranscriptionUnresolved,
	shouldOfferEarlyRetry,
	transcriptStallBudgetMs,
} from "@/lib/transcript-panel-state";

const MINUTE = 60 * 1000;
const CREATED = new Date("2026-08-20T06:32:00.000Z");
const at = (ms: number) => CREATED.getTime() + ms;

describe("isTranscriptionUnresolved", () => {
	it("treats a missing status and PROCESSING as unresolved", () => {
		expect(isTranscriptionUnresolved(null)).toBe(true);
		expect(isTranscriptionUnresolved(undefined)).toBe(true);
		expect(isTranscriptionUnresolved("PROCESSING")).toBe(true);
	});

	it("treats every terminal status as resolved", () => {
		for (const status of ["COMPLETE", "ERROR", "SKIPPED", "NO_AUDIO"]) {
			expect(isTranscriptionUnresolved(status)).toBe(false);
		}
	});
});

describe("transcriptStallBudgetMs", () => {
	it("gives a never-queued transcription a flat five minutes", () => {
		expect(transcriptStallBudgetMs(null, 3600)).toBe(5 * MINUTE);
	});

	it("scales the PROCESSING budget with the recording length", () => {
		// The elapsed time it is compared against starts at video creation, so the
		// budget covers the recording itself (1x) plus measured inference (~1.2x).
		expect(transcriptStallBudgetMs("PROCESSING", 0)).toBe(5 * MINUTE);
		expect(transcriptStallBudgetMs("PROCESSING", 60)).toBe(
			5 * MINUTE + 150_000,
		);
		expect(transcriptStallBudgetMs("PROCESSING", 600)).toBe(
			5 * MINUTE + 1_500_000,
		);
	});

	it("stays ahead of the measured Whisper throughput", () => {
		// Observed: a 361s recording finished transcribing ~7.5 min after creation
		// (upload + ~1.15x realtime inference). The budget must not expire first.
		const observedMs = 7.5 * MINUTE;
		expect(transcriptStallBudgetMs("PROCESSING", 361)).toBeGreaterThan(
			observedMs,
		);
	});

	it("does not let a missing or negative duration shrink the budget", () => {
		expect(transcriptStallBudgetMs("PROCESSING", null)).toBe(5 * MINUTE);
		expect(transcriptStallBudgetMs("PROCESSING", undefined)).toBe(5 * MINUTE);
		expect(transcriptStallBudgetMs("PROCESSING", -100)).toBe(5 * MINUTE);
	});
});

describe("hasTranscriptionStalled", () => {
	it("keeps waiting while a fresh video has no status yet", () => {
		expect(
			hasTranscriptionStalled({
				status: null,
				createdAt: CREATED,
				nowMs: at(60 * 1000),
			}),
		).toBe(false);
	});

	it("gives up on a never-queued transcription after five minutes", () => {
		expect(
			hasTranscriptionStalled({
				status: null,
				createdAt: CREATED,
				nowMs: at(6 * MINUTE),
			}),
		).toBe(true);
	});

	// The regression this module exists for: PROCESSING used to be exempt from
	// the timeout entirely, so a claim nothing released spun the panel forever.
	it("gives up on a PROCESSING claim that outlives its budget", () => {
		expect(
			hasTranscriptionStalled({
				status: "PROCESSING",
				createdAt: CREATED,
				durationSeconds: 51,
				nowMs: at(30 * MINUTE),
			}),
		).toBe(true);
	});

	it("keeps waiting on a PROCESSING claim that is still within budget", () => {
		// 10 minutes of audio: 5 min flat + 25 min scaled = 30 min of headroom.
		expect(
			hasTranscriptionStalled({
				status: "PROCESSING",
				createdAt: CREATED,
				durationSeconds: 600,
				nowMs: at(20 * MINUTE),
			}),
		).toBe(false);
	});

	it("never reports a stall for a terminal status", () => {
		for (const status of ["COMPLETE", "ERROR", "SKIPPED", "NO_AUDIO"]) {
			expect(
				hasTranscriptionStalled({
					status,
					createdAt: CREATED,
					nowMs: at(365 * 24 * 60 * MINUTE),
				}),
			).toBe(false);
		}
	});

	it("stops reporting a stall once a retry has been triggered", () => {
		expect(
			hasTranscriptionStalled({
				status: "PROCESSING",
				createdAt: CREATED,
				nowMs: at(999 * MINUTE),
				retryTriggered: true,
			}),
		).toBe(false);
	});

	it("does not treat an unparseable createdAt as the epoch", () => {
		expect(
			hasTranscriptionStalled({
				status: "PROCESSING",
				createdAt: "not a date",
				nowMs: at(0),
			}),
		).toBe(false);
	});
});

describe("shouldOfferEarlyRetry", () => {
	// The 6-minute recording that got stuck: budget 20 min, so the owner gets an
	// out at ~10 min instead of waiting for the hard timeout.
	const STUCK = { status: "PROCESSING", durationSeconds: 361 } as const;

	it("stays hidden while the transcription is plausibly still working", () => {
		expect(
			shouldOfferEarlyRetry({
				...STUCK,
				createdAt: CREATED,
				nowMs: at(5 * MINUTE),
			}),
		).toBe(false);
	});

	it("offers a way out at half the stall budget", () => {
		expect(
			shouldOfferEarlyRetry({
				...STUCK,
				createdAt: CREATED,
				nowMs: at(11 * MINUTE),
			}),
		).toBe(true);
	});

	it("appears before the hard timeout, never after it", () => {
		const nowMs = at(11 * MINUTE);
		expect(shouldOfferEarlyRetry({ ...STUCK, createdAt: CREATED, nowMs })).toBe(
			true,
		);
		expect(
			hasTranscriptionStalled({ ...STUCK, createdAt: CREATED, nowMs }),
		).toBe(false);
	});

	it("never appears before 2.5 minutes, whatever the duration", () => {
		for (const durationSeconds of [0, 1, 51, 361, 7200]) {
			expect(
				shouldOfferEarlyRetry({
					status: "PROCESSING",
					durationSeconds,
					createdAt: CREATED,
					nowMs: at(2.5 * MINUTE),
				}),
			).toBe(false);
		}
	});

	it("does not offer a retry once the status is terminal", () => {
		for (const status of ["COMPLETE", "ERROR", "SKIPPED", "NO_AUDIO"]) {
			expect(
				shouldOfferEarlyRetry({
					status,
					createdAt: CREATED,
					nowMs: at(999 * MINUTE),
				}),
			).toBe(false);
		}
	});

	it("stops offering once a retry is already in flight", () => {
		expect(
			shouldOfferEarlyRetry({
				...STUCK,
				createdAt: CREATED,
				nowMs: at(999 * MINUTE),
				retryTriggered: true,
			}),
		).toBe(false);
	});

	it("does not treat an unparseable createdAt as the epoch", () => {
		expect(
			shouldOfferEarlyRetry({ ...STUCK, createdAt: "nope", nowMs: at(0) }),
		).toBe(false);
	});
});

describe("hasNoTranscriptToShow", () => {
	const base = { isFetching: false, isTranslating: false };

	// Whisper returns zero words for a track carrying only a noise floor, which
	// still produces a valid "WEBVTT\n\n" file. That used to fall through to the
	// normal view and render an empty list with no explanation.
	it("reports an empty transcript on a COMPLETE video", () => {
		expect(
			hasNoTranscriptToShow({ ...base, status: "COMPLETE", hasCues: false }),
		).toBe(true);
	});

	it("stays quiet when there are cues to render", () => {
		expect(
			hasNoTranscriptToShow({ ...base, status: "COMPLETE", hasCues: true }),
		).toBe(false);
	});

	it("waits while the transcript is still being fetched", () => {
		expect(
			hasNoTranscriptToShow({
				...base,
				status: "COMPLETE",
				hasCues: false,
				isFetching: true,
			}),
		).toBe(false);
	});

	it("waits while a translation swaps the cue list out", () => {
		expect(
			hasNoTranscriptToShow({
				...base,
				status: "COMPLETE",
				hasCues: false,
				isTranslating: true,
			}),
		).toBe(false);
	});

	it("defers to the dedicated branches for non-COMPLETE statuses", () => {
		for (const status of ["PROCESSING", "ERROR", "SKIPPED", "NO_AUDIO", null]) {
			expect(hasNoTranscriptToShow({ ...base, status, hasCues: false })).toBe(
				false,
			);
		}
	});
});
