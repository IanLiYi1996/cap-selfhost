import {
	BedrockRuntimeClient,
	InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
	CreateIndexCommand,
	DeleteVectorsCommand,
	GetIndexCommand,
	PutVectorsCommand,
	QueryVectorsCommand,
	type QueryVectorsCommandInput,
	S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import { serverEnv } from "@cap/env";
import type { KnowledgeChunk, KnowledgeKind } from "./chunks";

/**
 * The knowledge index in S3 Vectors, embedded with Nova 2 Multimodal
 * Embeddings so text and images share one space. Hybrid queries combine the
 * vector with BM25 over the `text` field (Chinese analyzer). Vector buckets
 * created since 2026-09-30 make ENHANCED indexes, which full-text search and
 * filtering before the vector search need.
 */

export const KNOWLEDGE_INDEX = "content-v1";
export const EMBEDDING_MODEL = "amazon.nova-2-multimodal-embeddings-v1:0";
export const EMBEDDING_DIMENSION = 1024;
const PUT_BATCH = 100;
const DELETE_BATCH = 500;

export const isKnowledgeEnabled = () =>
	Boolean(serverEnv().KNOWLEDGE_VECTOR_BUCKET);

let clients: {
	vectors: S3VectorsClient;
	bedrock: BedrockRuntimeClient;
} | null = null;
const getClients = () => {
	const region = serverEnv().CAP_AWS_REGION;
	clients ??= {
		vectors: new S3VectorsClient({ region }),
		bedrock: new BedrockRuntimeClient({ region }),
	};
	return clients;
};

const bucketName = () => {
	const name = serverEnv().KNOWLEDGE_VECTOR_BUCKET;
	if (!name) throw new Error("KNOWLEDGE_VECTOR_BUCKET is not set");
	return name;
};

let indexReady: Promise<void> | null = null;

/** CloudFormation cannot yet create an index with full-text search, so the
 * app creates it the first time it is needed. */
export function ensureKnowledgeIndex(): Promise<void> {
	indexReady ??= (async () => {
		const { vectors } = getClients();
		const vectorBucketName = bucketName();
		try {
			await vectors.send(
				new GetIndexCommand({ vectorBucketName, indexName: KNOWLEDGE_INDEX }),
			);
			return;
		} catch (error) {
			if ((error as { name?: string }).name !== "NotFoundException")
				throw error;
		}
		try {
			await vectors.send(
				new CreateIndexCommand({
					vectorBucketName,
					indexName: KNOWLEDGE_INDEX,
					dataType: "float32",
					dimension: EMBEDDING_DIMENSION,
					distanceMetric: "cosine",
					metadataConfiguration: {
						nonFilterableMetadataKeys: [
							"text",
							"label",
							"start",
							"end",
							"materialId",
							"materialName",
							"page",
							"imageKey",
						],
						textSearchConfigurations: [{ metadataKey: "text", language: "zh" }],
					},
				}),
			);
		} catch (error) {
			// Another process created it first.
			if ((error as { name?: string }).name !== "ConflictException")
				throw error;
		}
	})().catch((error) => {
		indexReady = null;
		throw error;
	});
	return indexReady;
}

type EmbeddingPurpose = "GENERIC_INDEX" | "GENERIC_RETRIEVAL";

export async function embed(
	input: { text: string } | { image: Uint8Array },
	purpose: EmbeddingPurpose,
): Promise<number[]> {
	const params: Record<string, unknown> = {
		embeddingPurpose: purpose,
		embeddingDimension: EMBEDDING_DIMENSION,
	};
	if ("text" in input) {
		params.text = { truncationMode: "END", value: input.text };
	} else {
		params.image = {
			format: "jpeg",
			source: { bytes: Buffer.from(input.image).toString("base64") },
		};
	}
	const response = await getClients().bedrock.send(
		new InvokeModelCommand({
			modelId: EMBEDDING_MODEL,
			contentType: "application/json",
			accept: "application/json",
			body: JSON.stringify({
				taskType: "SINGLE_EMBEDDING",
				singleEmbeddingParams: params,
			}),
		}),
	);
	const body = JSON.parse(new TextDecoder().decode(response.body)) as {
		embeddings?: { embedding?: number[] }[];
	};
	const vector = body.embeddings?.[0]?.embedding;
	if (!vector || vector.length !== EMBEDDING_DIMENSION) {
		throw new Error("Embedding response has no vector");
	}
	return vector;
}

export type VectorScope = {
	orgId: string;
	videoId: string;
	ownerId: string;
	recordedAt: number;
};

export async function putChunks(
	scope: VectorScope,
	chunks: readonly { chunk: KnowledgeChunk; vector: number[] }[],
) {
	if (chunks.length === 0) return;
	await ensureKnowledgeIndex();
	const { vectors } = getClients();
	for (let i = 0; i < chunks.length; i += PUT_BATCH) {
		await vectors.send(
			new PutVectorsCommand({
				vectorBucketName: bucketName(),
				indexName: KNOWLEDGE_INDEX,
				vectors: chunks.slice(i, i + PUT_BATCH).map(({ chunk, vector }) => ({
					key: chunk.key,
					data: { float32: vector },
					metadata: {
						orgId: scope.orgId,
						videoId: scope.videoId,
						ownerId: scope.ownerId,
						recordedAt: scope.recordedAt,
						kind: chunk.kind,
						text: chunk.text,
						label: chunk.label,
						...(chunk.start !== null ? { start: chunk.start } : {}),
						...(chunk.end !== null ? { end: chunk.end } : {}),
						...(chunk.materialId ? { materialId: chunk.materialId } : {}),
						...(chunk.materialName ? { materialName: chunk.materialName } : {}),
						...(chunk.page !== null ? { page: chunk.page } : {}),
						...(chunk.imageKey ? { imageKey: chunk.imageKey } : {}),
					},
				})),
			}),
		);
	}
}

export async function deleteKeys(keys: readonly string[]) {
	if (keys.length === 0) return;
	await ensureKnowledgeIndex();
	const { vectors } = getClients();
	for (let i = 0; i < keys.length; i += DELETE_BATCH) {
		await vectors.send(
			new DeleteVectorsCommand({
				vectorBucketName: bucketName(),
				indexName: KNOWLEDGE_INDEX,
				keys: keys.slice(i, i + DELETE_BATCH),
			}),
		);
	}
}

export type VectorHit = {
	key: string;
	distance: number | null;
	orgId: string;
	videoId: string;
	ownerId: string;
	recordedAt: number;
	kind: KnowledgeKind;
	text: string;
	label: string;
	start: number | null;
	end: number | null;
	materialId: string | null;
	materialName: string | null;
	page: number | null;
	imageKey: string | null;
};

const asString = (value: unknown) => (typeof value === "string" ? value : "");
const asNumber = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

export function toVectorHit(raw: {
	key?: string;
	distance?: number;
	metadata?: unknown;
}): VectorHit | null {
	const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
	const videoId = asString(metadata.videoId);
	if (!raw.key || !videoId) return null;
	return {
		key: raw.key,
		distance: asNumber(raw.distance),
		orgId: asString(metadata.orgId),
		videoId,
		ownerId: asString(metadata.ownerId),
		recordedAt: asNumber(metadata.recordedAt) ?? 0,
		kind: asString(metadata.kind) as KnowledgeKind,
		text: asString(metadata.text),
		label: asString(metadata.label),
		start: asNumber(metadata.start),
		end: asNumber(metadata.end),
		materialId: asString(metadata.materialId) || null,
		materialName: asString(metadata.materialName) || null,
		page: asNumber(metadata.page),
		imageKey: asString(metadata.imageKey) || null,
	};
}

export type VectorFilter = NonNullable<QueryVectorsCommandInput["filter"]>;

export async function queryKnowledge(options: {
	query: string;
	filter: VectorFilter;
	topK: number;
}): Promise<VectorHit[]> {
	await ensureKnowledgeIndex();
	const vector = await embed({ text: options.query }, "GENERIC_RETRIEVAL");
	const response = await getClients().vectors.send(
		new QueryVectorsCommand({
			vectorBucketName: bucketName(),
			indexName: KNOWLEDGE_INDEX,
			topK: Math.min(100, options.topK),
			queryVector: { float32: vector },
			queryTexts: [{ metadataKey: "text", text: options.query.slice(0, 1000) }],
			filter: options.filter,
			returnMetadata: true,
			returnDistance: true,
		}),
	);
	return (response.vectors ?? []).flatMap((raw) => {
		const hit = toVectorHit(raw);
		return hit ? [hit] : [];
	});
}
