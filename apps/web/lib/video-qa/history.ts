export type StoredTurn = {
	role: "user" | "assistant";
	content: string;
	at: string;
};

/** Thirty question-and-answer pairs; the model still only sees the last ten. */
export const MAX_STORED_TURNS = 60;

export const askHistoryKey = (
	ownerId: string,
	videoId: string,
	userId: string,
) => `${ownerId}/${videoId}/ask-history/${userId}.v1.json`;

export function parseAskHistory(raw: string | null): StoredTurn[] {
	if (!raw) return [];
	try {
		const value = JSON.parse(raw) as { turns?: unknown };
		if (!Array.isArray(value.turns)) return [];
		return value.turns.flatMap((turn): StoredTurn[] => {
			if (!turn || typeof turn !== "object") return [];
			const { role, content, at } = turn as Record<string, unknown>;
			if (role !== "user" && role !== "assistant") return [];
			if (typeof content !== "string" || !content.trim()) return [];
			return [{ role, content, at: typeof at === "string" ? at : "" }];
		});
	} catch {
		return [];
	}
}

export function appendHistory(
	raw: string | null,
	question: string,
	answer: string,
	at: string,
): string {
	const turns = [
		...parseAskHistory(raw),
		{ role: "user" as const, content: question, at },
		{ role: "assistant" as const, content: answer, at },
	].slice(-MAX_STORED_TURNS);
	while (turns[0]?.role === "assistant") turns.shift();
	return JSON.stringify({ version: 1, turns });
}
