"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";

type Material = {
	id: string;
	name: string;
	kind: string;
	size: number;
	uploadedAt: string;
};

type MaterialsResponse = { canManage: boolean; materials: Material[] };

type UploadResult = { name: string; ok: boolean; error?: string };

const ACCEPT =
	".pdf,.docx,.pptx,.xlsx,.html,.htm,.md,.markdown,.txt,.csv,.tsv,.json";

const formatSize = (bytes: number) =>
	bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(1)} MB`
		: `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function AskMaterials({ videoId }: { videoId: string }) {
	const queryClient = useQueryClient();
	const queryKey = ["videoMaterials", videoId];
	const { data, isLoading } = useQuery({
		queryKey,
		queryFn: async (): Promise<MaterialsResponse> => {
			const response = await fetch(`/api/videos/${videoId}/materials`);
			if (!response.ok) throw new Error("Could not load materials");
			return response.json();
		},
	});
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<string[]>([]);
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();

	const materials = data?.materials ?? [];
	const refresh = () => queryClient.invalidateQueries({ queryKey });

	const upload = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setBusy(true);
		setErrors([]);
		const form = new FormData();
		for (const file of Array.from(files)) form.append("file", file);
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
		} finally {
			setBusy(false);
			await refresh();
		}
	};

	if (isLoading) return null;
	if (!data?.canManage && materials.length === 0) return null;

	return (
		<div className="flex-none border-b border-gray-5">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="flex justify-between items-center px-4 py-2 w-full text-xs font-medium text-left text-gray-11 hover:bg-gray-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
			>
				<span>
					Meeting materials
					{materials.length > 0 ? ` (${materials.length})` : ""}
				</span>
				<span aria-hidden>{open ? "−" : "+"}</span>
			</button>
			{open && (
				<div className="px-4 pb-3 space-y-2">
					<p className="text-xs text-gray-10">
						Answers use these documents together with the recording.
					</p>
					{materials.length > 0 && (
						<ul className="space-y-1">
							{materials.map((material) => (
								<li
									key={material.id}
									className="flex gap-2 justify-between items-center text-sm"
								>
									<a
										href={`/api/videos/${videoId}/materials/${material.id}`}
										className="truncate text-gray-12 hover:text-blue-11 hover:underline"
										title={material.name}
									>
										{material.name}
									</a>
									<span className="flex flex-none gap-2 items-center text-xs text-gray-10">
										{formatSize(material.size)}
										{data?.canManage && (
											<button
												type="button"
												onClick={() => remove(material)}
												disabled={busy}
												className="text-gray-10 hover:text-red-500 disabled:opacity-50"
												aria-label={`Remove ${material.name}`}
											>
												Remove
											</button>
										)}
									</span>
								</li>
							))}
						</ul>
					)}
					{data?.canManage && (
						<div>
							<label
								htmlFor={inputId}
								className={`inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-lg border cursor-pointer border-gray-5 text-gray-12 hover:bg-gray-2 ${busy ? "opacity-50 pointer-events-none" : ""}`}
							>
								{busy ? "Uploading…" : "Add materials"}
							</label>
							<input
								id={inputId}
								ref={inputRef}
								type="file"
								multiple
								accept={ACCEPT}
								className="sr-only"
								disabled={busy}
								onChange={(event) => upload(event.target.files)}
							/>
							<p className="mt-1 text-xs text-gray-9">
								PDF, Word, PowerPoint, Excel, HTML, Markdown, text, CSV or JSON,
								up to 25 MB each.
							</p>
						</div>
					)}
					{errors.map((error) => (
						<p key={error} className="text-xs text-red-500">
							{error}
						</p>
					))}
				</div>
			)}
		</div>
	);
}
