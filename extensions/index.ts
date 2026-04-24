import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";

import editorExtension from "./editor";
import patchThemeExtension from "./patch-theme";
import statusCommandExtension from "./status-command";
import statusbarExtension from "./statusbar";
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
	editorExtension,
	statusbarExtension,
	statusCommandExtension,
);
