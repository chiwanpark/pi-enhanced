import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

import type { AssistantContentBlock, AssistantMessageLike, AssistantUpdateRuntime } from "./assistant-message-types";

const ASSISTANT_MESSAGE_GAP_PATCH = Symbol.for("pi-enhanced.assistant-message-gap-patch");
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type AssistantMessageRuntime = AssistantUpdateRuntime & {
	hideThinkingBlock?: boolean | undefined;
	hiddenThinkingLabel?: string | undefined;
	[ASSISTANT_MESSAGE_GAP_PATCH]?: boolean | undefined;
};

function isEmptyHiddenThinkingLabel(component: AssistantMessageRuntime): boolean {
	return (component.hiddenThinkingLabel ?? "").replace(ANSI_PATTERN, "").trim() === "";
}

function shouldStripHiddenThinking(component: AssistantMessageRuntime): boolean {
	return Boolean(component.hideThinkingBlock) && isEmptyHiddenThinkingLabel(component);
}

function isNonEmptyThinkingBlock(block: AssistantContentBlock): block is { type: "thinking"; thinking: string } {
	return block.type === "thinking" && "thinking" in block && Boolean(block.thinking.trim());
}

function stripHiddenThinkingBlocks(message: AssistantMessageLike): AssistantMessageLike {
	return {
		...message,
		content: message.content.filter((block) => !isNonEmptyThinkingBlock(block)),
	};
}

export function installAssistantMessageGapPatch(): void {
	const prototype = AssistantMessageComponent.prototype as unknown as AssistantMessageRuntime;
	if (prototype[ASSISTANT_MESSAGE_GAP_PATCH]) {
		return;
	}

	const originalUpdateContent = prototype.updateContent;
	prototype.updateContent = function patchedUpdateContent(
		this: AssistantMessageRuntime,
		message: AssistantMessageLike,
	): void {
		originalUpdateContent.call(this, shouldStripHiddenThinking(this) ? stripHiddenThinkingBlocks(message) : message);
	};

	prototype[ASSISTANT_MESSAGE_GAP_PATCH] = true;
}
