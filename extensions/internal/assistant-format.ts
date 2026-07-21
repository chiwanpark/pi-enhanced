const FENCE_PATTERN = /^\s*(```|~~~)/;
const HEADING_PATTERN = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/;

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
