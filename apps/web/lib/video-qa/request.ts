export type AskTurn = { role: "user" | "assistant"; content: string };
export type AskRequest = { question: string; history: AskTurn[] };

export const MAX_QUESTION_LENGTH = 2000;
const MAX_HISTORY_TURNS = 10;
const MAX_HISTORY_CONTENT_LENGTH = 8000;

export function parseAskRequest(
	payload: unknown,
): AskRequest | { error: string } {
	const body =
		payload && typeof payload === "object"
			? (payload as Record<string, unknown>)
			: {};
	const question =
		typeof body.question === "string" ? body.question.trim() : "";
	if (!question || question.length > MAX_QUESTION_LENGTH) {
		return {
			error: `Ask a question of 1 to ${MAX_QUESTION_LENGTH} characters.`,
		};
	}

	const history = Array.isArray(body.history)
		? body.history
				.flatMap((entry): AskTurn[] => {
					if (!entry || typeof entry !== "object") return [];
					const { role, content } = entry as Record<string, unknown>;
					if (role !== "user" && role !== "assistant") return [];
					if (typeof content !== "string" || !content.trim()) return [];
					return [
						{ role, content: content.slice(0, MAX_HISTORY_CONTENT_LENGTH) },
					];
				})
				.slice(-MAX_HISTORY_TURNS * 2)
		: [];

	while (history[0]?.role === "assistant") history.shift();
	return { question, history };
}
