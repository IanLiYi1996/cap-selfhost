"use client";

import { useMaterials } from "./Materials";

/** One line in the Ask tab saying which materials answers use; the
 * Materials tab is where they are managed. */
export function AskMaterials({
	videoId,
	onOpenMaterials,
}: {
	videoId: string;
	onOpenMaterials?: () => void;
}) {
	const { data } = useMaterials(videoId);
	const count = data?.materials.length ?? 0;
	if (!data || (count === 0 && !data.canManage)) return null;

	return (
		<div className="flex flex-none gap-2 justify-between items-center px-4 py-2 text-xs border-b border-gray-5 text-gray-10">
			<span>
				{count === 0
					? "No meeting materials yet."
					: `Answers also use ${count} meeting material${count === 1 ? "" : "s"}.`}
			</span>
			{onOpenMaterials && (
				<button
					type="button"
					onClick={onOpenMaterials}
					className="flex-none font-medium text-blue-11 hover:text-blue-12"
				>
					{count === 0 ? "Add materials" : "View materials"}
				</button>
			)}
		</div>
	);
}
