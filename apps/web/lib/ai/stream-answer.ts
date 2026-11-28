import type { streamText } from "ai";
import { runWithAiProviders } from "@/lib/ai/run";

type Selection = Parameters<Parameters<typeof runWithAiProviders>[1]>[0];
type StreamResult = ReturnType<typeof streamText>;

const toError = (error: unknown) =>
	error instanceof Error ? error : new Error(String(error));

/**
 * Stream a model's answer as plain text. The stream is read ahead to its
 * first text (past any tool round trips), so a provider that fails before
 * answering falls through to the next one before any byte reaches the client.
 * `onDone` gets the whole answer once it has been sent.
 */
export async function streamAnswer(options: {
	label: string;
	run: (selection: Selection) => StreamResult;
	onDone?: (answer: string) => Promise<void>;
	headers?: Record<string, string>;
}): Promise<Response | null> {
	const upstream = await runWithAiProviders("chat-streaming", (selection) => {
		const reader = options.run(selection).fullStream.getReader();
		const buffered: string[] = [];
		const readAhead = async () => {
			while (buffered.length === 0) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value.type === "error") throw toError(value.error);
				if (value.type === "abort")
					throw new Error(value.reason ?? `${options.label} stream aborted`);
				if (value.type === "text-delta" && value.text)
					buffered.push(value.text);
			}
			if (buffered.length === 0) {
				throw new Error(`${options.label} stream produced no text`);
			}
			return { reader, buffered };
		};
		return readAhead();
	}).catch((error) => {
		console.error(`[${options.label}] upstream error`, error);
		return null;
	});
	if (!upstream) return null;

	const encoder = new TextEncoder();
	let answer = "";
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const text of upstream.buffered) {
				answer += text;
				controller.enqueue(encoder.encode(text));
			}
			const pump = (): Promise<void> =>
				upstream.reader.read().then(async ({ done, value }) => {
					if (done) {
						if (answer.trim()) await options.onDone?.(answer);
						controller.close();
						return;
					}
					if (value.type === "error") throw toError(value.error);
					if (value.type === "abort")
						throw new Error(value.reason ?? `${options.label} stream aborted`);
					if (value.type === "text-delta" && value.text) {
						answer += value.text;
						controller.enqueue(encoder.encode(value.text));
					}
					return pump();
				});
			return pump().catch((error) => controller.error(error));
		},
		cancel(reason) {
			upstream.reader.cancel(reason).catch(() => undefined);
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			...options.headers,
		},
	});
}
