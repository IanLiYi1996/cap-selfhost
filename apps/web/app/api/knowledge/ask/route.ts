import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import { stepCountIs, streamText } from "ai";
import type { NextRequest } from "next/server";
import { createRateLimiter } from "@/lib/ai/memory-rate-limit";
import { isAiConfigured } from "@/lib/ai/provider";
import { streamAnswer } from "@/lib/ai/stream-answer";
import {
	createKnowledgeTools,
	KNOWLEDGE_INSTRUCTIONS,
} from "@/lib/knowledge/agent";
import {
	knowledgeHistoryBucket,
	knowledgeHistoryKey,
	knowledgeSession,
} from "@/lib/knowledge/session";
import { updateJsonObject } from "@/lib/video-materials/storage";
import { appendHistory } from "@/lib/video-qa/history";
import { parseAskRequest } from "@/lib/video-qa/request";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ANSWER_TIMEOUT_MS = 4 * 60 * 1000;
const ANSWER_MAX_OUTPUT_TOKENS = 8000;
// A few searches, reads and a look at images before the answer.
const MAX_STEPS = 12;

const isRateLimited = createRateLimiter(60_000, 8);

export async function POST(request: NextRequest) {
	if (!isAiConfigured("chat-streaming")) {
		return Response.json(
			{ error: "Q&A is not available right now." },
			{ status: 503 },
		);
	}
	const session = await knowledgeSession(
		isCrossSiteCookieWrite(request) ? null : await getCurrentUser(),
	);
	if (!session.ok) return session.response;

	const parsed = parseAskRequest(await request.json().catch(() => null));
	if ("error" in parsed) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}
	if (isRateLimited(session.user.id)) {
		return Response.json(
			{ error: "Too many questions right now. Try again in a minute." },
			{ status: 429 },
		);
	}

	const { user, orgId } = session;
	const tools = createKnowledgeTools(orgId);
	const abortSignal = AbortSignal.any([
		request.signal,
		AbortSignal.timeout(ANSWER_TIMEOUT_MS),
	]);
	const historyBucket = await knowledgeHistoryBucket(user, orgId);
	const historyKey = knowledgeHistoryKey(orgId, user.id);

	const response = await streamAnswer({
		label: "knowledge-qa",
		run: (selection) =>
			streamText({
				model: selection.model(),
				instructions: [
					{
						role: "system",
						content: `${KNOWLEDGE_INSTRUCTIONS}\n\nToday is ${new Date().toISOString().slice(0, 10)}.`,
					},
				],
				messages: [
					...parsed.history,
					{ role: "user", content: parsed.question },
				],
				maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
				abortSignal,
				tools,
				stopWhen: stepCountIs(MAX_STEPS),
				...(selection.providerOptions
					? { providerOptions: selection.providerOptions }
					: {}),
				onFinish: ({ totalUsage, steps }) => {
					console.log(
						`[knowledge-qa] ${orgId} ${selection.modelId}: ${steps.length} steps, usage ${JSON.stringify(totalUsage)}`,
					);
				},
			}),
		onDone: (answer) =>
			updateJsonObject(historyBucket, historyKey, (raw) => ({
				next: JSON.parse(
					appendHistory(raw, parsed.question, answer, new Date().toISOString()),
				),
				result: undefined,
			})).catch((error) =>
				console.error("[knowledge-qa] could not save history", error),
			),
	});

	return (
		response ??
		Response.json(
			{ error: "Q&A is having trouble right now. Try again shortly." },
			{ status: 502 },
		)
	);
}
