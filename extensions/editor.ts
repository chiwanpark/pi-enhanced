import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { EDITOR_INPUT_EVENT, type EditorInputActivity } from "./internal/editor-activity";

class ActivityTrackingEditor extends CustomEditor {
	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly onInput: () => void,
	) {
		super(tui, editorTheme, keybindings, { embedWorkingStatus: true });
	}

	override handleInput(data: string): void {
		super.handleInput(data);
		this.onInput();
	}
}

export default function editorExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			return new ActivityTrackingEditor(tui, editorTheme, keybindings, () =>
				pi.events.emit(EDITOR_INPUT_EVENT, { at: Date.now() } satisfies EditorInputActivity),
			);
		});
	});
}
