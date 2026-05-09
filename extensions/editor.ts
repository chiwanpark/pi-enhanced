import { CustomEditor, type ExtensionAPI, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { installThemePatches, loadEditorBgAnsi, styleBlockLine } from "./patch-theme";

const CARET = "❯ ";
const CONTINUATION = "  ";

type AutocompleteListLike = {
	render(width: number): string[];
};

type EditorInternals = {
	paddingX?: number | undefined;
	autocompleteList?: AutocompleteListLike | undefined;
};

class StyledEditor extends CustomEditor {
	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getTheme: () => Theme,
	) {
		super(tui, editorTheme, keybindings);
	}

	private styleLine(text: string, width: number): string {
		return styleBlockLine(text, width, loadEditorBgAnsi(this.getTheme()));
	}

	private getAutocompleteLineCount(innerWidth: number): number {
		const { autocompleteList, paddingX = 0 } = this as unknown as EditorInternals;
		if (!autocompleteList) {
			return 0;
		}

		const contentWidth = Math.max(1, innerWidth - Math.min(paddingX, Math.floor((innerWidth - 1) / 2)) * 2);
		return autocompleteList.render(contentWidth).length;
	}

	override render(width: number): string[] {
		const innerWidth = Math.max(1, width - visibleWidth(CARET));
		const lines = super.render(innerWidth);
		const autocompleteLineCount = this.getAutocompleteLineCount(innerWidth);
		const bottomBorderIndex = Math.max(0, lines.length - 1 - autocompleteLineCount);
		const contentLines = lines.slice(1, bottomBorderIndex);
		const autocompleteLines = autocompleteLineCount > 0 ? lines.slice(bottomBorderIndex + 1) : [];
		const emptyLine = this.styleLine("", width);

		const caret = this.getTheme().fg("accent", CARET);

		return [
			emptyLine,
			...contentLines.map((line, index) => this.styleLine(`${index === 0 ? caret : CONTINUATION}${line}`, width)),
			...(autocompleteLines.length > 0 ? [emptyLine] : []),
			...autocompleteLines.map((line) => this.styleLine(line, width)),
			emptyLine,
		];
	}
}

export default function editorExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		installThemePatches(ctx.ui);

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			return new StyledEditor(tui, editorTheme, keybindings, () => ctx.ui.theme);
		});
	});
}
