import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import type { NextRequest } from "next/server";
import { createRateLimiter } from "@/lib/ai/memory-rate-limit";
import { KNOWLEDGE_KINDS, type KnowledgeKind } from "@/lib/knowledge/chunks";
import { searchKnowledge } from "@/lib/knowledge/search";
import { knowledgeSession } from "@/lib/knowledge/session";

export const dynamic = "force-dynamic";

const isRateLimited = createRateLimiter(60_000, 30);

export async function POST(request: NextRequest) {
	const session = await knowledgeSession(
		isCrossSiteCookieWrite(request) ? null : await getCurrentUser(),
	);
	if (!session.ok) return session.response;

	const body = (await request.json().catch(() => null)) as {
		query?: unknown;
		kinds?: unknown;
	} | null;
	const query = typeof body?.query === "string" ? body.query.trim() : "";
	if (!query || query.length > 500) {
		return Response.json(
			{ error: "Type 1 to 500 characters to search." },
			{ status: 400 },
		);
	}
	const kinds = Array.isArray(body?.kinds)
		? body.kinds.filter((kind): kind is KnowledgeKind =>
				KNOWLEDGE_KINDS.includes(kind as KnowledgeKind),
			)
		: undefined;
	if (isRateLimited(session.user.id)) {
		return Response.json(
			{ error: "Too many searches right now. Try again in a minute." },
			{ status: 429 },
		);
	}

	try {
		const { groups } = await searchKnowledge({
			orgId: session.orgId,
			query,
			kinds,
			topK: 80,
			perMeeting: 4,
			withThumbnails: true,
		});
		return Response.json(
			{
				groups: groups.map((group) => ({
					...group,
					results: group.results.map(({ imageKey: _key, ...result }) => result),
				})),
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		console.error("[knowledge] search failed", error);
		return Response.json(
			{ error: "Search is having trouble right now. Try again shortly." },
			{ status: 502 },
		);
	}
}
