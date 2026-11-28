import { start } from "workflow/api";
import { knowledgeIndexWorkflow } from "@/workflows/knowledge-index";
import { isKnowledgeEnabled } from "./store";

/** Index a meeting again after something it is made of changed. Never
 * throws: a missed run only leaves the index a little behind. */
export async function queueKnowledgeIndex(videoId: string): Promise<void> {
	if (!isKnowledgeEnabled()) return;
	try {
		await start(knowledgeIndexWorkflow, [{ videoId }]);
	} catch (error) {
		console.error(`[knowledge] could not queue indexing for ${videoId}`, error);
	}
}
