import {
	StartStreamTranscriptionCommand,
	TranscribeStreamingClient,
} from "@aws-sdk/client-transcribe-streaming";
import {
	type Entry,
	LIVE,
	LiveSession,
	type LiveSessionDeps,
	planLiveChunk,
	type StartLiveSession,
} from "./live-transcribe";
import { spawn } from "./media-spawn";

/**
 * Live transcription through Amazon Transcribe Streaming. One stream per
 * session hears the recording's audio as its segments are uploaded; words
 * Transcribe marks stable are reported to the web app (same protocol as the
 * chunked session) as soon as the segments they fall in are fully heard, so
 * captions trail speech by a few seconds instead of a whole chunk.
 */

export const STREAM = {
	SAMPLE_RATE: 16_000,
	/** 16-bit mono PCM. */
	BYTES_PER_MS: 32,
	/** Transcribe ends a stream that hears nothing for 15 s. */
	KEEPALIVE_AFTER_MS: 5_000,
	KEEPALIVE_MS: 1_000,
	/** Audio sent this long ago with no partial open has been heard as silence. */
	SILENCE_SETTLE_MS: 3_000,
	/** Catching up after a restart: at most this far ahead of real time. */
	MAX_LEAD_MS: 15_000,
	FRAME_BYTES: 8_192,
	MIN_REPORT_INTERVAL_MS: 1_500,
	MAX_STREAM_RESTARTS: 3,
	/** The chunked session's 1 h cost cap does not apply: a stream is billed
	 * per second either way and meetings run long. */
	MAX_TRANSCRIBED_MS: LIVE.MAX_SESSION_MS,
} as const;

type StreamItem = {
	Content?: string;
	StartTime?: number;
	EndTime?: number;
	Type?: string;
	Stable?: boolean;
};

export type StreamResult = {
	ResultId?: string;
	IsPartial?: boolean;
	StartTime?: number;
	LanguageCode?: string;
	Alternatives?: { Items?: StreamItem[] }[];
};

export type StreamWord = { text: string; start: number; end: number };

/**
 * Turns Transcribe's results into words that will not change: every item of
 * a final result, and the stable prefix of a partial one. Times stay in
 * stream milliseconds.
 */
export class StableWordCollector {
	private readonly taken = new Map<string, number>();
	private open: { id: string; unstableFromMs: number } | null = null;
	words: StreamWord[] = [];
	languageCode: string | null = null;

	accept(result: StreamResult) {
		const id = result.ResultId ?? "";
		const items = result.Alternatives?.[0]?.Items ?? [];
		if (result.LanguageCode && !this.languageCode) {
			this.languageCode = result.LanguageCode.split("-")[0] ?? null;
		}

		let usable = items.length;
		if (result.IsPartial) {
			usable = 0;
			while (usable < items.length && items[usable]?.Stable) usable++;
		}
		const from = this.taken.get(id) ?? 0;
		for (const item of items.slice(from, usable)) this.add(item);

		if (result.IsPartial) {
			this.taken.set(id, Math.max(from, usable));
			const next = items[usable];
			this.open = {
				id,
				unstableFromMs: Math.round(
					(next?.StartTime ?? result.StartTime ?? 0) * 1000,
				),
			};
		} else {
			this.taken.delete(id);
			if (this.open?.id === id) this.open = null;
		}
	}

	private add(item: StreamItem) {
		const text = item.Content?.trim();
		if (!text) return;
		const previous = this.words.at(-1);
		if (item.Type === "punctuation") {
			if (previous) {
				previous.text = `${previous.text}${text}`.slice(0, 200);
				return;
			}
		}
		const start = Math.round((item.StartTime ?? 0) * 1000);
		const end = Math.max(start, Math.round((item.EndTime ?? 0) * 1000));
		this.words.push({ text: text.slice(0, 200), start, end });
	}

	/** Stream time before which no word can still change, or null when no
	 * result is open (then only elapsed time can tell silence apart). */
	unstableFromMs(): number | null {
		return this.open?.unstableFromMs ?? null;
	}
}

/**
 * Stream time and recording time differ only by the keepalive silence sent
 * while no audio was arriving, which is always inserted between segments.
 */
export class StreamTimeline {
	private readonly silences: { atMs: number; ms: number }[] = [];

	addSilence(atMs: number, ms: number) {
		this.silences.push({ atMs, ms });
	}

	toRecordingMs(streamMs: number) {
		let shift = 0;
		for (const silence of this.silences) {
			if (silence.atMs >= streamMs) break;
			shift += Math.min(silence.ms, streamMs - silence.atMs);
		}
		return streamMs - shift;
	}
}

