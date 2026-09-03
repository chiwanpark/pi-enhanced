import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanSystemPrompt } from "./internal/system-prompt";

export default function systemPromptCleanupExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const systemPrompt = cleanSystemPrompt(
			event.systemPrompt,
			event.systemPromptOptions.cwd,
			Boolean(event.systemPromptOptions.customPrompt),
		);
		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});
}
