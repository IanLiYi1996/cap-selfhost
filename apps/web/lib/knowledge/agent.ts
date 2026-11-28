import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { formatPlayerTime } from "@/lib/player-time";
import { fetchStorageUrl } from "@/lib/storage-fetch";
import { findMaterial } from "@/lib/video-materials/context";
import { loadMaterials } from "@/lib/video-materials/materials";
import { selectPages } from "@/lib/video-materials/pages";
import { readText } from "@/lib/video-materials/storage";
import {
	parseVisualTimeline,
	visualTimelineKey,
} from "@/lib/video-qa/artifacts";
import { parseVttCues, transcriptBetween } from "@/lib/video-qa/transcript";
import { runWorkflowPromise } from "@/lib/workflow-runtime";
import { KNOWLEDGE_KINDS, type KnowledgeKind } from "./chunks";
import { formatResultsForModel, type KnowledgeResult } from "./results";
import {
	loadViewableMeetings,
	searchKnowledge,
	type ViewableMeeting,
} from "./search";

export const KNOWLEDGE_INSTRUCTIONS = `You answer questions about the meetings of one organization: their recordings (transcripts and what was on screen), AI summaries, and the documents uploaded for them. You only know what your tools return.

How to work:
- Start with search_knowledge. Search more than once when the first results are thin: rephrase, use the words people would have said or written, and try both Chinese and English for technical terms.
- Results come grouped by meeting, each with a ref like [S1R3], a kind (transcript, visual, frame, summary, chapter, material, page), where it is, and a snippet.
- Before relying on a transcript hit, read the surrounding minutes with read_meeting; snippets are short and automatic speech recognition makes mistakes. For a document, read the pages with read_material. Use look_at on results marked [has image] when a slide, chart or screen matters.
- Answer only from what you found. If the meetings do not cover the question, say so plainly. When meetings disagree or something changed over time, say which meeting said what, with dates.

Citing:
- Cite every claim with a markdown link, exactly in this form:
  - a moment in a meeting: [<meeting title> <mm:ss>](cap://video/<videoId>?t=<seconds>)
  - a page of a document: [《<file name>》 <Page or Slide n>](cap://material/<videoId>/<materialId>?page=<n>)
  - a whole meeting (its summary): [<meeting title>](cap://video/<videoId>)
- Use only videoIds, materialIds, times and pages that your tools returned.

Style:
- Reply in the language of the user's latest question.
- Lead with the answer; group by meeting or by topic when there are several. Keep it concise unless asked for detail.`;

const MAX_CALLS = { search: 8, read: 8, look: 3 };
const READ_MAX_SECONDS = 15 * 60;
const READ_MAX_PAGES = 10;
const LOOK_MAX_IMAGES = 6;

