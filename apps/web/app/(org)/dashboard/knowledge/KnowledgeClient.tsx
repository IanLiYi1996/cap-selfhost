"use client";

import { Button } from "@cap/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { resolveCitationHref } from "@/lib/knowledge/results";

type SearchResult = {
	ref: string;
	kind: string;
	videoId: string;
	label: string;
	snippet: string;
	href: string;
	thumbnailUrl: string | null;
};

type SearchGroup = {
	videoId: string;
	title: string;
	recordedAt: string;
	durationSeconds: number | null;
	results: SearchResult[];
};

type Turn = {
	id: number;
	role: "user" | "assistant";
	content: string;
	error?: boolean;
};

let nextTurnId = 0;

const KIND_LABELS: Record<string, string> = {
	transcript: "Said",
	visual: "On screen",
	frame: "Screen",
	summary: "Summary",
	chapter: "Chapter",
	material: "Document",
	page: "Document page",
};

const FILTERS: { label: string; kinds: string[] }[] = [
	{ label: "Everything", kinds: [] },
	{ label: "What was said", kinds: ["transcript"] },
	{ label: "On screen", kinds: ["visual", "frame"] },
	{ label: "Documents", kinds: ["material", "page"] },
	{ label: "Summaries", kinds: ["summary", "chapter"] },
];

const SUGGESTIONS = [
	"What did we decide about this topic across meetings?",
	"Which meetings discussed the roadmap, and what changed between them?",
	"Find the slide or document that shows the numbers we talked about.",
];

const formatDate = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});

