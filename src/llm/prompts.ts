/**
 * The instructions behind each AI feature, as the user may adjust them in
 * settings. What stays in code is the scaffolding a feature cannot work
 * without: the JSON shape for tags, chunking, length caps. Each default ends
 * with its language rule, which small models follow only when it comes after
 * the text, so callers put these instructions last in the user message.
 */
export const DEFAULT_PROMPTS = {
	summary:
		'Summarise for someone who will read the summary instead of the document. Be concrete and specific. Plain prose, no headings, no bullet points, no preamble. Write in the language of the document.',
	tags: "The title is the document's own title if it has one, otherwise a plain descriptive one, under 80 characters. Tags are general topics rather than names, each at most three words. Write the title in the language of the document and the tags in English.",
	describe: 'Describe this image in two or three sentences for someone who cannot see it. Say what it shows and any text in it. No preamble.',
} as const;

export type PromptKey = keyof typeof DEFAULT_PROMPTS;

/** The user's text when set, else the default. */
export function promptOr(key: PromptKey, custom: string): string {
	const text = custom.trim();
	return text.length > 0 ? text : DEFAULT_PROMPTS[key];
}