export type FedSegment = { index: number; startMs: number; endMs: number };

export type StreamReport = {
	lastIndex: number;
	/** Milliseconds from the start of the first reported segment. */
	words: StreamWord[];
	/** How many of the given words were reported. */
	taken: number;
};

/**
 * The segments after `cursor` that are wholly before `safeMs`, and the words
 * that start in them. Segment and word times are recording milliseconds
 * from the start of the stream.
 */
export function planStreamReport(options: {
	segments: readonly FedSegment[];
	cursor: number;
	safeMs: number;
	words: readonly StreamWord[];
}): StreamReport | null {
	const pending = options.segments.filter(
		(segment) => segment.index > options.cursor,
	);
	const first = pending[0];
	if (!first) return null;
	let last: FedSegment | null = null;
	for (const segment of pending) {
		if (segment.endMs > options.safeMs) break;
		last = segment;
	}
	if (!last) return null;
	const boundary = last.endMs;
	const words: StreamWord[] = [];
	for (const word of options.words) {
		if (word.start >= boundary) break;
		words.push({
			text: word.text,
			start: Math.max(0, word.start - first.startMs),
			end: Math.max(0, word.end - first.startMs),
		});
	}
	return { lastIndex: last.index, words, taken: words.length };
}

/** A queue the Transcribe request pulls audio frames from. */
export class AudioQueue {
	private readonly frames: Uint8Array[] = [];
	private wake: (() => void) | null = null;
	private closed = false;
	/** Milliseconds of audio queued so far: the stream position. */
	queuedMs = 0;

	push(bytes: Uint8Array) {
		if (this.closed || bytes.byteLength === 0) return;
		for (let i = 0; i < bytes.byteLength; i += STREAM.FRAME_BYTES) {
			this.frames.push(bytes.subarray(i, i + STREAM.FRAME_BYTES));
		}
		this.queuedMs += bytes.byteLength / STREAM.BYTES_PER_MS;
		this.wake?.();
	}

	close() {
		this.closed = true;
		this.wake?.();
	}

	get isClosed() {
		return this.closed;
	}

	async *drain(
		onSent: (sentMs: number) => void,
		pace: (sentMs: number) => Promise<void>,
	): AsyncGenerator<Uint8Array> {
		let sentMs = 0;
		for (;;) {
			const frame = this.frames.shift();
			if (frame) {
				await pace(sentMs);
				sentMs += frame.byteLength / STREAM.BYTES_PER_MS;
				onSent(sentMs);
				yield frame;
				continue;
			}
			if (this.closed) return;
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
			this.wake = null;
		}
	}
}

export type PcmDecoder = {
	write(bytes: Uint8Array): void;
	end(): void;
	output: AsyncIterable<Uint8Array>;
	kill(): void;
};

export function ffmpegPcmDecoder(): PcmDecoder {
	const proc = spawn({
		cmd: [
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			// Probing must not wait for megabytes of audio that arrive over minutes.
			"-probesize",
			"32768",
			"-analyzeduration",
			"0",
			"-f",
			"mp4",
			"-i",
			"pipe:0",
			"-vn",
			"-ac",
			"1",
			"-ar",
			String(STREAM.SAMPLE_RATE),
			"-f",
			"s16le",
			"-flush_packets",
			"1",
			"pipe:1",
		],
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});
	return {
		write(bytes) {
			proc.stdin.write(bytes);
			proc.stdin.flush();
		},
		end() {
			proc.stdin.end();
		},
		output: proc.stdout,
		kill() {
			proc.kill();
		},
	};
}

export type StreamTranscriber = (options: {
	audio: AsyncIterable<Uint8Array>;
	languageOptions: string[];
	signal: AbortSignal;
}) => Promise<AsyncIterable<StreamResult[]>>;

const awsTranscriber: StreamTranscriber = async ({
	audio,
	languageOptions,
	signal,
}) => {
	const client = new TranscribeStreamingClient({});
	const languages =
		languageOptions.length === 1
			? { LanguageCode: languageOptions[0] as never }
			: {
					IdentifyLanguage: true,
					LanguageOptions: languageOptions.join(","),
				};
	const response = await client.send(
		new StartStreamTranscriptionCommand({
			...languages,
			MediaEncoding: "pcm",
			MediaSampleRateHertz: STREAM.SAMPLE_RATE,
			EnablePartialResultsStabilization: true,
			PartialResultsStability: "high",
			AudioStream: (async function* () {
				for await (const chunk of audio)
					yield { AudioEvent: { AudioChunk: chunk } };
			})(),
		}),
		{ abortSignal: signal },
	);
	const stream = response.TranscriptResultStream;
	if (!stream) throw new Error("Transcribe returned no result stream");
	return (async function* () {
		for await (const event of stream) {
			const results = event.TranscriptEvent?.Transcript?.Results;
			if (results?.length) yield results as StreamResult[];
		}
	})();
};

