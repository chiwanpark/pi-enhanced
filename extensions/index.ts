import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import askUserExtension from "./ask-user";
import conciseBuiltinsExtension from "./concise-builtins";
import editorExtension from "./editor";
import fileToolsExtension from "./file-tools";
import harmfulCommandGuardExtension from "./harmful-command-guard";
import patchThemeExtension from "./patch-theme";
import planModeExtension from "./plan-mode";
import statusCommandExtension from "./status-command";
import semanticDisciplineExtension from "./semantic-discipline";
import statusbarExtension from "./statusbar";
import systemPromptCleanupExtension from "./system-prompt-cleanup";
import systemPromptCommandExtension from "./system-prompt-command";
import todoExtension from "./todo";
import transcriptExtension from "./transcript";
import usageCommandExtension from "./usage-command";
import webSearchExtension from "./web-search";
import welcomeExtension from "./welcome";

function composeExtensions(...extensions: ExtensionFactory[]): ExtensionFactory {
	return async function composedExtension(pi: ExtensionAPI): Promise<void> {
		for (const extension of extensions) {
			await extension(pi);
		}
	};
}

export default composeExtensions(
	welcomeExtension,
	patchThemeExtension,
	conciseBuiltinsExtension,
	transcriptExtension,
	harmfulCommandGuardExtension,
	semanticDisciplineExtension,
	todoExtension,
	askUserExtension,
	webSearchExtension,
	editorExtension,
	fileToolsExtension,
	planModeExtension,
	statusbarExtension,
	statusCommandExtension,
	usageCommandExtension,
	systemPromptCommandExtension,
	// Run last so no pi-enhanced prompt hook can append content after the cwd.
	systemPromptCleanupExtension,
);
