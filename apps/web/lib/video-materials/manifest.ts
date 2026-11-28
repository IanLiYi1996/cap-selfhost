import type { MaterialKind } from "./extract";

export type MaterialEntry = {
	id: string;
	name: string;
	kind: MaterialKind;
	size: number;
	uploadedAt: string;
	uploadedBy: string;
	textChars: number;
	/** Absent on materials uploaded before page rendering, which are ready. */
	status?: MaterialStatus;
	pageCount?: number;
	hasImages?: boolean;
};

export type MaterialStatus = "processing" | "ready" | "failed";

export type MaterialsManifest = { version: 1; materials: MaterialEntry[] };

export const MAX_MATERIALS = 100;
export const MAX_MATERIAL_BYTES = 25 * 1024 * 1024;
// Past MATERIALS_FULL_TEXT_BUDGET the Q&A model reads materials page by page
// instead of in full, so this only bounds storage and indexing.
export const MAX_MATERIAL_TEXT_CHARS = 5_000_000;

export const materialsManifestKey = (ownerId: string, videoId: string) =>
	`${ownerId}/${videoId}/materials.v1.json`;

export const materialTextKey = (ownerId: string, videoId: string, id: string) =>
	`${ownerId}/${videoId}/materials/${id}/text.txt`;

export function safeFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	const cleaned = base
		.replace(/\s+/g, "_")
		.replace(/[^\p{L}\p{N}._-]/gu, "_")
		.replace(/^\.+/, "")
		.slice(-120);
	return cleaned || "file";
}

export const materialFileKey = (
	ownerId: string,
	videoId: string,
	id: string,
	name: string,
) => `${ownerId}/${videoId}/materials/${id}/${safeFileName(name)}`;

const KINDS = new Set<MaterialKind>([
	"pdf",
	"docx",
	"pptx",
	"xlsx",
	"html",
	"text",
]);

export function parseMaterialsManifest(raw: string | null): MaterialsManifest {
	if (!raw) return { version: 1, materials: [] };
	try {
		const value = JSON.parse(raw) as { materials?: unknown };
		const materials = Array.isArray(value.materials)
			? value.materials.filter(
					(m): m is MaterialEntry =>
						!!m &&
						typeof m === "object" &&
						typeof (m as MaterialEntry).id === "string" &&
						typeof (m as MaterialEntry).name === "string" &&
						KINDS.has((m as MaterialEntry).kind) &&
						typeof (m as MaterialEntry).textChars === "number",
				)
			: [];
		return { version: 1, materials };
	} catch {
		return { version: 1, materials: [] };
	}
}

export type AddResult =
	| { ok: true; manifest: MaterialsManifest }
	| { ok: false; reason: "too_many" | "too_much_text" };

export function addMaterial(
	manifest: MaterialsManifest,
	entry: MaterialEntry,
): AddResult {
	const others = manifest.materials.filter((m) => m.id !== entry.id);
	if (others.length >= MAX_MATERIALS) return { ok: false, reason: "too_many" };
	const total =
		others.reduce((sum, m) => sum + m.textChars, 0) + entry.textChars;
	if (total > MAX_MATERIAL_TEXT_CHARS) {
		return { ok: false, reason: "too_much_text" };
	}
	return { ok: true, manifest: { version: 1, materials: [...others, entry] } };
}

export function removeMaterial(manifest: MaterialsManifest, id: string) {
	const removed = manifest.materials.find((m) => m.id === id) ?? null;
	return {
		removed,
		manifest: {
			version: 1 as const,
			materials: manifest.materials.filter((m) => m.id !== id),
		},
	};
}