export type StreamingSessionDeps = LiveSessionDeps & {
	transcriber?: StreamTranscriber;
	decoder?: () => PcmDecoder;
	now?: () => number;
};

class StreamDesync extends Error {}
class StreamStop extends Error {}

export class StreamingLiveSession extends LiveSession {
	private readonly transcriber: StreamTranscriber;
	private readonly decoder: () => PcmDecoder;
	private readonly now: () => number;
	private progressed = false;

	constructor(request: StartLiveSession, deps: StreamingSessionDeps = {}) {
		super(request, deps);
		this.transcriber = deps.transcriber ?? awsTranscriber;
		this.decoder = deps.decoder ?? ffmpegPcmDecoder;
		this.now = deps.now ?? Date.now;
	}

	protected override async loop(): Promise<string | null> {
		const startedAt = this.now();
		let restarts = 0;
		while (!this.signal.aborted) {
			this.progressed = false;
			try {
				return await this.stream(startedAt);
			} catch (error) {
				if (this.signal.aborted) break;
				if (error instanceof StreamStop) return null;
				console.warn(
					`[live-transcribe] ${this.videoId} stream restarting:`,
					error instanceof Error ? error.message : String(error),
				);
				restarts = this.progressed ? 1 : restarts + 1;
				if (restarts > STREAM.MAX_STREAM_RESTARTS) return "chunk-abandoned";
				await this.sleep(1_000 * restarts, this.signal);
			}
		}
		return null;
	}

