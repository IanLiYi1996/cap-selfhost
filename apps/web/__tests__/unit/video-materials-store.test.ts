import { describe, expect, it } from "vitest";
import {
	addMaterial,
	MAX_MATERIAL_TEXT_CHARS,
	MAX_MATERIALS,
	type MaterialEntry,
	materialFileKey,
	materialsManifestKey,
	materialTextKey,
	parseMaterialsManifest,
	removeMaterial,
	safeFileName,
} from "@/lib/video-materials/manifest";

const entry = (id: string, textChars = 100): MaterialEntry => ({
	id,
	name: `${id}.pdf`,
	kind: "pdf",
	size: 1000,
	uploadedAt: "2026-11-26T00:00:00.000Z",
	uploadedBy: "u1",
	textChars,
});

describe("keys", () => {
	it("keeps materials under the video's own prefix", () => {
		expect(materialsManifestKey("o", "v")).toBe("o/v/materials.v1.json");
		expect(materialTextKey("o", "v", "m1")).toBe("o/v/materials/m1/text.txt");
		expect(materialFileKey("o", "v", "m1", "会议 纪要.pdf")).toBe(
			"o/v/materials/m1/会议_纪要.pdf",
		);
	});

	it("never lets a file name escape its folder", () => {
		expect(safeFileName("../../etc/passwd")).toBe("passwd");
		expect(safeFileName("a\\b/c?.html")).toBe("c_.html");
		expect(safeFileName("")).toBe("file");
	});
});

describe("parseMaterialsManifest", () => {
	it("keeps valid entries and drops broken ones", () => {
		const manifest = parseMaterialsManifest(
			JSON.stringify({ version: 1, materials: [entry("a"), { id: 1 }] }),
		);
		expect(manifest.materials.map((m) => m.id)).toEqual(["a"]);
	});

	it("treats a missing or unreadable manifest as empty", () => {
		expect(parseMaterialsManifest(null).materials).toEqual([]);
		expect(parseMaterialsManifest("nope").materials).toEqual([]);
	});
});

describe("addMaterial", () => {
	it("appends a material", () => {
		const result = addMaterial(
			{ version: 1, materials: [entry("a")] },
			entry("b"),
		);
		expect(result).toEqual({
			ok: true,
			manifest: { version: 1, materials: [entry("a"), entry("b")] },
		});
	});

	it("refuses more than the material limit", () => {
		const materials = Array.from({ length: MAX_MATERIALS }, (_, i) =>
			entry(`m${i}`, 1),
		);
		const result = addMaterial({ version: 1, materials }, entry("extra", 1));
		expect(result).toMatchObject({ ok: false, reason: "too_many" });
	});

	it("refuses text that would push the total past what Q&A can read", () => {
		const result = addMaterial(
			{ version: 1, materials: [entry("a", MAX_MATERIAL_TEXT_CHARS - 10)] },
			entry("b", 11),
		);
		expect(result).toMatchObject({ ok: false, reason: "too_much_text" });
	});

	it("replaces an entry uploaded again with the same id", () => {
		const result = addMaterial(
			{ version: 1, materials: [entry("a", 5)] },
			entry("a", 7),
		);
		expect(result.ok && result.manifest.materials).toEqual([entry("a", 7)]);
	});
});

describe("removeMaterial", () => {
	it("drops the entry and reports whether it existed", () => {
		const manifest = {
			version: 1 as const,
			materials: [entry("a"), entry("b")],
		};
		expect(removeMaterial(manifest, "a")).toEqual({
			removed: entry("a"),
			manifest: { version: 1, materials: [entry("b")] },
		});
		expect(removeMaterial(manifest, "zzz").removed).toBe(null);
	});
});
