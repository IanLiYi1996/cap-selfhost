import type { FrameEntry, FramesIndex, TimelineSegment } from "./artifacts";

export type TimelineBatch = {
	start: number;
	end: number;
	frames: FrameEntry[];
};

const MAX_SCREEN_TEXT_ITEMS = 20;
const MAX_FALLBACK_DESCRIPTION = 1000;

export function planTimelineBatches(
	index: FramesIndex,
	options: { maxFrames?: number; maxWindowSeconds?: number } = {},
): TimelineBatch[] {
	const maxFrames = options.maxFrames ?? 10;
	const maxWindowSeconds = options.maxWindowSeconds ?? 300;
	const keyframes = index.frames.filter((frame) => frame.keyframe);

	const groups: FrameEntry[][] = [];
	for (const frame of keyframes) {
		const current = groups.at(-1);
		const first = current?.[0];
		if (
			!current ||
			!first ||
			current.length >= maxFrames ||
			frame.t - first.t >= maxWindowSeconds
		) {
			groups.push([frame]);
		} else {
			current.push(frame);
		}
	}

	return groups.map((frames, i) => ({
		start: i === 0 ? 0 : (frames[0]?.t ?? 0),
		end:
			groups[i + 1]?.[0]?.t ??
			Math.max(index.durationSeconds, frames.at(-1)?.t ?? 0),
		frames,
	}));
}

function spread<T>(items: T[], count: number): T[] {
	if (items.length <= count) return items;
	if (count <= 1) return items.slice(0, 1);
	const picks = new Set<number>();
	for (let i = 0; i < count; i += 1) {
		picks.add(Math.round((i * (items.length - 1)) / (count - 1)));
	}
	return [...picks].sort((a, b) => a - b).flatMap((i) => items[i] ?? []);
}

export function pickLookAtFrames(
	index: FramesIndex,
	start: number,
	end: number,
	max = 6,
): FrameEntry[] {
	const lo = Math.min(start, end);
	const hi = Math.max(start, end);
	const inRange = index.frames.filter(
		(frame) => frame.t >= lo && frame.t <= hi,
	);
	if (inRange.length > 0) return spread(inRange, max);

	const onScreen = index.frames.filter((frame) => frame.t <= lo).at(-1);
	const fallback = onScreen ?? index.frames[0];
	return fallback ? [fallback] : [];
}

export function extractJsonObject(text: string): unknown {
	const unfenced = text.replace(/```(?:json)?/gi, "");
	const first = unfenced.indexOf("{");
	const last = unfenced.lastIndexOf("}");
	if (first === -1 || last <= first) return null;
	try {
		return JSON.parse(unfenced.slice(first, last + 1));
	} catch {
		return null;
	}
}

const clamp = (value: number, lo: number, hi: number) =>
	Math.min(Math.max(value, lo), hi);

export function parseBatchDescription(
	text: string,
	batch: TimelineBatch,
): TimelineSegment[] {
	const trimmed = text.trim();
	if (!trimmed) return [];

	const parsed = extractJsonObject(trimmed);
	const rawSegments =
		parsed && typeof parsed === "object" && "segments" in parsed
			? (parsed as { segments: unknown }).segments
			: null;

	const segments = Array.isArray(rawSegments)
		? rawSegments.flatMap((entry): TimelineSegment[] => {
				if (!entry || typeof entry !== "object") return [];
				const { start, end, description, screen_text } = entry as Record<
					string,
					unknown
				>;
				if (typeof description !== "string" || !description.trim()) return [];
				const from = clamp(
					typeof start === "number" ? start : batch.start,
					batch.start,
					batch.end,
				);
				const to = clamp(
					typeof end === "number" ? end : batch.end,
					from,
					batch.end,
				);
				const screenText = Array.isArray(screen_text)
					? [
							...new Set(
								screen_text
									.filter((item): item is string => typeof item === "string")
									.map((item) => item.trim())
									.filter(Boolean),
							),
						].slice(0, MAX_SCREEN_TEXT_ITEMS)
					: [];
				return [
					{ start: from, end: to, description: description.trim(), screenText },
				];
			})
		: [];

	if (segments.length > 0) return segments.sort((a, b) => a.start - b.start);

	return [
		{
			start: batch.start,
			end: batch.end,
			description: trimmed.slice(0, MAX_FALLBACK_DESCRIPTION),
			screenText: [],
		},
	];
}

/**
 * Polls for the keyframe index. The task pulls a ~2.5 GB image, downloads the
 * recording and decodes it once at 1 fps, so the floor covers a cold start and
 * the per-second share covers decoding long recordings on 4 vCPU.
 */
export function framesPollAttempts(
	durationSeconds: number,
	intervalMs: number,
): number {
	const budgetMs = 30 * 60 * 1000 + Math.max(0, durationSeconds) * 500;
	return Math.ceil(budgetMs / intervalMs);
}
