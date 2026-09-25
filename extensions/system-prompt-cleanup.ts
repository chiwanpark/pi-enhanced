import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refineSystemMessages } from "./internal/system-prompt";

export default function systemPromptCleanupExtension(pi: ExtensionAPI) {
	pi.on("context_with_system", async (event) => {
		const messages = refineSystemMessages(event.messages, getAgentDir());
		return messages ? { messages } : undefined;
	});
}