export function createKnowledgeTools(orgId: string): ToolSet {
	const calls = { search: 0, read: 0, look: 0 };
	const over = (kind: keyof typeof calls) => {
		calls[kind] += 1;
		return calls[kind] > MAX_CALLS[kind];
	};
	const seen = new Map<string, KnowledgeResult>();
	const meetings = new Map<string, ViewableMeeting>();

	const meetingFor = async (videoId: string) => {
		const known = meetings.get(videoId);
		if (known) return known;
		const loaded = (await loadViewableMeetings([videoId])).get(videoId);
		if (loaded) meetings.set(videoId, loaded);
		return loaded ?? null;
	};

	return {
		search_knowledge: tool({
			description:
				"Search all meetings you can see (transcripts, screen descriptions and keyframes, summaries and chapters, and uploaded documents with their page images). Returns up to about 12 meetings with their best matches.",
			inputSchema: z.object({
				query: z.string().min(1).describe("What to look for"),
				kinds: z
					.array(z.enum(KNOWLEDGE_KINDS as [KnowledgeKind, ...KnowledgeKind[]]))
					.optional()
					.describe("Only these kinds of results"),
			}),
			execute: async ({ query, kinds }) => {
				if (over("search")) return "search limit reached for this answer";
				const response = await searchKnowledge({
					orgId,
					query,
					kinds,
					topK: 60,
					perMeeting: 4,
					refPrefix: `S${calls.search}R`,
				});
				for (const result of response.results) seen.set(result.ref, result);
				for (const [id, meeting] of response.meetings)
					meetings.set(id, meeting);
				return formatResultsForModel(response.groups.slice(0, 12));
			},
		}),

		read_meeting: tool({
			description: `Read what was said and shown in a meeting between two times (seconds), up to ${READ_MAX_SECONDS / 60} minutes at once.`,
			inputSchema: z.object({
				videoId: z.string(),
				start: z.number().min(0),
				end: z.number().min(0),
			}),
			execute: async ({ videoId, start, end }) => {
				if (over("read")) return "read limit reached for this answer";
				const meeting = await meetingFor(videoId);
				if (!meeting) return "That meeting is not available.";
				const to = Math.min(
					Math.max(end, start + 30),
					start + READ_MAX_SECONDS,
				);
				const { ownerId, id } = meeting.video;
				const [vtt, timelineRaw] = await Promise.all([
					readText(meeting.bucket, `${ownerId}/${id}/transcription.vtt`),
					readText(meeting.bucket, visualTimelineKey(ownerId, id)),
				]);
				const transcript = vtt
					? transcriptBetween(parseVttCues(vtt), start, to)
					: "";
				const screens = (
					(timelineRaw ? parseVisualTimeline(timelineRaw) : null)?.segments ??
					[]
				)
					.filter((segment) => segment.end > start && segment.start < to)
					.map(
						(segment) =>
							`[${formatPlayerTime(segment.start)}-${formatPlayerTime(segment.end)}] ${segment.description}${segment.screenText.length ? `\n  Screen text: ${segment.screenText.join(" | ")}` : ""}`,
					)
					.join("\n");
				return [
					`Meeting "${meeting.info.title}" (videoId ${videoId}), ${formatPlayerTime(start)}-${formatPlayerTime(to)}`,
					"Transcript:",
					transcript || "(nothing said)",
					"On screen:",
					screens || "(no screen descriptions)",
				].join("\n");
			},
		}),

		read_material: tool({
			description: `Read pages of a document uploaded to a meeting, up to ${READ_MAX_PAGES} pages at once.`,
			inputSchema: z.object({
				videoId: z.string(),
				material: z.string().describe("The materialId or file name"),
				pages: z
					.array(z.union([z.number().int().min(1), z.string()]))
					.min(1)
					.describe('Page numbers or ranges, e.g. [3, "5-7"]'),
			}),
			execute: async ({ videoId, material, pages }) => {
				if (over("read")) return "read limit reached for this answer";
				const meeting = await meetingFor(videoId);
				if (!meeting) return "That meeting is not available.";
				const materials = await loadMaterials(meeting.bucket, meeting.video);
				const found = findMaterial(materials, material);
				if (!found) {
					return `No such document. This meeting has: ${materials.map((m) => `${m.name} (${m.id})`).join(", ") || "none"}`;
				}
				const picked = selectPages(found.pages, pages, READ_MAX_PAGES);
				if (picked.length === 0) {
					return `No such pages; ${found.name} has ${found.pages.length} pages.`;
				}
				return [
					`《${found.name}》 (materialId ${found.id}) in meeting "${meeting.info.title}" (videoId ${videoId})`,
					...picked.map((page) => `[${page.label}]\n${page.text}`),
				].join("\n\n");
			},
		}),

		look_at: tool({
			description: `Look at the images of search results marked [has image] (keyframes and document pages), by ref. Up to ${LOOK_MAX_IMAGES} at once.`,
			inputSchema: z.object({
				refs: z.array(z.string()).min(1).max(LOOK_MAX_IMAGES),
			}),
			execute: async ({ refs }) => {
				if (over("look")) return { note: "look_at limit reached", images: [] };
				const images = await Promise.all(
					refs.map(async (ref) => {
						const result = seen.get(ref.replace(/^\[|\]$/g, ""));
						const meeting = result ? meetings.get(result.videoId) : undefined;
						if (!result?.imageKey || !meeting) return null;
						const url = await meeting.bucket
							.getInternalSignedObjectUrl(result.imageKey)
							.pipe(runWorkflowPromise);
						const response = await fetchStorageUrl(url);
						if (!response.ok) return null;
						return {
							label: `[${result.ref}] ${meeting.info.title} · ${result.label}`,
							data: new Uint8Array(await response.arrayBuffer()),
						};
					}),
				);
				const ok = images.filter((image) => image !== null);
				return {
					note:
						ok.length > 0
							? `${ok.length} images.`
							: "None of those refs has an image.",
					images: ok,
				};
			},
			toModelOutput: ({ output }) =>
				typeof output === "string"
					? { type: "text", value: output }
					: {
							type: "content",
							value: [
								{ type: "text", text: output.note },
								...output.images.flatMap((image) => [
									{ type: "text" as const, text: image.label },
									{
										type: "file" as const,
										data: { type: "data" as const, data: image.data },
										mediaType: "image/jpeg",
									},
								]),
							],
						},
		}),
	};
}
