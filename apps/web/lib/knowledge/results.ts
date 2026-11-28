import { formatPlayerTime } from "@/lib/player-time";
import type { KnowledgeKind } from "./chunks";
import type { VectorHit } from "./store";

/** What the Knowledge page and the cross-meeting answers show of a hit. */

export type KnowledgeResult = {
	ref: string;
	key: string;
	kind: KnowledgeKind;
	videoId: string;
	label: string;
	snippet: string;
	start: number | null;
	materialId: string | null;
	materialName: string | null;
	page: number | null;
	imageKey: string | null;
	href: string;
};

export type MeetingInfo = {
	videoId: string;
	title: string;
	recordedAt: string;
	durationSeconds: number | null;
};

export type KnowledgeGroup = MeetingInfo & { results: KnowledgeResult[] };

export function knowledgeHref(hit: {
	videoId: string;
	start: number | null;
	materialId: string | null;
	page: number | null;
}): string {
	const base = `/s/${encodeURIComponent(hit.videoId)}`;
	if (hit.materialId) {
		const page = hit.page ? `&page=${hit.page}` : "";
		return `${base}?tab=materials&material=${encodeURIComponent(hit.materialId)}${page}`;
	}
	return hit.start !== null ? `${base}?t=${Math.floor(hit.start)}` : base;
}

export function hitLabel(
	hit: Pick<VectorHit, "kind" | "label" | "materialName">,
) {
	if (hit.materialName) return `《${hit.materialName}》 ${hit.label}`;
	if (hit.kind === "summary") return "Summary";
	if (hit.kind === "chapter") return `Chapter at ${hit.label}`;
	return hit.label;
}

const SNIPPET_CHARS = 280;

export function toResult(hit: VectorHit, ref: string): KnowledgeResult {
	const flat = hit.text.replace(/\s+/g, " ").trim();
	return {
		ref,
		key: hit.key,
		kind: hit.kind,
		videoId: hit.videoId,
		label: hitLabel(hit),
		snippet:
			flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat,
		start: hit.start,
		materialId: hit.materialId,
		materialName: hit.materialName,
		page: hit.page,
		imageKey: hit.imageKey,
		href: knowledgeHref(hit),
	};
}

/** A material page often matches twice (its text and its image); keep the
 * first, which ranks higher. */
const sameSpot = (a: VectorHit, b: VectorHit) =>
	a.videoId === b.videoId &&
	(a.materialId
		? a.materialId === b.materialId && a.page === b.page
		: (a.kind === "frame" || a.kind === "visual") &&
			(b.kind === "frame" || b.kind === "visual") &&
			a.start !== null &&
			b.start !== null &&
			Math.abs(a.start - b.start) < 5);

export function dedupeHits(hits: readonly VectorHit[]): VectorHit[] {
	const kept: VectorHit[] = [];
	for (const hit of hits) {
		if (!kept.some((other) => sameSpot(other, hit))) kept.push(hit);
	}
	return kept;
}

/**
 * Keep hits from meetings the viewer may see, in rank order, grouped by
 * meeting with the best-ranked meeting first.
 */
export function groupResults(
	hits: readonly VectorHit[],
	meetings: ReadonlyMap<string, MeetingInfo>,
	perMeeting = 4,
	refPrefix = "R",
): { groups: KnowledgeGroup[]; results: KnowledgeResult[] } {
	const groups = new Map<string, KnowledgeGroup>();
	const results: KnowledgeResult[] = [];
	for (const hit of dedupeHits(hits)) {
		const meeting = meetings.get(hit.videoId);
		if (!meeting) continue;
		let group = groups.get(hit.videoId);
		if (!group) {
			group = { ...meeting, results: [] };
			groups.set(hit.videoId, group);
		}
		if (group.results.length >= perMeeting) continue;
		const result = toResult(hit, `${refPrefix}${results.length + 1}`);
		group.results.push(result);
		results.push(result);
	}
	return { groups: [...groups.values()], results };
}

/** Results as the cross-meeting answer model sees them. */
export function formatResultsForModel(
	groups: readonly KnowledgeGroup[],
): string {
	if (groups.length === 0) return "No results.";
	return groups
		.map((group) => {
			const header = `Meeting "${group.title}" (videoId ${group.videoId}, recorded ${group.recordedAt.slice(0, 10)}${group.durationSeconds ? `, ${formatPlayerTime(group.durationSeconds)} long` : ""})`;
			const lines = group.results.map((result) => {
				const where = result.materialId
					? `material ${result.materialId} page ${result.page ?? "?"}`
					: result.start !== null
						? `t=${Math.floor(result.start)}s`
						: "whole meeting";
				const image = result.imageKey ? " [has image]" : "";
				return `  [${result.ref}] ${result.kind} · ${result.label} · ${where}${image}: ${result.snippet}`;
			});
			return [header, ...lines].join("\n");
		})
		.join("\n\n");
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The answer cites with cap:// links; turn them into share-page links, and
 * drop the link (keeping its text) when it is malformed.
 */
export function resolveCitationHref(href: string): string | null {
	const match = href.match(
		/^cap:\/\/(video|material)\/([^/?#]+)(?:\/([^/?#]+))?(?:\?(.*))?$/,
	);
	if (!match) return null;
	const [, type, videoId = "", materialId, query = ""] = match;
	if (!ID.test(videoId)) return null;
	const params = new URLSearchParams(query);
	if (type === "video") {
		const raw = params.get("t");
		const t = raw === null ? Number.NaN : Number(raw);
		return knowledgeHref({
			videoId,
			start: Number.isFinite(t) && t >= 0 ? t : null,
			materialId: null,
			page: null,
		});
	}
	if (!materialId || !ID.test(materialId)) return null;
	const page = Number(params.get("page"));
	return knowledgeHref({
		videoId,
		start: null,
		materialId,
		page: Number.isInteger(page) && page > 0 ? page : null,
	});
}
