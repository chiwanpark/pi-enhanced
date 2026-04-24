const FENCE_PATTERN = /^\s*(```|~~~)/;
const HEADING_PATTERN = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/;
const BOLD_TITLE_PATTERN = /^\*\*[^*\n][\s\S]*[^*\n]\*\*$/;

export const ASSISTANT_FORMAT_GUIDANCE = [
	"Assistant response formatting rules:",
	"- Write plain text for a terminal UI.",
	"- Default to concise, well-spaced responses.",
	"- Do not use markdown heading syntax like #, ##, or ###.",
	"- If a short section title helps, write it as **Title Case** on its own line.",
	"- Prefer short paragraphs separated by a single blank line.",
	"- Use - bullets only when the content is inherently list-shaped.",
	"- Keep bullets flat; do not nest bullets or create deep hierarchies.",
	"- Keep lists short and aligned, and avoid filler text.",
].join("\n");

export function appendAssistantFormatGuidance(systemPrompt: string): string {
	if (systemPrompt.includes(ASSISTANT_FORMAT_GUIDANCE)) {
		return systemPrompt;
	}

	return `${systemPrompt}\n\n${ASSISTANT_FORMAT_GUIDANCE}`;
}

export function normalizeAssistantMarkdown(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const normalized: string[] = [];
	let inFence = false;

	for (const line of lines) {
		if (FENCE_PATTERN.test(line)) {
			inFence = !inFence;
			normalized.push(line);
			continue;
		}

		if (inFence) {
			normalized.push(line);
			continue;
		}

		const headingMatch = HEADING_PATTERN.exec(line);
		if (!headingMatch) {
			normalized.push(line);
			continue;
		}

		const headingText = headingMatch[1]?.trim();
		normalized.push(headingText ? `**${headingText}**` : line);
	}

	return normalized.join("\n");
}

export function looksLikeStructuredAssistantMarkdown(text: string): boolean {
	const firstLine = normalizeAssistantMarkdown(text).trimStart().split("\n")[0]?.trimStart() ?? "";
	return (
		firstLine.startsWith("- ") ||
		firstLine.startsWith("* ") ||
		firstLine.startsWith("> ") ||
		firstLine.startsWith("```") ||
		firstLine.startsWith("~~~") ||
		firstLine.startsWith("|") ||
		/^\d+\.\s/.test(firstLine) ||
		BOLD_TITLE_PATTERN.test(firstLine)
	);
}
