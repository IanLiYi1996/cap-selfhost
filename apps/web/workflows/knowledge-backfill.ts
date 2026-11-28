import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { Organisation, Video } from "@cap/web-domain";
import { and, asc, eq, gt } from "drizzle-orm";
import { indexVideoKnowledge } from "@/lib/knowledge/indexer";

interface KnowledgeBackfillPayload {
	orgId: string;
}

const PAGE_SIZE = 50;

/** Index every meeting of an organization, oldest first. Already indexed
 * meetings cost only a read, since only changed chunks are embedded. */
export async function knowledgeBackfillWorkflow(
	payload: KnowledgeBackfillPayload,
) {
	"use workflow";

	let after = "";
	let indexed = 0;
	for (;;) {
		const page = await listMeetings(payload.orgId, after);
		if (page.length === 0) break;
		for (const videoId of page) {
			if (await indexOne(videoId)) indexed += 1;
		}
		after = page.at(-1) ?? after;
		if (page.length < PAGE_SIZE) break;
	}
	return { success: true, message: `${indexed} meetings indexed` };
}

async function listMeetings(orgId: string, after: string): Promise<string[]> {
	"use step";

	const rows = await db()
		.select({ id: videos.id })
		.from(videos)
		.where(
			and(
				eq(videos.orgId, orgId as Organisation.OrganisationId),
				eq(videos.isScreenshot, false),
				after ? gt(videos.id, after as Video.VideoId) : undefined,
			),
		)
		.orderBy(asc(videos.id))
		.limit(PAGE_SIZE);
	return rows.map((row) => row.id as string);
}

async function indexOne(videoId: string): Promise<boolean> {
	"use step";

	try {
		const outcome = await indexVideoKnowledge(videoId);
		if (outcome.status === "indexed") {
			console.log(
				`[knowledge] backfill ${videoId}: ${outcome.embedded} embedded of ${outcome.chunks}`,
			);
			return true;
		}
	} catch (error) {
		console.error(`[knowledge] backfill ${videoId} failed`, error);
	}
	return false;
}
