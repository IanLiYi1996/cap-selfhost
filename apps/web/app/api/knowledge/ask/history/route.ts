import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import type { NextRequest } from "next/server";
import {
	knowledgeHistoryBucket,
	knowledgeHistoryKey,
	knowledgeSession,
} from "@/lib/knowledge/session";
import { readText } from "@/lib/video-materials/storage";
import { parseAskHistory } from "@/lib/video-qa/history";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

export const dynamic = "force-dynamic";

export async function GET() {
	const session = await knowledgeSession(await getCurrentUser());
	if (!session.ok) return session.response;
	const bucket = await knowledgeHistoryBucket(session.user, session.orgId);
	const turns = parseAskHistory(
		await readText(bucket, knowledgeHistoryKey(session.orgId, session.user.id)),
	);
	return Response.json(
		{ turns: turns.map(({ role, content }) => ({ role, content })) },
		{ headers: { "Cache-Control": "no-store" } },
	);
}

export async function DELETE(request: NextRequest) {
	const session = await knowledgeSession(
		isCrossSiteCookieWrite(request) ? null : await getCurrentUser(),
	);
	if (!session.ok) return session.response;
	const bucket = await knowledgeHistoryBucket(session.user, session.orgId);
	await bucket
		.deleteObject(knowledgeHistoryKey(session.orgId, session.user.id))
		.pipe(runWorkflowPromise)
		.catch(() => undefined);
	return Response.json({ ok: true });
}
