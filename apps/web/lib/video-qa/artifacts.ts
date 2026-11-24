export type FrameEntry = { t: number; key: string; keyframe: boolean };

export type FramesIndex = {
	version: 1;
	durationSeconds: number;
	frames: FrameEntry[];
};

export type TimelineSegment = {
	start: number;
	end: number;
	description: string;
	screenText: string[];
};

export type VisualTimeline = {
	version: 1;
	model: string;
	generatedAt: string;
	segments: TimelineSegment[];
};

export const framesIndexKey = (userId: string, videoId: string) =>
	`${userId}/${videoId}/frames.v1.json`;

export const framesPrefix = (userId: string, videoId: string) =>
	`${userId}/${videoId}/frames/v1/`;

export const visualTimelineKey = (userId: string, videoId: string) =>
	`${userId}/${videoId}/visual.timeline.v1.json`;

export const visualTimelineLockKey = (userId: string, videoId: string) =>
	`${userId}/${videoId}/visual.timeline.lock`;

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

function parseJsonObject(raw: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(raw);
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export function parseFramesIndex(raw: string): FramesIndex | null {
	const value = parseJsonObject(raw);
	if (!value || value.version !== 1 || !Array.isArray(value.frames)) {
		return null;
	}

	const frames = value.frames
		.flatMap((entry): FrameEntry[] => {
			if (!entry || typeof entry !== "object") return [];
			const { t, key, keyframe } = entry as Record<string, unknown>;
			if (!isFiniteNumber(t) || typeof key !== "string" || !key) return [];
			return [{ t, key, keyframe: keyframe === true }];
		})
		.sort((a, b) => a.t - b.t);

	return {
		version: 1,
		durationSeconds: isFiniteNumber(value.durationSeconds)
			? value.durationSeconds
			: (frames.at(-1)?.t ?? 0),
		frames,
	};
}

export function parseVisualTimeline(raw: string): VisualTimeline | null {
	const value = parseJsonObject(raw);
	if (!value || value.version !== 1 || !Array.isArray(value.segments)) {
		return null;
	}

	const segments = value.segments.flatMap((entry): TimelineSegment[] => {
		if (!entry || typeof entry !== "object") return [];
		const { start, end, description, screenText } = entry as Record<
			string,
			unknown
		>;
		if (!isFiniteNumber(start) || !isFiniteNumber(end)) return [];
		if (typeof description !== "string" || !description.trim()) return [];
		return [
			{
				start,
				end,
				description,
				screenText: Array.isArray(screenText)
					? screenText.filter(
							(text): text is string => typeof text === "string",
						)
					: [],
			},
		];
	});

	return {
		version: 1,
		model: typeof value.model === "string" ? value.model : "",
		generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : "",
		segments,
	};
}
