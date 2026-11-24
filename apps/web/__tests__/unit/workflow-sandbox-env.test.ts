import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// "use workflow" bodies run in a sandbox without Node globals such as Buffer,
// and serverEnv()'s validators use them, so env must only be read in steps.
// The unit tests mock serverEnv, so only a source check catches this.
const WORKFLOWS_DIR = join(__dirname, "../../workflows");
const ENV_ACCESS =
	/\b(serverEnv|isWhisperConfigured|isTranscriptionConfigured)\(|process\.env\b/;

function workflowBodies(source: string) {
	const heads = [
		...source.matchAll(/\n(?:export )?(?:async )?function (\w+)\(/g),
	];
	return heads.flatMap((head, i) => {
		const start = head.index ?? 0;
		const end = heads[i + 1]?.index ?? source.length;
		const body = source.slice(start, end);
		const directive = body.match(/"use (workflow|step)"/);
		return directive?.[1] === "workflow" ? [{ name: head[1], body }] : [];
	});
}

describe("workflow bodies", () => {
	const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".ts"));

	it("finds the workflows it is meant to guard", () => {
		const names = files.flatMap((f) =>
			workflowBodies(readFileSync(join(WORKFLOWS_DIR, f), "utf8")).map(
				(w) => w.name,
			),
		);
		expect(names).toContain("transcribeVideoWorkflow");
		expect(names).toContain("backfillEditTranscriptWorkflow");
	});

	it("never read server env outside a step", () => {
		const offenders = files.flatMap((file) =>
			workflowBodies(readFileSync(join(WORKFLOWS_DIR, file), "utf8")).flatMap(
				({ name, body }) =>
					body
						.split("\n")
						.filter((line) => ENV_ACCESS.test(line))
						.map((line) => `${file} ${name}: ${line.trim()}`),
			),
		);
		expect(offenders).toEqual([]);
	});
});
