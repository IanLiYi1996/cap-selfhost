import { indexVideoKnowledge } from "@/lib/knowledge/indexer";

interface KnowledgeIndexPayload {
	videoId: string;
}

/** Re-index one meeting for cross-meeting search; see lib/knowledge. */
export async function knowledgeIndexWorkflow(payload: KnowledgeIndexPayload) {
	"use workflow";

	const outcome = await indexMeeting(payload.videoId);
	return { success: outcome.status === "indexed", message: outcome.status };
}

async function indexMeeting(videoId: string) {
	"use step";

	const outcome = await indexVideoKnowledge(videoId);
	if (outcome.status === "indexed") {
		console.log(
			`[knowledge] ${videoId}: ${outcome.chunks} chunks, ${outcome.embedded} embedded, ${outcome.removed} removed, ${outcome.failed} failed`,
		);
	}
	return outcome;
}
