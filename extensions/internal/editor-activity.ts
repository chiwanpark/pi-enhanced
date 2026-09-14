export const EDITOR_INPUT_EVENT = "pi-enhanced:editor-input";

export type EditorInputActivity = {
	at: number;
};

export function isEditorInputActivity(value: unknown): value is EditorInputActivity {
	return typeof value === "object" && value !== null && typeof (value as { at?: unknown }).at === "number";
}
