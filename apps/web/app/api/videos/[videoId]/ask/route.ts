import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import type { Video } from "@cap/web-domain";
import { stepCountIs, streamText } from "ai";
import type { NextRequest } from "next/server";
import { isAiConfigured } from "@/lib/ai/provider";
import { runWithAiProviders } from "@/lib/ai/run";
import {
	createLookAtTool,
	loadAskContext,
	parseAskRequest,
} from "@/lib/video-qa/ask";

export const dynamic = "force-dynamic";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 12;
const ANSWER_TIMEOUT_MS = 4 * 60 * 1000;
const ANSWER_MAX_OUTPUT_TOKENS = 8000;
const MAX_STEPS = 5;

const requestLog = new Map<string, number[]>();

function isRateLimited(key: string): boolean {
	const now = Date.now();
	const recent = (requestLog.get(key) ?? []).filter(
		(timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
	);
	const limited = recent.length >= RATE_LIMIT_MAX_REQUESTS;
	if (!limited) recent.push(now);
	requestLog.set(key, recent);
	if (requestLog.size > 5000) {
		for (const [entryKey, timestamps] of requestLog) {
			if (timestamps.every((ts) => now - ts >= RATE_LIMIT_WINDOW_MS)) {
				requestLog.delete(entryKey);
			}
		}
	}
	return limited;
}

const STATUS_ERRORS = {
	not_found: { status: 404, error: "Video not found." },
	disabled: { status: 403, error: "Q&A is turned off for this video." },
	not_ready: {
		status: 409,
		error: "The transcript is not ready yet. Try again once it appears.",
	},
	too_long: {
		status: 413,
		error: "This recording is too long to answer questions about.",
	},
} as const;

function toStreamError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export async function POST(
	request: NextRequest,
	props: RouteContext<"/api/videos/[videoId]/ask">,
) {
	if (!isAiConfigured("chat-streaming")) {
		return Response.json(
			{ error: "Q&A is not available right now." },
			{ status: 503 },
		);
	}

	// Answers run on this deployment's Bedrock account, so only signed-in users
	// can ask, even on a public video; anonymous viewers still watch and read.
	const user = isCrossSiteCookieWrite(request) ? null : await getCurrentUser();
	if (!user) {
		return Response.json(
			{ error: "Sign in to ask questions about this video." },
			{ status: 401 },
		);
	}

	const { videoId } = (await props.params) as { videoId: Video.VideoId };

	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json({ error: "Invalid request." }, { status: 400 });
	}
	const parsed = parseAskRequest(payload);
	if ("error" in parsed) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}

	if (isRateLimited(user.id)) {
		return Response.json(
			{ error: "Too many questions right now. Try again in a minute." },
			{ status: 429 },
		);
	}

	const context = await loadAskContext(videoId);
	if (context.status !== "ok") {
		const { status, error } = STATUS_ERRORS[context.status];
		return Response.json({ error }, { status });
	}

	const tools = context.framesIndex?.frames.length
		? { look_at: createLookAtTool(context.bucket, context.framesIndex) }
		: undefined;
	const abortSignal = AbortSignal.any([
		request.signal,
		AbortSignal.timeout(ANSWER_TIMEOUT_MS),
	]);

	const upstream = await runWithAiProviders("chat-streaming", (selection) => {
		const result = streamText({
			model: selection.model(),
			instructions: context.instructions,
			messages: [...parsed.history, { role: "user", content: parsed.question }],
			maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
			abortSignal,
			...(tools
				? {
						tools,
						stopWhen: stepCountIs(MAX_STEPS),
						...(selection.providerOptions
							? { providerOptions: selection.providerOptions }
							: {}),
					}
				: {}),
			onFinish: ({ totalUsage, steps }) => {
				console.log(
					`[video-qa] ${videoId} ${selection.modelId}: ${steps.length} steps, usage ${JSON.stringify(totalUsage)}`,
				);
			},
		});

		const reader = result.fullStream.getReader();
		const buffered: string[] = [];

		// Read ahead to the first text delta (past any look_at round trips) so
		// a provider that fails before answering falls through to the next one
		// before any bytes reach the client.
		const readAhead = async () => {
			while (buffered.length === 0) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value.type === "error") throw toStreamError(value.error);
				if (value.type === "abort")
					throw new Error(value.reason ?? "video-qa stream aborted");
				if (value.type === "text-delta" && value.text)
					buffered.push(value.text);
			}
			if (buffered.length === 0) {
				throw new Error("video-qa stream produced no text");
			}
			return { reader, buffered };
		};

		return readAhead();
	}).catch((error) => {
		console.error(`[video-qa] ${videoId} upstream error`, error);
		return null;
	});

	if (!upstream) {
		return Response.json(
			{ error: "Q&A is having trouble right now. Try again shortly." },
			{ status: 502 },
		);
	}

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const text of upstream.buffered) {
				controller.enqueue(encoder.encode(text));
			}
			const pump = (): Promise<void> =>
				upstream.reader.read().then(({ done, value }) => {
					if (done) {
						controller.close();
						return;
					}
					if (value.type === "error") throw toStreamError(value.error);
					if (value.type === "abort")
						throw new Error(value.reason ?? "video-qa stream aborted");
					if (value.type === "text-delta" && value.text) {
						controller.enqueue(encoder.encode(value.text));
					}
					return pump();
				});
			return pump().catch((error) => controller.error(error));
		},
		cancel(reason) {
			upstream.reader.cancel(reason).catch(() => undefined);
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Visual-Timeline": context.timelineState,
		},
	});
}
