import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

interface SystemPromptEntryData {
	prompt: string;
}

const CUSTOM_TYPE = "system-prompt";

function renderSystemPrompt(prompt: string, theme: Theme): Box {
	const title = `System prompt (${prompt.length.toLocaleString()} characters)`;
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(`${theme.fg("accent", theme.bold(title))}\n\n${prompt}`, 0, 0));
	return box;
}

export default function systemPromptCommandExtension(pi: ExtensionAPI) {
	// Retain rendering for entries created by earlier versions of this extension.
	pi.registerEntryRenderer<SystemPromptEntryData>(CUSTOM_TYPE, (entry, _options, theme) =>
		renderSystemPrompt(entry.data?.prompt ?? "", theme),
	);

	pi.registerMessageRenderer(CUSTOM_TYPE, (message, _options, theme) => {
		const prompt =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("");
		return renderSystemPrompt(prompt, theme);
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== CUSTOM_TYPE),
	}));

	pi.registerCommand("system-prompt", {
		description: "Show the current effective system prompt",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("system-prompt requires interactive UI", "error");
				return;
			}

			const prompt = ctx.getSystemPrompt();
			// Custom messages emit RPC message events, unlike custom entries. Waiting
			// avoids turning this display-only response into a steering message.
			await ctx.waitForIdle();
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: prompt,
				display: true,
			});
		},
	});
}
