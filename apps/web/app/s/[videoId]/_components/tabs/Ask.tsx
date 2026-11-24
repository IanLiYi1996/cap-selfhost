"use client";

import { Button } from "@cap/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { splitTimestampCitations } from "@/lib/video-qa/citations";
import { videoStatusQueryOptions } from "@/lib/video-status-query";
import type { VideoData } from "../../types";

type Turn = {
	id: number;
	role: "user" | "assistant";
	content: string;
	error?: boolean;
};

let nextTurnId = 0;

const SUGGESTIONS = [
	"Summarize the key decisions and action items.",
	"What was shown on screen during the demo?",
	"What open questions were left unresolved?",
];

const MAX_QUESTION_LENGTH = 2000;

// Tab content unmounts on every tab switch, so the conversation lives here for
// the life of the page instead of in component state.
const conversations = new Map<string, Turn[]>();

const SEEK_PREFIX = "#t=";

function linkifyCitations(text: string): string {
	return splitTimestampCitations(text)
		.map((part) =>
			part.kind === "text"
				? part.text
				: `[${part.label}](${SEEK_PREFIX}${part.seconds})`,
		)
		.join("");
}

function Answer({
	content,
	onSeek,
}: {
	content: string;
	onSeek?: (time: number) => void;
}) {
	return (
		<div className="text-sm text-gray-12 prose prose-sm prose-gray max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0 prose-strong:text-gray-12 prose-pre:bg-gray-3 prose-pre:text-gray-12">
			<ReactMarkdown
				components={{
					a: ({ href, children }) => {
						if (href?.startsWith(SEEK_PREFIX)) {
							const seconds = Number(href.slice(SEEK_PREFIX.length));
							return (
								<button
									type="button"
									onClick={() => onSeek?.(seconds)}
									className="inline-flex items-center px-1.5 py-0.5 mx-0.5 font-mono text-xs no-underline rounded bg-blue-3 text-blue-11 hover:bg-blue-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
								>
									{children}
								</button>
							);
						}
						return (
							<a href={href} target="_blank" rel="noreferrer noopener">
								{children}
							</a>
						);
					},
				}}
			>
				{linkifyCitations(content)}
			</ReactMarkdown>
		</div>
	);
}

