export type AssistantContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: string };

export type AssistantMessageLike = {
	content: AssistantContentBlock[];
	stopReason?: string | undefined;
	errorMessage?: string | undefined;
};

export type AssistantTextBlock = Extract<AssistantContentBlock, { type: "text" }>;

export type AssistantUpdateRuntime = {
	updateContent(this: AssistantUpdateRuntime, message: AssistantMessageLike): void;
};
