import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { normalizeAssistantMarkdown } from "./internal/assistant-format";

const TRANSCRIPT_PREFIX = "• ";
const TRANSCRIPT_CONTINUATION = "  ";
const FENCE_PATTERN = /^\s*(```|~~~)/;

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
	return stripUserTranscriptDecoration(text);
}

function stripMessageTextDecoration(role: string, text: string): string {
	return role === "assistant" ? stripAssistantTranscriptDecoration(text) : stripUserTranscriptDecoration(text);
}

function decorateUserTranscriptText(text: string): string {
	const normalized = normalizeNewlines(text);
	const lines = normalized.split("\n");
	const result: string[] = [];
	let inFence = false;

	for (const line of lines) {
		if (FENCE_PATTERN.test(line)) {
			inFence = !inFence;
			result.push(line);
			continue;
		}

		if (inFence) {
			// Strip all leading whitespace from code block content
			result.push(line.trimStart());
		} else {
			result.push(line);
		}
	}

	return result.join("\n");
}

function decorateAssistantTranscriptText(text: string): string {
	const stripped = stripAssistantTranscriptDecoration(text);
	return normalizeAssistantMarkdown(stripped);
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
