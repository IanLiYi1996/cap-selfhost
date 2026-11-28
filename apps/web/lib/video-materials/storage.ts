import type { Storage } from "@cap/web-backend";
import { type Effect, Option } from "effect";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

// Bucket operations need no services, so the lighter workflow runtime serves
// both routes and workflow steps.
export type Bucket = Effect.Effect.Success<
	ReturnType<typeof Storage.getAccessForVideo>
>[0];

function isConditionalWriteConflict(error: unknown) {
	const pending = [error];
	for (let index = 0; index < pending.length && index < 16; index++) {
		const value = pending[index];
		if (typeof value !== "object" || value === null) continue;
		const record = value as Record<string, unknown>;
		const status = (record.$metadata as { httpStatusCode?: unknown } | null)
			?.httpStatusCode;
		if (
			status === 412 ||
			status === 409 ||
			record.name === "PreconditionFailed" ||
			record.name === "ConditionalRequestConflict"
		) {
			return true;
		}
		pending.push(record.cause, record.error);
	}
	return false;
}

export type JsonUpdate<R> = { next: unknown; result: R } | { abort: R };

/**
 * Read-modify-write of a small JSON object. On S3 it uses conditional writes,
 * so two people uploading at once cannot drop each other's entry; other
 * storage providers have no ETags, so there the last write wins.
 */
export async function updateJsonObject<R>(
	bucket: Bucket,
	key: string,
	update: (raw: string | null) => JsonUpdate<R>,
	attempts = 4,
): Promise<R> {
	for (let attempt = 1; ; attempt += 1) {
		let raw: string | null;
		let condition: { ifMatch?: string; ifNoneMatch?: string } = {};
		if (bucket.provider === "s3") {
			const existing = await bucket
				.getObjectWithETag(key)
				.pipe(runWorkflowPromise);
			raw = Option.isSome(existing) ? existing.value.body : null;
			condition =
				Option.isSome(existing) && existing.value.eTag
					? { ifMatch: existing.value.eTag }
					: Option.isSome(existing)
						? {}
						: { ifNoneMatch: "*" };
		} else {
			raw = await readText(bucket, key);
		}

		const outcome = update(raw);
		if ("abort" in outcome) return outcome.abort;

		try {
			await bucket
				.putObject(key, JSON.stringify(outcome.next), {
					contentType: "application/json",
					...condition,
				})
				.pipe(runWorkflowPromise);
			return outcome.result;
		} catch (error) {
			if (attempt >= attempts || !isConditionalWriteConflict(error))
				throw error;
		}
	}
}

export async function readText(bucket: Bucket, key: string) {
	const object = await bucket
		.getObject(key)
		.pipe(runWorkflowPromise)
		.catch(() => Option.none<string>());
	return Option.isSome(object) ? object.value : null;
}