function AnswerMarkdown({ content }: { content: string }) {
	return (
		<div className="text-sm text-gray-12 prose prose-sm prose-gray max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0">
			<ReactMarkdown
				urlTransform={(url) =>
					url.startsWith("cap://") ? url : defaultUrlTransform(url)
				}
				components={{
					a: ({ href, children }) => {
						if (href?.startsWith("cap://")) {
							const resolved = resolveCitationHref(href);
							return resolved ? (
								<Link
									href={resolved}
									className="inline-flex items-center px-1.5 py-0.5 mx-0.5 text-xs no-underline rounded bg-blue-3 text-blue-11 hover:bg-blue-4"
								>
									{children}
								</Link>
							) : (
								<span>{children}</span>
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
				{content}
			</ReactMarkdown>
		</div>
	);
}

function SearchPanel() {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [groups, setGroups] = useState<SearchGroup[] | null>(null);
	const inputId = useId();

	const search = async (event?: React.FormEvent) => {
		event?.preventDefault();
		const trimmed = query.trim();
		if (!trimmed || loading) return;
		setLoading(true);
		setError(null);
		try {
			const response = await fetch("/api/knowledge/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					query: trimmed,
					kinds: FILTERS[filter]?.kinds ?? [],
				}),
			});
			const body = (await response.json().catch(() => null)) as {
				groups?: SearchGroup[];
				error?: string;
			} | null;
			if (!response.ok || !body?.groups) {
				setError(body?.error ?? "Search failed. Try again.");
				return;
			}
			setGroups(body.groups);
		} catch {
			setError("Search failed. Check your connection and try again.");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="space-y-4">
			<form onSubmit={search} className="flex gap-2">
				<label htmlFor={inputId} className="sr-only">
					Search meetings
				</label>
				<input
					id={inputId}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					maxLength={500}
					placeholder="Search what was said, shown or written in any meeting"
					className="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-5 bg-gray-1 text-gray-12 placeholder:text-gray-9 focus:outline-none focus:ring-2 focus:ring-blue-9"
				/>
				<Button
					type="submit"
					variant="dark"
					size="sm"
					disabled={!query.trim() || loading}
				>
					{loading ? "Searching…" : "Search"}
				</Button>
			</form>
			<div className="flex flex-wrap gap-2">
				{FILTERS.map((option, index) => (
					<button
						key={option.label}
						type="button"
						onClick={() => setFilter(index)}
						className={`px-3 py-1 text-xs rounded-full border ${
							filter === index
								? "border-blue-9 bg-blue-3 text-blue-11"
								: "border-gray-5 text-gray-11 hover:bg-gray-2"
						}`}
					>
						{option.label}
					</button>
				))}
			</div>
			{error && <p className="text-sm text-red-500">{error}</p>}
			{groups &&
				(groups.length === 0 ? (
					<p className="text-sm text-gray-10">
						Nothing found in the meetings you can see.
					</p>
				) : (
					<ul className="space-y-4">
						{groups.map((group) => (
							<li
								key={group.videoId}
								className="p-4 space-y-3 rounded-xl border border-gray-5 bg-gray-1"
							>
								<div className="flex gap-2 justify-between items-baseline">
									<Link
										href={`/s/${group.videoId}`}
										className="text-sm font-medium text-gray-12 hover:text-blue-11 hover:underline"
									>
										{group.title}
									</Link>
									<span className="flex-none text-xs text-gray-10">
										{formatDate(group.recordedAt)}
									</span>
								</div>
								<ul className="space-y-2">
									{group.results.map((result) => (
										<li key={result.ref}>
											<Link
												href={result.href}
												className="flex gap-3 items-start p-2 rounded-lg hover:bg-gray-2"
											>
												{result.thumbnailUrl && (
													<img
														src={result.thumbnailUrl}
														alt={result.label}
														loading="lazy"
														className="object-cover flex-none w-32 h-20 rounded border border-gray-4"
													/>
												)}
												<span className="flex-1 min-w-0">
													<span className="flex gap-2 items-center text-xs text-gray-10">
														<span className="px-1.5 py-0.5 font-medium rounded bg-gray-3 text-gray-11">
															{KIND_LABELS[result.kind] ?? result.kind}
														</span>
														{result.label}
													</span>
													<span className="block mt-1 text-sm text-gray-12 line-clamp-3">
														{result.snippet}
													</span>
												</span>
											</Link>
										</li>
									))}
								</ul>
							</li>
						))}
					</ul>
				))}
		</div>
	);
}

function AskPanel() {
	const [turns, setTurns] = useState<Turn[]>([]);
	const [input, setInput] = useState("");
	const [streaming, setStreaming] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const inputId = useId();

	useEffect(() => {
		let cancelled = false;
		fetch("/api/knowledge/ask/history")
			.then((response) => (response.ok ? response.json() : null))
			.then((body: { turns?: Omit<Turn, "id">[] } | null) => {
				if (cancelled || !body?.turns?.length) return;
				setTurns((current) =>
					current.length > 0
						? current
						: (body.turns ?? []).map((turn) => ({
								...turn,
								id: nextTurnId++,
							})),
				);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
			abortRef.current?.abort();
		};
	}, []);

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
		const update = (content: string, error = false) =>
			setTurns((current) => {
				const last = current.at(-1);
				return last
					? [...current.slice(0, -1), { ...last, content, error }]
					: current;
			});
		try {
			const response = await fetch("/api/knowledge/ask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question: trimmed, history }),
				signal: controller.signal,
			});
			if (!response.ok || !response.body) {
				const body = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				update(body?.error ?? "Something went wrong. Try again.", true);
				return;
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let answer = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				answer += decoder.decode(value, { stream: true });
				update(answer);
			}
			answer += decoder.decode();
			update(answer || "No answer was returned.", !answer);
		} catch {
			if (controller.signal.aborted) return;
			update("The answer was interrupted. Try again.", true);
		} finally {
			abortRef.current = null;
			setStreaming(false);
		}
	};

	const clear = async () => {
		if (streaming || !window.confirm("Clear this conversation?")) return;
		setTurns([]);
		await fetch("/api/knowledge/ask/history", { method: "DELETE" }).catch(
			() => undefined,
		);
	};

	return (
		<div className="space-y-4">
			{turns.length === 0 ? (
				<div className="space-y-2">
					<p className="text-sm text-gray-10">
						Ask across every meeting you can see. Answers link to the moment or
						the document page they come from.
					</p>
					<div className="flex flex-col gap-2">
						{SUGGESTIONS.map((suggestion) => (
							<button
								key={suggestion}
								type="button"
								onClick={() => setInput(suggestion)}
								className="px-3 py-2 text-sm text-left rounded-lg border border-gray-5 text-gray-11 hover:bg-gray-2"
							>
								{suggestion}
							</button>
						))}
					</div>
				</div>
			) : (
				<div className="space-y-4">
					{turns.map((turn) =>
						turn.role === "user" ? (
							<div
								key={turn.id}
								className="px-3 py-2 ml-12 text-sm whitespace-pre-wrap rounded-lg bg-gray-3 text-gray-12"
							>
								{turn.content}
							</div>
						) : (
							<div key={turn.id}>
								{turn.error ? (
									<p className="text-sm text-red-500">{turn.content}</p>
								) : turn.content ? (
									<AnswerMarkdown content={turn.content} />
								) : (
									<p className="text-sm animate-pulse text-gray-10">
										Searching your meetings…
									</p>
								)}
							</div>
						),
					)}
				</div>
			)}
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void ask(input);
				}}
			>
				<label htmlFor={inputId} className="sr-only">
					Ask about your meetings
				</label>
				<textarea
					id={inputId}
					value={input}
					rows={3}
					maxLength={2000}
					placeholder="Ask about your meetings"
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
					className="block px-3 py-2 w-full text-sm rounded-lg border resize-none border-gray-5 bg-gray-1 text-gray-12 placeholder:text-gray-9 focus:outline-none focus:ring-2 focus:ring-blue-9"
				/>
				<div className="flex gap-2 justify-end items-center mt-2">
					{turns.length > 0 && !streaming && (
						<button
							type="button"
							onClick={clear}
							className="mr-auto text-xs text-gray-10 hover:text-gray-12"
						>
							Clear conversation
						</button>
					)}
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

function BackfillNotice() {
	const { data } = useQuery({
		queryKey: ["knowledgeBackfill"],
		queryFn: async (): Promise<{ canBackfill: boolean }> => {
			const response = await fetch("/api/knowledge/backfill");
			return response.ok ? response.json() : { canBackfill: false };
		},
	});
	const [state, setState] = useState<"idle" | "busy" | "started" | "error">(
		"idle",
	);
	if (!data?.canBackfill) return null;

	const start = async () => {
		setState("busy");
		const response = await fetch("/api/knowledge/backfill", {
			method: "POST",
		}).catch(() => null);
		setState(response?.ok ? "started" : "error");
	};

	return (
		<div className="flex flex-wrap gap-3 justify-between items-center p-3 text-xs rounded-lg border border-gray-5 text-gray-10">
			<span>
				{state === "started"
					? "Indexing has started. Existing meetings become searchable over the next minutes."
					: state === "error"
						? "Could not start indexing. Try again."
						: "New meetings are indexed automatically. Meetings from before this feature need indexing once."}
			</span>
			{state !== "started" && (
				<Button
					type="button"
					variant="gray"
					size="sm"
					disabled={state === "busy"}
					onClick={start}
				>
					Index existing meetings
				</Button>
			)}
		</div>
	);
}

export function KnowledgeClient({ enabled }: { enabled: boolean }) {
	const [mode, setMode] = useState<"ask" | "search">("ask");

	if (!enabled) {
		return (
			<div className="p-8 text-sm text-gray-10">
				Knowledge search is not set up on this instance.
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6 mx-auto w-full max-w-3xl">
			<div className="space-y-1">
				<h1 className="text-xl font-medium text-gray-12">Knowledge</h1>
				<p className="text-sm text-gray-10">
					Everything said, shown and shared in your organization's meetings. You
					only see meetings you can watch.
				</p>
			</div>
			<div className="flex gap-1 p-1 w-fit rounded-lg bg-gray-3">
				{(["ask", "search"] as const).map((option) => (
					<button
						key={option}
						type="button"
						onClick={() => setMode(option)}
						className={`px-4 py-1.5 text-sm rounded-md ${
							mode === option
								? "bg-gray-1 text-gray-12 shadow-sm"
								: "text-gray-10 hover:text-gray-12"
						}`}
					>
						{option === "ask" ? "Ask" : "Search"}
					</button>
				))}
			</div>
			{mode === "ask" ? <AskPanel /> : <SearchPanel />}
			<BackfillNotice />
		</div>
	);
}
