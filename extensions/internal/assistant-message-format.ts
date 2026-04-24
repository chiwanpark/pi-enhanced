import { AssistantMessageComponent } from "@mariozechner/pi-coding-agent";

import { normalizeAssistantMarkdown } from "./assistant-format";
import type {
	AssistantContentBlock,
	AssistantMessageLike,
	AssistantTextBlock,
	AssistantUpdateRuntime,
} from "./assistant-message-types";

const ASSISTANT_MESSAGE_FORMAT_PATCH = Symbol.for("pi-enhanced.assistant-message-format-patch");

type AssistantMessageRuntime = AssistantUpdateRuntime & {
	[ASSISTANT_MESSAGE_FORMAT_PATCH]?: boolean | undefined;
};

function isTextBlock(block: AssistantContentBlock): block is AssistantTextBlock {
	return block.type === "text" && "text" in block;
}

function normalizeAssistantMessage(message: AssistantMessageLike): AssistantMessageLike {
	return {
		...message,
		content: message.content.map((block) =>
			isTextBlock(block) ? { ...block, text: normalizeAssistantMarkdown(block.text) } : block,
		),
	};
}

export function installAssistantMessageFormatPatch(): void {
	const prototype = AssistantMessageComponent.prototype as unknown as AssistantMessageRuntime;
	if (prototype[ASSISTANT_MESSAGE_FORMAT_PATCH]) {
		return;
	}

	const originalUpdateContent = prototype.updateContent;
	prototype.updateContent = function patchedUpdateContent(
		this: AssistantMessageRuntime,
		message: AssistantMessageLike,
	): void {
		originalUpdateContent.call(this, normalizeAssistantMessage(message));
	};

	prototype[ASSISTANT_MESSAGE_FORMAT_PATCH] = true;
}
