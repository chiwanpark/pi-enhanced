import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";

import compactThresholdExtension from "./compact-threshold";
import editorExtension from "./editor";
import patchThemeExtension from "./patch-theme";
import statusCommandExtension from "./status-command";
import semanticDisciplineExtension from "./semantic-discipline";
import statusbarExtension from "./statusbar";
import tokenDisciplineExtension from "./token-discipline";
import transcriptExtension from "./transcript";
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
	transcriptExtension,
	tokenDisciplineExtension,
	semanticDisciplineExtension,
	compactThresholdExtension,
	editorExtension,
	statusbarExtension,
	statusCommandExtension,
);
