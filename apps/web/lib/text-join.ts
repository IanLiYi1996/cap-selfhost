/**
 * Joining transcript fragments back into readable text.
 *
 * Space-joining is correct for English and wrong for Chinese and Japanese, which
 * do not separate words. A Chinese transcript joined with spaces reads
 * "我是 想 往 里 腾 我 跟你 说" instead of "我是想往里腾我跟你说" — and it is not a
 * cosmetic issue only, because Whisper's Chinese "words" are sub-word tokens, so
 * the spaces land mid-word.
 *
 * Korean is deliberately excluded: Hangul is written with spaces between words.
 */

// Han covers Chinese and kanji; Hiragana/Katakana cover the rest of Japanese.
// The explicit ranges add CJK punctuation (、。「」) and the halfwidth/fullwidth
// forms block (，！？：； and fullwidth Latin), none of which take spaces either.
const NO_SPACE_BOUNDARY =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

/** Last and first *code points*, so astral-plane CJK is not split mid-surrogate. */
const lastCodePoint = (text: string): string | undefined => {
	const points = Array.from(text);
	return points[points.length - 1];
};

const firstCodePoint = (text: string): string | undefined =>
	Array.from(text)[0];

/**
 * Whether a space belongs between two adjacent fragments.
 *
 * False when either side of the boundary is CJK, which covers CJK-to-CJK as well
 * as the mixed case (`放` + `feature`) where Whisper reports no space either.
 */
export function needsSpaceBetween(left: string, right: string): boolean {
	if (!left || !right) return false;

	const before = lastCodePoint(left);
	const after = firstCodePoint(right);
	if (!before || !after) return false;

	return !NO_SPACE_BOUNDARY.test(before) && !NO_SPACE_BOUNDARY.test(after);
}

/** Append `right` to `left`, inserting a space only where one belongs. */
export function appendFragment(left: string, right: string): string {
	if (!left) return right;
	if (!right) return left;
	return needsSpaceBetween(left, right)
		? `${left} ${right}`
		: `${left}${right}`;
}

/** Join fragments into one run of text, spacing each boundary on its own merits. */
export function joinFragments(parts: readonly string[]): string {
	return parts.reduce<string>(
		(accumulated, part) => appendFragment(accumulated, part),
		"",
	);
}
