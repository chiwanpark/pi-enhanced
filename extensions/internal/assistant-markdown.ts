import { Markdown, visibleWidth } from "@mariozechner/pi-tui";

export const ASSISTANT_TRANSCRIPT_PREFIX_PLAIN = "• ";
export const LEGACY_ASSISTANT_TRANSCRIPT_PREFIX_PLAIN = "· ";
export const ASSISTANT_TRANSCRIPT_PREFIX = "\x1b[38;2;102;102;102m•\x1b[0m ";
export const LEGACY_ASSISTANT_TRANSCRIPT_PREFIX = "\x1b[38;2;102;102;102m·\x1b[0m ";

const ASSISTANT_BLOCK_PREFIXES = [
	ASSISTANT_TRANSCRIPT_PREFIX,
	LEGACY_ASSISTANT_TRANSCRIPT_PREFIX,
	ASSISTANT_TRANSCRIPT_PREFIX_PLAIN,
	LEGACY_ASSISTANT_TRANSCRIPT_PREFIX_PLAIN,
] as const;

const ASSISTANT_MARKDOWN_PATCH = Symbol.for("pi-enhanced.assistant-markdown-patch");
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type MarkdownRuntime = {
	text: string;
	cachedText: string | undefined;
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	defaultTextStyle?: { color?: ((text: string) => string) | undefined } | undefined;
};

type PatchedMarkdownPrototype = {
	render(this: MarkdownRuntime, width: number): string[];
	[ASSISTANT_MARKDOWN_PATCH]?: boolean | undefined;
};

function getAssistantBlockPrefix(text: string): string | undefined {
	return ASSISTANT_BLOCK_PREFIXES.find((prefix) => text.startsWith(prefix));
}

function renderBlockPrefix(markdown: MarkdownRuntime, prefix: string): string {
	if (prefix.includes("\x1b")) {
		return prefix;
	}

	return markdown.defaultTextStyle?.color?.(prefix) ?? prefix;
}

function hasVisibleText(line: string): boolean {
	return line.replace(ANSI_PATTERN, "").trim().length > 0;
}

function getLineKind(line: string): "blank" | "list" | "text" {
	const plain = line.replace(ANSI_PATTERN, "").trimStart();
	if (!plain.trim()) {
		return "blank";
	}
	if (/^(?:[-*]|\d+\.)\s/.test(plain)) {
		return "list";
	}
	return "text";
}

function addAssistantBreathingRoom(lines: string[]): string[] {
	const spacedLines: string[] = [];
	let previousVisibleKind: "list" | "text" | undefined;

	for (const line of lines) {
		const lineKind = getLineKind(line);

		if (
			lineKind !== "blank" &&
			previousVisibleKind &&
			previousVisibleKind !== lineKind &&
			spacedLines[spacedLines.length - 1] !== ""
		) {
			spacedLines.push("");
		}

		spacedLines.push(line);

		if (lineKind !== "blank") {
			previousVisibleKind = lineKind;
		}
	}

	const normalizedLines: string[] = [];
	let consecutiveBlankLines = 0;
	for (const line of spacedLines) {
		if (getLineKind(line) === "blank") {
			consecutiveBlankLines++;
			if (consecutiveBlankLines > 2) {
				continue;
			}
		} else {
			consecutiveBlankLines = 0;
		}
		normalizedLines.push(line);
	}

	return normalizedLines;
}

function padToWidth(line: string, width: number): string {
	return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

function insertPrefixAfterLeftPadding(line: string, prefix: string): string {
	const match = /^(\s*)(.*)$/.exec(line);
	const leftPadding = match?.[1] ?? "";
	const content = match?.[2] ?? line;
	return `${leftPadding}${prefix}${content}`;
}

function indentAssistantBlock(lines: string[], width: number, prefix: string): string[] {
	const continuation = " ".repeat(visibleWidth(prefix));
	const indentedLines: string[] = [];
	let prefixedFirstVisibleLine = false;

	for (const line of lines) {
		if (!hasVisibleText(line)) {
			indentedLines.push(padToWidth(line, width));
			continue;
		}

		const linePrefix = prefixedFirstVisibleLine ? continuation : prefix;
		indentedLines.push(padToWidth(insertPrefixAfterLeftPadding(line, linePrefix), width));
		prefixedFirstVisibleLine = true;
	}

	return indentedLines;
}

function renderAssistantBlock(
	originalRender: (this: MarkdownRuntime, width: number) => string[],
	markdown: MarkdownRuntime,
	width: number,
): string[] | undefined {
	const prefix = getAssistantBlockPrefix(markdown.text);
	if (!prefix) {
		return undefined;
	}

	const renderedPrefix = renderBlockPrefix(markdown, prefix);
	const prefixWidth = visibleWidth(renderedPrefix);
	if (width <= prefixWidth) {
		return undefined;
	}

	const shadowMarkdown = Object.create(markdown) as MarkdownRuntime;
	shadowMarkdown.text = markdown.text.slice(prefix.length);
	shadowMarkdown.cachedText = undefined;
	shadowMarkdown.cachedWidth = undefined;
	shadowMarkdown.cachedLines = undefined;

	const renderedBody = originalRender.call(shadowMarkdown, Math.max(1, width - prefixWidth));
	return indentAssistantBlock(addAssistantBreathingRoom(renderedBody), width, renderedPrefix);
}

export function installAssistantMarkdownPatch(): void {
	const prototype = Markdown.prototype as unknown as PatchedMarkdownPrototype;
	if (prototype[ASSISTANT_MARKDOWN_PATCH]) {
		return;
	}

	const originalRender = prototype.render;
	prototype.render = function patchedRender(this: MarkdownRuntime, width: number): string[] {
		const renderedAssistantBlock = renderAssistantBlock(originalRender, this, width);
		if (renderedAssistantBlock) {
			return renderedAssistantBlock;
		}
		return originalRender.call(this, width);
	};

	prototype[ASSISTANT_MARKDOWN_PATCH] = true;
}
