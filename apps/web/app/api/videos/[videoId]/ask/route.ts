import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import type { Video } from "@cap/web-domain";
import { stepCountIs, streamText } from "ai";
import type { NextRequest } from "next/server";
import { createRateLimiter } from "@/lib/ai/memory-rate-limit";
import { isAiConfigured } from "@/lib/ai/provider";
import { streamAnswer } from "@/lib/ai/stream-answer";
import { materialSearchFor } from "@/lib/knowledge/material-search";
import { updateJsonObject } from "@/lib/video-materials/storage";
import {
	createLookAtTool,
	loadAskContext,
	parseAskRequest,
} from "@/lib/video-qa/ask";
import { appendHistory, askHistoryKey } from "@/lib/video-qa/history";
import { createMaterialTools } from "@/lib/video-qa/material-tools";

export const dynamic = "force-dynamic";

const ANSWER_TIMEOUT_MS = 4 * 60 * 1000;
const ANSWER_MAX_OUTPUT_TOKENS = 8000;
// Reading materials page by page takes a search, a read or two and maybe a
// look at a page before the answer.
const MAX_STEPS = 8;

const isRateLimited = createRateLimiter(60_000, 12);

const STATUS_ERRORS = {
	not_found: { status: 404, error: "Video not found." },
	disabled: { status: 403, error: "Q&A is turned off for this video." },
	not_ready: {
		status: 409,
		error: "The transcript is not ready yet. Try again once it appears.",
	},
	too_long: {
		status: 413,
		error:
			"This recording and its materials are too long to answer questions about. Remove a large material and try again.",
	},
} as const;

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

	const materialTools = createMaterialTools({
		bucket: context.bucket,
		materials: context.materials,
		context: context.materialsContext,
		search: materialSearchFor(context.video.id),
	});
	const allTools = {
		...(context.framesIndex?.frames.length
			? { look_at: createLookAtTool(context.bucket, context.framesIndex) }
			: {}),
		...materialTools,
	};
	const tools = Object.keys(allTools).length > 0 ? allTools : undefined;
	const abortSignal = AbortSignal.any([
		request.signal,
		AbortSignal.timeout(ANSWER_TIMEOUT_MS),
	]);

	const historyKey = askHistoryKey(context.video.ownerId, videoId, user.id);
	const saveTurn = (answer: string) =>
		updateJsonObject(context.bucket, historyKey, (raw) => ({
			next: JSON.parse(
				appendHistory(raw, parsed.question, answer, new Date().toISOString()),
			),
			result: undefined,
		})).catch((error) => {
			console.error(`[video-qa] ${videoId}: could not save history`, error);
		});

	const response = await streamAnswer({
		label: "video-qa",
		run: (selection) =>
			streamText({
				model: selection.model(),
				instructions: context.instructions,
				messages: [
					...parsed.history,
					{ role: "user", content: parsed.question },
				],
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
			}),
		onDone: saveTurn,
		headers: { "X-Visual-Timeline": context.timelineState },
	});

	return (
		response ??
		Response.json(
			{ error: "Q&A is having trouble right now. Try again shortly." },
			{ status: 502 },
		)
	);
}
