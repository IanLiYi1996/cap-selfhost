import {
	keywordMaterialSearch,
	type MaterialSearch,
} from "@/lib/video-qa/material-tools";
import { isKnowledgeEnabled, queryKnowledge } from "./store";

/**
 * search_materials for one meeting: hybrid search in the knowledge index,
 * restricted to the meeting's material pages, with the in-memory keyword
 * search as the fallback while the index is off, empty or unreachable.
 */
export function materialSearchFor(videoId: string): MaterialSearch {
	return async (query, materials, limit) => {
		if (!isKnowledgeEnabled()) {
			return keywordMaterialSearch(query, materials, limit);
		}
		try {
			const hits = await queryKnowledge({
				query,
				filter: {
					$and: [{ videoId }, { kind: { $in: ["material", "page"] } }],
				},
				topK: limit * 3,
			});
			const seen = new Set<string>();
			const results = hits.flatMap((hit) => {
				const material = materials.find((m) => m.id === hit.materialId);
				const page = material?.pages.find((p) => p.n === hit.page);
				const key = `${hit.materialId}#${hit.page}`;
				if (!material || !page || seen.has(key)) return [];
				seen.add(key);
				return [{ material, pageNumber: page.n, text: page.text }];
			});
			if (results.length > 0) return results.slice(0, limit);
		} catch (error) {
			console.warn(`[knowledge] material search for ${videoId} failed`, error);
		}
		return keywordMaterialSearch(query, materials, limit);
	};
}