	/** One Transcribe stream, starting right after the web app's cursor. */
	private async stream(startedAt: number): Promise<string | null> {
		const asr = this.request.asr;
		if (!("languageOptions" in asr)) {
			throw new Error("No Amazon Transcribe settings");
		}
		const now = this.now;
		const abort = new AbortController();
		const signal = AbortSignal.any([this.signal, abort.signal]);
		const decoder = this.decoder();
		const queue = new AudioQueue();
		const timeline = new StreamTimeline();
		const collector = new StableWordCollector();
		const sent: { at: number; ms: number }[] = [];
		const streamStartedAt = now();
		let lastAudioAt = now();
		let failure: unknown = null;
		let resultsDone = false;

		void (async () => {
			for await (const chunk of decoder.output) {
				lastAudioAt = now();
				queue.push(chunk);
			}
		})()
			.catch((error) => {
				failure ??= error;
			})
			.finally(() => queue.close());

		const pace = async (sentMs: number) => {
			while (
				!signal.aborted &&
				sentMs > (now() - streamStartedAt) * 2 + STREAM.MAX_LEAD_MS
			) {
				await this.sleep(200, signal);
			}
		};
		void this.transcriber({
			audio: queue.drain((ms) => sent.push({ at: now(), ms }), pace),
			languageOptions: asr.languageOptions,
			signal,
		})
			.then(async (results) => {
				for await (const batch of results) {
					for (const result of batch) collector.accept(result);
				}
				resultsDone = true;
			})
			.catch((error) => {
				failure ??= error;
			});

		const settledSentMs = () => {
			const cutoff = now() - STREAM.SILENCE_SETTLE_MS;
			let settled = 0;
			let keepFrom = 0;
			for (const [index, entry] of sent.entries()) {
				if (entry.at > cutoff) break;
				settled = entry.ms;
				keepFrom = index;
			}
			sent.splice(0, keepFrom);
			return settled;
		};

		const segments: FedSegment[] = [];
		let fedIndex = this.state.lastAudioSegmentIndex;
		let fedEndMs = 0;
		let initFed = false;
		let ending = false;
		let lastProgressAt = now();
		let lastReportAttempt = 0;
		let failedReports = 0;

		try {
			while (!signal.aborted) {
				if (failure) throw failure;
				if (now() - startedAt > LIVE.MAX_SESSION_MS) return "session-limit";
				if (this.state.transcribedDurationMs >= STREAM.MAX_TRANSCRIBED_MS) {
					return "budget-exhausted";
				}

				if (!ending && now() - lastAudioAt > STREAM.KEEPALIVE_AFTER_MS) {
					timeline.addSilence(queue.queuedMs, STREAM.KEEPALIVE_MS);
					queue.push(new Uint8Array(STREAM.KEEPALIVE_MS * STREAM.BYTES_PER_MS));
					lastAudioAt = now();
				}

				if (!ending) {
					const manifest = await this.readManifest();
					if (signal.aborted) break;
					const plan = manifest
						? planLiveChunk({
								manifest,
								lastProcessedIndex: fedIndex,
								targetSeconds: 0,
								contextSeconds: 0,
								hasUrl: (index) => String(index) in this.state.urls.segments,
							})
						: ({ action: "wait" } as const);

					if (plan.action === "no-audio" && segments.length === 0) {
						return "no-audio";
					}
					if (plan.action === "done") {
						ending = true;
						decoder.end();
					} else if (plan.action === "chunk") {
						if (!initFed) {
							this.initAudio ??= await this.fetchBytes(
								this.state.urls.audioInit,
							);
							decoder.write(this.initAudio);
							initFed = true;
						}
						for (const entry of plan.entries) {
							decoder.write(await this.segmentBytes(entry));
							const endMs = fedEndMs + Math.round(entry.duration * 1000);
							segments.push({ index: entry.index, startMs: fedEndMs, endMs });
							fedEndMs = endMs;
							fedIndex = entry.index;
						}
						lastProgressAt = now();
					} else if (
						plan.action === "need-urls" &&
						now() - this.lastReportAt > LIVE.POLL_INTERVAL_MS * 5
					) {
						await this.sync();
					}
				}

				const settled = settledSentMs();
				const safeMs = resultsDone
					? Number.POSITIVE_INFINITY
					: timeline.toRecordingMs(collector.unstableFromMs() ?? settled);
				const due =
					resultsDone ||
					now() - lastReportAttempt >= STREAM.MIN_REPORT_INTERVAL_MS;
				const report = due
					? planStreamReport({
							segments,
							cursor: this.state.lastAudioSegmentIndex,
							safeMs,
							words: collector.words.map((word) => ({
								text: word.text,
								start: timeline.toRecordingMs(word.start),
								end: timeline.toRecordingMs(word.end),
							})),
						})
					: null;
				if (report) {
					lastReportAttempt = now();
					const cursor = this.state.lastAudioSegmentIndex;
					const answer = await this.report({
						action: "chunk",
						lastProcessedIndex: cursor,
						lastIndex: report.lastIndex,
						contextFromIndex: null,
						words: report.words.map((word) => ({
							...word,
							confidence: null,
							speaker: null,
						})),
						languageCode: collector.languageCode,
					});
					if (answer === "stop") throw new StreamStop();
					if (answer === "ok") {
						if (this.state.lastAudioSegmentIndex !== report.lastIndex) {
							throw new StreamDesync(
								`web app cursor is ${this.state.lastAudioSegmentIndex}, expected ${report.lastIndex}`,
							);
						}
						collector.words.splice(0, report.taken);
						const keep = segments.findIndex(
							(segment) => segment.index > report.lastIndex,
						);
						segments.splice(0, keep === -1 ? segments.length : keep);
						failedReports = 0;
						this.progressed = true;
						lastProgressAt = now();
						continue;
					}
					failedReports++;
					if (failedReports > LIVE.MAX_CHUNK_ATTEMPTS * 3) {
						throw new Error("Reports keep failing");
					}
				}

				if (resultsDone) {
					if (segments.length > 0) {
						if (!report) throw new Error("Stream ended with audio unreported");
					} else if (ending) {
						return "done";
					} else {
						throw new Error("Transcribe closed the stream");
					}
				}

				if (!ending && now() - lastProgressAt > LIVE.MAX_IDLE_MS) {
					return "stalled";
				}
				if (now() - this.lastReportAt > LIVE.SYNC_INTERVAL_MS) {
					await this.sync();
				}
				await this.sleep(ending ? 200 : LIVE.POLL_INTERVAL_MS, signal);
			}
			return null;
		} finally {
			abort.abort();
			queue.close();
			decoder.kill();
		}
	}

	private async sync() {
		if ((await this.report({ action: "sync" })) === "stop") {
			throw new StreamStop();
		}
	}

	private async segmentBytes(entry: Entry): Promise<Uint8Array> {
		const cached = this.segmentCache.get(entry.index);
		if (cached) return cached;
		const url = this.state.urls.segments[String(entry.index)];
		if (!url) throw new Error(`No URL for segment ${entry.index}`);
		const bytes = await this.fetchBytes(url);
		this.segmentCache.set(entry.index, bytes);
		for (const index of this.segmentCache.keys()) {
			if (index < entry.index - 64) this.segmentCache.delete(index);
		}
		return bytes;
	}
}

export function createLiveSession(
	request: StartLiveSession,
	deps?: StreamingSessionDeps,
): LiveSession {
	return "provider" in request.asr
		? new StreamingLiveSession(request, deps)
		: new LiveSession(request, deps);
}
