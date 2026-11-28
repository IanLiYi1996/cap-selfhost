"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, useEffect, useId, useRef, useState } from "react";
import { useCurrentUser } from "@/app/Layout/AuthContext";

export type Material = {
	id: string;
	name: string;
	kind: string;
	size: number;
	uploadedAt: string;
	uploadedBy: string | null;
	textChars: number;
	status: "processing" | "ready" | "failed";
	pageCount: number | null;
	hasImages: boolean;
};

type MaterialPageView = {
	n: number;
	label: string;
	text: string;
	outline: string;
	imageUrl: string | null;
};

type MaterialsResponse = { canManage: boolean; materials: Material[] };

type UploadResult = { name: string; ok: boolean; error?: string };

const ACCEPT =
	".pdf,.docx,.pptx,.xlsx,.html,.htm,.md,.markdown,.txt,.csv,.tsv,.json";

const KIND_LABELS: Record<string, string> = {
	pdf: "PDF",
	docx: "Word",
	pptx: "PowerPoint",
	xlsx: "Excel",
	html: "HTML",
	text: "Text",
};

const formatSize = (bytes: number) =>
	bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(1)} MB`
		: `${Math.max(1, Math.round(bytes / 1024))} KB`;

const formatDate = (iso: string) => {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
};

export const materialsQueryKey = (videoId: string) => [
	"videoMaterials",
	videoId,
];

export function useMaterials(videoId: string, enabled = true) {
	return useQuery({
		queryKey: materialsQueryKey(videoId),
		queryFn: async (): Promise<MaterialsResponse> => {
			const response = await fetch(`/api/videos/${videoId}/materials`);
			if (!response.ok) throw new Error("Could not load materials");
			return response.json();
		},
		enabled,
		// Rendering and reading pages takes a minute or two after upload.
		refetchInterval: (query) =>
			query.state.data?.materials.some((m) => m.status === "processing")
				? 5_000
				: false,
	});
}

function KindBadge({ kind }: { kind: string }) {
	return (
		<span className="inline-flex flex-none justify-center items-center px-1.5 h-5 text-[10px] font-semibold uppercase rounded bg-gray-3 text-gray-11 min-w-12">
			{KIND_LABELS[kind] ?? kind}
		</span>
	);
}

function StatusNote({ material }: { material: Material }) {
	if (material.status === "processing") {
		return (
			<span className="text-[11px] font-medium text-blue-11 animate-pulse">
				Reading pages…
			</span>
		);
	}
	if (material.status === "failed") {
		return (
			<span className="text-[11px] font-medium text-red-500">
				No text could be read
			</span>
		);
	}
	return null;
}

function MaterialDetail({
	videoId,
	material,
	canManage,
	busy,
	initialPage,
	onBack,
	onRemove,
}: {
	videoId: string;
	material: Material;
	canManage: boolean;
	busy: boolean;
	initialPage?: number;
	onBack: () => void;
	onRemove: (material: Material) => void;
}) {
	const { data, isLoading, isError } = useQuery({
		queryKey: ["videoMaterialPages", videoId, material.id, material.status],
		queryFn: async (): Promise<{ pages: MaterialPageView[] }> => {
			const response = await fetch(
				`/api/videos/${videoId}/materials/${material.id}/text`,
			);
			if (!response.ok) throw new Error("Could not load the material");
			return response.json();
		},
		// Page image URLs are signed for a limited time.
		staleTime: 10 * 60 * 1000,
	});
	const scrollRef = useRef<HTMLDivElement>(null);
	const pageCount = data?.pages.length ?? 0;
	useEffect(() => {
		if (!initialPage || pageCount === 0) return;
		scrollRef.current
			?.querySelector(`[data-page="${initialPage}"]`)
			?.scrollIntoView({ block: "start" });
	}, [initialPage, pageCount]);

	return (
		<div className="flex flex-col h-full">
			<div className="flex-none px-4 py-3 space-y-2 border-b border-gray-5">
				<button
					type="button"
					onClick={onBack}
					className="text-xs font-medium text-gray-10 hover:text-gray-12"
				>
					← All materials
				</button>
				<div className="flex gap-2 items-start">
					<KindBadge kind={material.kind} />
					<h3 className="text-sm font-medium break-all text-gray-12">
						{material.name}
					</h3>
				</div>
				<p className="text-xs text-gray-10">
					{formatSize(material.size)}
					{material.pageCount ? ` · ${material.pageCount} pages` : ""}
					{material.uploadedBy ? ` · ${material.uploadedBy}` : ""} ·{" "}
					{formatDate(material.uploadedAt)}
				</p>
				<StatusNote material={material} />
				<div className="flex gap-2">
					<a
						href={`/api/videos/${videoId}/materials/${material.id}`}
						className="inline-flex items-center px-3 py-1 text-xs font-medium rounded-lg border border-gray-5 text-gray-12 hover:bg-gray-2"
					>
						Download original
					</a>
					{canManage && (
						<button
							type="button"
							onClick={() => onRemove(material)}
							disabled={busy}
							className="inline-flex items-center px-3 py-1 text-xs font-medium text-red-500 rounded-lg border border-gray-5 hover:bg-gray-2 disabled:opacity-50"
						>
							Remove
						</button>
					)}
				</div>
			</div>
			<div ref={scrollRef} className="overflow-y-auto flex-1 px-4 py-3">
				<p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-9">
					What the AI reads, page by page
				</p>
				{isLoading ? (
					<p className="text-sm animate-pulse text-gray-10">Loading…</p>
				) : isError ? (
					<p className="text-sm text-red-500">
						Could not load this material. Try again.
					</p>
				) : pageCount === 0 ? (
					<p className="text-sm text-gray-10">
						{material.status === "processing"
							? "The pages are still being read."
							: "No text was found in this material."}
					</p>
				) : (
					<ol className="space-y-4">
						{data?.pages.map((page) => (
							<li
								key={page.n}
								data-page={page.n}
								className="pb-4 space-y-2 border-b border-gray-4 last:border-b-0"
							>
								<div className="flex gap-2 items-baseline">
									<span className="text-xs font-semibold text-gray-12">
										{page.label}
									</span>
									{page.outline && (
										<span className="text-xs text-gray-10">{page.outline}</span>
									)}
								</div>
								{page.imageUrl && (
									<a href={page.imageUrl} target="_blank" rel="noreferrer">
										<img
											src={page.imageUrl}
											alt={`${material.name} ${page.label}`}
											loading="lazy"
											className="w-full rounded-lg border border-gray-4"
										/>
									</a>
								)}
								<pre className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap break-words text-gray-12">
									{page.text}
								</pre>
							</li>
						))}
					</ol>
				)}
			</div>
		</div>
	);
}

export function Materials({
	videoId,
	initialMaterialId,
	initialPage,
}: {
	videoId: string;
	initialMaterialId?: string;
	initialPage?: number;
}) {
	const user = useCurrentUser();
	const queryClient = useQueryClient();
	const { data, isLoading, isError } = useMaterials(videoId, Boolean(user));
	const [selectedId, setSelectedId] = useState<string | null>(
		initialMaterialId ?? null,
	);
	const [busy, setBusy] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [errors, setErrors] = useState<string[]>([]);
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();

	const materials = data?.materials ?? [];
	const canManage = data?.canManage ?? false;
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: materialsQueryKey(videoId) });

	const upload = async (files: File[]) => {
		if (files.length === 0 || busy) return;
		setBusy(true);
		setErrors([]);
		const form = new FormData();
		for (const file of files) form.append("file", file);
		try {
			const response = await fetch(`/api/videos/${videoId}/materials`, {
				method: "POST",
				body: form,
			});
			const body = (await response.json().catch(() => null)) as {
				results?: UploadResult[];
				error?: string;
			} | null;
			if (body?.results) {
				setErrors(
					body.results
						.filter((result) => !result.ok)
						.map((result) => result.error ?? `${result.name} failed`),
				);
			} else if (!response.ok) {
				setErrors([body?.error ?? "Upload failed. Try again."]);
			}
		} catch {
			setErrors(["Upload failed. Check your connection and try again."]);
		} finally {
			setBusy(false);
			if (inputRef.current) inputRef.current.value = "";
			await refresh();
		}
	};

	const remove = async (material: Material) => {
		if (!window.confirm(`Remove ${material.name}?`)) return;
		setBusy(true);
		try {
			await fetch(`/api/videos/${videoId}/materials/${material.id}`, {
				method: "DELETE",
			});
			setSelectedId(null);
		} finally {
			setBusy(false);
			await refresh();
		}
	};

	const onDrop = (event: DragEvent<HTMLLabelElement>) => {
		event.preventDefault();
		setDragging(false);
		void upload(Array.from(event.dataTransfer.files));
	};

	if (!user) {
		return (
			<div className="flex flex-col justify-center items-center p-8 h-full text-center">
				<h3 className="text-base font-medium text-gray-12">
					Meeting materials
				</h3>
				<p className="mt-1 text-sm text-gray-10">
					Sign in to see the documents shared for this meeting.
				</p>
			</div>
		);
	}

	const selected = materials.find((material) => material.id === selectedId);
	if (selected) {
		return (
			<MaterialDetail
				videoId={videoId}
				material={selected}
				canManage={canManage}
				busy={busy}
				initialPage={
					selected.id === initialMaterialId ? initialPage : undefined
				}
				onBack={() => setSelectedId(null)}
				onRemove={remove}
			/>
		);
	}

	return (
		<div className="overflow-y-auto p-4 space-y-4 h-full">
			<div className="space-y-1">
				<h3 className="text-base font-medium text-gray-12">
					Meeting materials
				</h3>
				<p className="text-sm text-gray-10">
					Documents for this meeting. Ask answers from them together with the
					recording, and they stay here for everyone who can watch it.
				</p>
			</div>

			{canManage && (
				<div>
					<label
						htmlFor={inputId}
						onDragOver={(event) => {
							event.preventDefault();
							setDragging(true);
						}}
						onDragLeave={() => setDragging(false)}
						onDrop={onDrop}
						className={`flex flex-col justify-center items-center px-4 py-6 text-center rounded-xl border-2 border-dashed cursor-pointer transition-colors ${
							dragging
								? "border-blue-9 bg-blue-3"
								: "border-gray-5 hover:bg-gray-2"
						} ${busy ? "opacity-60 pointer-events-none" : ""}`}
					>
						<span className="text-sm font-medium text-gray-12">
							{busy
								? "Uploading and reading…"
								: "Drop files or click to upload"}
						</span>
						<span className="mt-1 text-xs text-gray-10">
							PDF, Word, PowerPoint, Excel, HTML, Markdown, text, CSV or JSON ·
							up to 25 MB each
						</span>
					</label>
					<input
						id={inputId}
						ref={inputRef}
						type="file"
						multiple
						accept={ACCEPT}
						className="sr-only"
						disabled={busy}
						onChange={(event) => upload(Array.from(event.target.files ?? []))}
					/>
				</div>
			)}

			{errors.length > 0 && (
				<div className="space-y-1">
					{errors.map((error) => (
						<p key={error} className="text-xs text-red-500">
							{error}
						</p>
					))}
				</div>
			)}

			{isLoading ? (
				<p className="text-sm animate-pulse text-gray-10">Loading…</p>
			) : isError ? (
				<p className="text-sm text-red-500">
					Could not load materials. Refresh to try again.
				</p>
			) : materials.length === 0 ? (
				<p className="text-sm text-gray-10">
					{canManage
						? "No materials yet."
						: "No materials have been added to this meeting."}
				</p>
			) : (
				<ul className="space-y-2">
					{materials.map((material) => (
						<li key={material.id}>
							<button
								type="button"
								onClick={() => setSelectedId(material.id)}
								className="flex gap-3 items-start p-3 w-full text-left rounded-xl border transition-colors border-gray-5 hover:bg-gray-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
							>
								<KindBadge kind={material.kind} />
								<span className="flex-1 min-w-0">
									<span className="block text-sm font-medium truncate text-gray-12">
										{material.name}
									</span>
									<span className="block mt-0.5 text-xs text-gray-10">
										{formatSize(material.size)}
										{material.pageCount ? ` · ${material.pageCount} pages` : ""}
										{material.uploadedBy ? ` · ${material.uploadedBy}` : ""} ·{" "}
										{formatDate(material.uploadedAt)}
									</span>
									<StatusNote material={material} />
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
