import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { appendAssistantFormatGuidance, normalizeAssistantMarkdown } from "./internal/assistant-format";
import {
	ASSISTANT_TRANSCRIPT_PREFIX,
	ASSISTANT_TRANSCRIPT_PREFIX_PLAIN,
	LEGACY_ASSISTANT_TRANSCRIPT_PREFIX,
	LEGACY_ASSISTANT_TRANSCRIPT_PREFIX_PLAIN,
} from "./internal/assistant-markdown";

const TRANSCRIPT_PREFIX = "• ";
const TRANSCRIPT_CONTINUATION = "  ";
const FENCE_PATTERN = /^\s*(```|~~~)/;
const HEADING_PATTERN = /^ {0,3}#{1,6}\s+/;
const BOLD_TITLE_PATTERN = /^\*\*[^*\n][\s\S]*[^*\n]\*\*$/;
const ASSISTANT_PREFIXES = [
	ASSISTANT_TRANSCRIPT_PREFIX,
	LEGACY_ASSISTANT_TRANSCRIPT_PREFIX,
	ASSISTANT_TRANSCRIPT_PREFIX_PLAIN,
	LEGACY_ASSISTANT_TRANSCRIPT_PREFIX_PLAIN,
] as const;

type TextBlock = {
	type: "text";
	text: string;
};

type MessageLike = {
	role: string;
	content?: unknown;
};

function normalizeNewlines(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function firstVisibleLine(text: string): string {
	const normalized = normalizeNewlines(text);
	for (const line of normalized.split("\n")) {
		const trimmed = line.trimStart();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return "";
}

function looksLikeStructuredMarkdown(text: string): boolean {
	const firstLine = firstVisibleLine(text);
	return (
		FENCE_PATTERN.test(firstLine) ||
		HEADING_PATTERN.test(firstLine) ||
		firstLine.startsWith("- ") ||
		firstLine.startsWith("* ") ||
		firstLine.startsWith("> ") ||
		firstLine.startsWith("|") ||
		/^\d+\.\s/.test(firstLine) ||
		BOLD_TITLE_PATTERN.test(firstLine)
	);
}

function stripUserTranscriptDecoration(text: string): string {
	const normalized = normalizeNewlines(text);
	const lines = normalized.split("\n");
	if (
		!lines[0]?.startsWith(TRANSCRIPT_PREFIX) ||
		!lines.slice(1).every((line) => line.startsWith(TRANSCRIPT_CONTINUATION))
	) {
		return normalized;
	}

	return lines
		.map((line, index) => line.slice(index === 0 ? TRANSCRIPT_PREFIX.length : TRANSCRIPT_CONTINUATION.length))
		.join("\n");
}

function stripAssistantTranscriptDecoration(text: string): string {
	let stripped = stripUserTranscriptDecoration(text);
	for (const prefix of ASSISTANT_PREFIXES) {
		if (stripped.startsWith(prefix)) {
			stripped = stripped.slice(prefix.length);
			break;
		}
	}

	return stripped
		.split("\n")
		.map((line) => {
			for (const prefix of ASSISTANT_PREFIXES) {
				if (line.startsWith(prefix)) {
					return line.slice(prefix.length);
				}
			}
			return line;
		})
		.join("\n");
}

function stripMessageTextDecoration(role: string, text: string): string {
	return role === "assistant" ? stripAssistantTranscriptDecoration(text) : stripUserTranscriptDecoration(text);
}

function decorateUserTranscriptText(text: string): string {
	const stripped = stripUserTranscriptDecoration(text);
	if (!stripped.trim() || looksLikeStructuredMarkdown(stripped)) {
		return stripped;
	}

	return normalizeNewlines(stripped)
		.split("\n")
		.map((line, index) => `${index === 0 ? TRANSCRIPT_PREFIX : TRANSCRIPT_CONTINUATION}${line}`)
		.join("\n");
}

function decorateAssistantTranscriptText(text: string): string {
	const stripped = stripAssistantTranscriptDecoration(text);
	const normalized = normalizeAssistantMarkdown(stripped);
	if (!normalized.trim()) {
		return normalized;
	}

	return `${ASSISTANT_TRANSCRIPT_PREFIX}${normalized}`;
}

function isTextBlock(value: unknown): value is TextBlock {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as { type?: unknown; text?: unknown };
	return candidate.type === "text" && typeof candidate.text === "string";
}

function decorateAssistantMessage(message: MessageLike): void {
	if (message.role !== "assistant") {
		return;
	}

	if (typeof message.content === "string") {
		message.content = decorateAssistantTranscriptText(message.content);
		return;
	}

	if (!Array.isArray(message.content)) {
		return;
	}

	let decorated = false;
	let activeTextRun: TextBlock | undefined;

	for (const item of message.content) {
		if (!isTextBlock(item)) {
			activeTextRun = undefined;
			continue;
		}

		const strippedText = stripAssistantTranscriptDecoration(item.text);
		const hasVisibleText = strippedText.trim().length > 0;

		if (!activeTextRun && !hasVisibleText) {
			item.text = "";
			continue;
		}

		if (!activeTextRun) {
			item.text = decorated ? strippedText : decorateAssistantTranscriptText(strippedText);
			activeTextRun = item;
			decorated = hasVisibleText;
			continue;
		}

		activeTextRun.text += strippedText;
		item.text = "";
	}
}

function stripMessageDecoration(message: MessageLike): MessageLike {
	if (typeof message.content === "string") {
		if (message.role !== "user" && message.role !== "assistant") {
			return message;
		}

		return {
			...message,
			content: stripMessageTextDecoration(message.role, message.content),
		};
	}

	if (!Array.isArray(message.content)) {
		return message;
	}

	if (message.role !== "user" && message.role !== "assistant") {
		return message;
	}

	return {
		...message,
		content: message.content.map((item) => {
			if (!isTextBlock(item)) {
				return item;
			}
			return {
				...item,
				text: stripMessageTextDecoration(message.role, item.text),
			};
		}),
	};
}

export default function transcriptExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: appendAssistantFormatGuidance(event.systemPrompt),
	}));

	pi.on("input", async (event) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}
		if (!event.text.trim()) {
			return { action: "continue" as const };
		}
		if (event.text.startsWith("/") || event.text.startsWith("!")) {
			return { action: "continue" as const };
		}

		const decorated = decorateUserTranscriptText(event.text);
		if (decorated === event.text) {
			return { action: "continue" as const };
		}

		return {
			action: "transform" as const,
			text: decorated,
		};
	});

	pi.on("message_start", async (event) => {
		decorateAssistantMessage(event.message as MessageLike);
	});

	pi.on("message_update", async (event) => {
		decorateAssistantMessage(event.message as MessageLike);
	});

	pi.on("message_end", async (event) => {
		decorateAssistantMessage(event.message as MessageLike);
	});

	pi.on("context", async (event) => {
		const messages = event.messages.map((message) =>
			stripMessageDecoration(message as MessageLike),
		) as typeof event.messages;
		return { messages };
	});
}
