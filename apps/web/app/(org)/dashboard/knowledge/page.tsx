import { serverEnv } from "@cap/env";
import { KnowledgeClient } from "./KnowledgeClient";

export const metadata = {
	title: "Knowledge - Cap",
	description: "Search and ask across your organization's meetings",
};

export default function KnowledgePage() {
	return (
		<KnowledgeClient enabled={Boolean(serverEnv().KNOWLEDGE_VECTOR_BUCKET)} />
	);
}