export function Ask({
	data,
	onSeek,
}: {
	data: VideoData;
	onSeek?: (time: number) => void;
}) {
	const user = useCurrentUser();
	const { data: status } = useQuery({
		...videoStatusQueryOptions(data.id),
		enabled: false,
	});
	const transcriptReady =
		(status?.transcriptionStatus ?? data.transcriptionStatus) === "COMPLETE";

	const [turns, setTurnsState] = useState<Turn[]>(
		() => conversations.get(data.id) ?? [],
	);
	const [input, setInput] = useState("");
	const [streaming, setStreaming] = useState(false);
	const [visualNote, setVisualNote] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputId = useId();

	const setTurns = (update: (current: Turn[]) => Turn[]) => {
		setTurnsState((current) => {
			const next = update(current);
			conversations.set(data.id, next);
			return next;
		});
	};

	useEffect(() => () => abortRef.current?.abort(), []);

	const scrollKey = `${turns.length}:${turns.at(-1)?.content.length ?? 0}`;
	useEffect(() => {
		const element = scrollRef.current;
		if (element && scrollKey) element.scrollTop = element.scrollHeight;
	}, [scrollKey]);

	const ask = async (question: string) => {
		const trimmed = question.trim();
		if (!trimmed || streaming) return;

		const history = turns
			.filter((turn) => !turn.error && turn.content)
			.map(({ role, content }) => ({ role, content }));
		setInput("");
		setTurns((current) => [
			...current,
			{ id: nextTurnId++, role: "user", content: trimmed },
			{ id: nextTurnId++, role: "assistant", content: "" },
		]);
		setStreaming(true);

		const controller = new AbortController();
		abortRef.current = controller;
		const updateAnswer = (content: string, error = false) =>
			setTurns((current) => {
				const last = current.at(-1);
				return last
					? [...current.slice(0, -1), { ...last, content, error }]
					: current;
			});

		try {
			const response = await fetch(`/api/videos/${data.id}/ask`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question: trimmed, history }),
				signal: controller.signal,
			});

			if (!response.ok || !response.body) {
				const body = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				updateAnswer(body?.error ?? "Something went wrong. Try again.", true);
				return;
			}

			const timelineState = response.headers.get("X-Visual-Timeline");
			setVisualNote(timelineState === "started" || timelineState === "pending");

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let answer = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				answer += decoder.decode(value, { stream: true });
				updateAnswer(answer);
			}
			answer += decoder.decode();
			updateAnswer(answer || "No answer was returned.", !answer);
		} catch (error) {
			if (controller.signal.aborted) {
				setTurns((current) => {
					const last = current.at(-1);
					return last?.role === "assistant" && !last.content
						? current.slice(0, -2)
						: current;
				});
				return;
			}
			console.error("[ask] request failed", error);
			updateAnswer("The answer was interrupted. Try again.", true);
		} finally {
			abortRef.current = null;
			setStreaming(false);
		}
	};

	if (!user) {
		return (
			<div className="flex flex-col justify-center items-center p-8 h-full text-center">
				<h3 className="text-base font-medium text-gray-12">
					Ask about this video
				</h3>
				<p className="mt-1 text-sm text-gray-10">
					Sign in to ask questions about this video.
				</p>
				<a
					href={`/login?next=${encodeURIComponent(`/s/${data.id}`)}`}
					className="mt-4 text-sm font-medium text-blue-11 hover:text-blue-12"
				>
					Sign in
				</a>
			</div>
		);
	}

	if (!transcriptReady) {
		return (
			<div className="flex flex-col justify-center items-center p-8 h-full text-center">
				<h3 className="text-base font-medium text-gray-12">
					Ask about this video
				</h3>
				<p className="mt-1 text-sm text-gray-10">
					Questions open up once the transcript is ready.
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			<div ref={scrollRef} className="overflow-y-auto flex-1 p-4 space-y-4">
				{turns.length === 0 ? (
					<div className="space-y-3">
						<div className="space-y-1">
							<h3 className="text-base font-medium text-gray-12">
								Ask about this video
							</h3>
							<p className="text-sm text-gray-10">
								Answers come from what was said and shown, with timestamps you
								can click to jump to.
							</p>
						</div>
						<div className="flex flex-col gap-2">
							{SUGGESTIONS.map((suggestion) => (
								<button
									type="button"
									key={suggestion}
									onClick={() => ask(suggestion)}
									className="px-3 py-2 text-sm text-left rounded-lg border transition-colors border-gray-5 text-gray-11 hover:bg-gray-2 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
								>
									{suggestion}
								</button>
							))}
						</div>
					</div>
				) : (
					turns.map((turn) =>
						turn.role === "user" ? (
							<div
								key={turn.id}
								className="ml-8 px-3 py-2 text-sm whitespace-pre-wrap rounded-lg bg-gray-3 text-gray-12"
							>
								{turn.content}
							</div>
						) : (
							<div
								key={turn.id}
								className={turn.error ? "text-sm text-red-500" : undefined}
							>
								{turn.error ? (
									turn.content
								) : turn.content ? (
									<Answer content={turn.content} onSeek={onSeek} />
								) : (
									<p className="text-sm animate-pulse text-gray-10">
										Watching the video…
									</p>
								)}
							</div>
						),
					)
				)}
				{visualNote && (
					<p className="text-xs text-gray-10">
						Screen understanding for this video is still being prepared, so
						answers rely more on the transcript for now.
					</p>
				)}
			</div>
			<form
				className="flex-none p-3 border-t border-gray-5"
				onSubmit={(event) => {
					event.preventDefault();
					void ask(input);
				}}
			>
				<label htmlFor={inputId} className="sr-only">
					Ask a question about this video
				</label>
				<textarea
					id={inputId}
					value={input}
					maxLength={MAX_QUESTION_LENGTH}
					rows={2}
					placeholder="Ask a question about this video"
					onChange={(event) => setInput(event.target.value)}
					onKeyDown={(event) => {
						if (
							event.key === "Enter" &&
							!event.shiftKey &&
							!event.nativeEvent.isComposing
						) {
							event.preventDefault();
							void ask(input);
						}
					}}
					className="block w-full px-3 py-2 text-sm rounded-lg border resize-none border-gray-5 bg-gray-1 text-gray-12 placeholder:text-gray-9 focus:outline-none focus:ring-2 focus:ring-blue-9"
				/>
				<div className="flex gap-2 justify-end mt-2">
					{streaming ? (
						<Button
							type="button"
							variant="gray"
							size="sm"
							onClick={() => abortRef.current?.abort()}
						>
							Stop
						</Button>
					) : (
						<Button
							type="submit"
							variant="dark"
							size="sm"
							disabled={!input.trim()}
						>
							Ask
						</Button>
					)}
				</div>
			</form>
		</div>
	);
}
