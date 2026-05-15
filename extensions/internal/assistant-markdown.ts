import { Markdown } from "@earendil-works/pi-tui";

const ASSISTANT_MARKDOWN_PATCH = Symbol.for("pi-enhanced.assistant-markdown-patch");

type MarkdownRuntime = {
	render(width: number): string[];
	[ASSISTANT_MARKDOWN_PATCH]?: boolean | undefined;
};

export function installAssistantMarkdownPatch(): void {
	const prototype = Markdown.prototype as unknown as MarkdownRuntime;
	if (prototype[ASSISTANT_MARKDOWN_PATCH]) {
		return;
	}
	prototype[ASSISTANT_MARKDOWN_PATCH] = true;
}
