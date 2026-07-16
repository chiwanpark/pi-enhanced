import { readFileSync } from "node:fs";
import {
	AssistantMessageComponent,
	LoginDialogComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	ModelSelectorComponent,
	OAuthSelectorComponent,
	SettingsSelectorComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, Loader, SelectList, SettingsList } from "@earendil-works/pi-tui";
import { installAssistantMarkdownPatch } from "./internal/assistant-markdown";
import { installAssistantMessageFormatPatch } from "./internal/assistant-message-format";
import { installAssistantMessageGapPatch } from "./internal/assistant-message-gap";
import { fitVisible } from "./internal/common";

const ANSI_RESET = "\x1b[0m";
const CARET = "❯ ";
const PANEL_PADDING_X = 1;
const HISTORY_MESSAGE_PADDING_X = 1;
const STARTUP_RESOURCE_PADDING_X = 1;
const WORKING_INDICATOR_PADDING_X = 1;

type ThemeColorValue = string | number;

type ThemeFile = {
	name?: string | undefined;
	vars?: Record<string, ThemeColorValue | undefined> | undefined;
};

type RenderMethod<T> = (this: T, width: number) => string[];

type SelectListLike = {
	render(width: number): string[];
	__piEnhancedEditorThemePatched?: boolean | undefined;
};

type SettingsListLike = {
	render(width: number): string[];
	__piEnhancedEditorThemePatched?: boolean | undefined;
};

type SettingsPanelLike = {
	render(width: number): string[];
	__piEnhancedEditorThemePatched?: boolean | undefined;
};

type InputLike = {
	render(width: number): string[];
	__piEnhancedCaretPatched?: boolean | undefined;
};

type LoaderLike = {
	kind?: unknown;
	render(width: number): string[];
	__piEnhancedIndicatorPaddingPatched?: boolean | undefined;
};

type AssistantMessageLike = {
	content: Array<{ type: string; text?: string | undefined; thinking?: string | undefined }>;
	stopReason?: string | undefined;
	errorMessage?: string | undefined;
};

type AssistantMessageComponentLike = {
	updateContent(message: AssistantMessageLike): void;
	contentContainer?: { children?: unknown[] } | undefined;
	__piEnhancedAssistantIndentPatched?: boolean | undefined;
};

type UserMessageComponentLike = {
	render(width: number): string[];
	contentBox?: unknown;
	children?: unknown[] | undefined;
	__piEnhancedUserIndentPatched?: boolean | undefined;
};

type ToolExecutionComponentLike = {
	render(width: number): string[];
	contentBox?: unknown;
	contentText?: unknown;
	__piEnhancedToolOutputPaddingPatched?: boolean | undefined;
};

type PaddedComponentLike = {
	paddingX?: unknown;
	invalidate?: unknown;
	setBgFn?: ((bgFn: (content: string) => string) => void) | undefined;
};

type ThemedComponentLike = {
	render(width: number): string[];
	__piEnhancedEditorThemePatched?: boolean | undefined;
};

type ContainerLike = {
	children?: unknown[] | undefined;
	constructor: { name?: string | undefined };
	render(width: number): string[];
	__piEnhancedPanelThemePatched?: boolean | undefined;
};

type ThemeSource = {
	theme: Theme;
};

let patchesInstalled = false;
let themeSource: ThemeSource | undefined;
let lastKnownTheme: Theme | undefined;

function bindThemeSource(source: ThemeSource): void {
	themeSource = source;

	try {
		lastKnownTheme = source.theme;
	} catch {
		// Ignore invalidated extension contexts during shutdown.
	}
}

function getActiveTheme(): Theme {
	if (themeSource) {
		try {
			const theme = themeSource.theme;
			lastKnownTheme = theme;
			return theme;
		} catch {
			// Session shutdown/replacement can invalidate the UI context. Fall back to
			// the last usable theme so patched renderers do not crash during teardown.
		}
	}

	if (lastKnownTheme) {
		return lastKnownTheme;
	}

	throw new Error("Theme patches were used before a UI theme was available");
}

function markEditorThemePatched(prototype: { __piEnhancedEditorThemePatched?: boolean | undefined }): boolean {
	if (prototype.__piEnhancedEditorThemePatched) {
		return true;
	}

	prototype.__piEnhancedEditorThemePatched = true;
	return false;
}

function markIndicatorPaddingPatched(prototype: {
	__piEnhancedIndicatorPaddingPatched?: boolean | undefined;
}): boolean {
	if (prototype.__piEnhancedIndicatorPaddingPatched) {
		return true;
	}

	prototype.__piEnhancedIndicatorPaddingPatched = true;
	return false;
}

function markAssistantIndentPatched(prototype: { __piEnhancedAssistantIndentPatched?: boolean | undefined }): boolean {
	if (prototype.__piEnhancedAssistantIndentPatched) {
		return true;
	}

	prototype.__piEnhancedAssistantIndentPatched = true;
	return false;
}

function markUserIndentPatched(prototype: { __piEnhancedUserIndentPatched?: boolean | undefined }): boolean {
	if (prototype.__piEnhancedUserIndentPatched) {
		return true;
	}

	prototype.__piEnhancedUserIndentPatched = true;
	return false;
}

function markToolOutputPaddingPatched(prototype: {
	__piEnhancedToolOutputPaddingPatched?: boolean | undefined;
}): boolean {
	if (prototype.__piEnhancedToolOutputPaddingPatched) {
		return true;
	}

	prototype.__piEnhancedToolOutputPaddingPatched = true;
	return false;
}

function resolveThemeVar(
	value: ThemeColorValue | undefined,
	vars: Record<string, ThemeColorValue | undefined> | undefined,
	seen = new Set<string>(),
): ThemeColorValue | undefined {
	if (value == null || typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (seen.has(value)) {
		return undefined;
	}

	const next = vars?.[value];
	if (next == null) {
		return undefined;
	}

	seen.add(value);
	return resolveThemeVar(next, vars, seen);
}

function colorValueToBgAnsi(value: ThemeColorValue | undefined): string | undefined {
	if (value == null) {
		return undefined;
	}
	if (value === "") {
		return "\x1b[49m";
	}
	if (typeof value === "number") {
		return `\x1b[48;5;${value}m`;
	}
	if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
		return undefined;
	}

	const r = Number.parseInt(value.slice(1, 3), 16);
	const g = Number.parseInt(value.slice(3, 5), 16);
	const b = Number.parseInt(value.slice(5, 7), 16);
	return `\x1b[48;2;${r};${g};${b}m`;
}

export function loadEditorBgAnsi(theme: Theme): string {
	const fallback = theme.getBgAnsi("customMessageBg");
	if (!theme.sourcePath) {
		return fallback;
	}

	try {
		const { vars } = JSON.parse(readFileSync(theme.sourcePath, "utf8")) as ThemeFile;
		const value = resolveThemeVar(vars?.editorBg, vars);
		return colorValueToBgAnsi(value) ?? fallback;
	} catch {
		return fallback;
	}
}

function applyBackground(text: string, bgAnsi: string): string {
	return `${bgAnsi}${text.split(ANSI_RESET).join(`${ANSI_RESET}${bgAnsi}`)}${ANSI_RESET}`;
}

export function styleBlockLine(text: string, width: number, bgAnsi: string): string {
	return applyBackground(fitVisible(text, width), bgAnsi);
}

function stripPlainPrefix(line: string, prefix: string): string {
	return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

function trimLeadingVisibleSpace(line: string, width: number): string {
	if (!line.startsWith(" ")) {
		return line;
	}
	return fitVisible(line.slice(1), width);
}

function patchInputPrototype(prototype: InputLike): void {
	if (prototype.__piEnhancedCaretPatched) {
		return;
	}

	prototype.__piEnhancedCaretPatched = true;
	const originalRender = prototype.render as RenderMethod<InputLike>;
	prototype.render = function render(width: number): string[] {
		return originalRender.call(this, width + 2).map((line) => fitVisible(stripPlainPrefix(line, "> "), width));
	};
}

function patchLoaderPrototype(prototype: LoaderLike): void {
	if (markIndicatorPaddingPatched(prototype)) {
		return;
	}

	const originalRender = prototype.render as RenderMethod<LoaderLike>;
	prototype.render = function render(width: number): string[] {
		const isWorkingIndicator = this.kind === "working";
		if (isWorkingIndicator) {
			setHorizontalPadding(this, WORKING_INDICATOR_PADDING_X);
		}

		const lines = originalRender.call(this, width);
		return isWorkingIndicator ? lines : lines.map((line) => trimLeadingVisibleSpace(line, width));
	};
}

function setHorizontalPadding(component: unknown, paddingX: number): void {
	if (!component || typeof component !== "object") {
		return;
	}

	const padded = component as PaddedComponentLike;
	if (typeof padded.paddingX !== "number" || padded.paddingX === paddingX) {
		return;
	}

	padded.paddingX = paddingX;
	if (typeof padded.invalidate === "function") {
		padded.invalidate();
	}
}

function applyAssistantContentPadding(component: AssistantMessageComponentLike): void {
	for (const child of component.contentContainer?.children ?? []) {
		if (!child || typeof child !== "object" || typeof (child as PaddedComponentLike).paddingX !== "number") {
			continue;
		}

		setHorizontalPadding(child, HISTORY_MESSAGE_PADDING_X);
	}
}

function patchAssistantMessagePrototype(prototype: AssistantMessageComponentLike): void {
	if (markAssistantIndentPatched(prototype)) {
		return;
	}

	const originalUpdateContent = prototype.updateContent;
	prototype.updateContent = function updateContent(message: AssistantMessageLike): void {
		originalUpdateContent.call(this, message);
		applyAssistantContentPadding(this);
	};
}

function applyEditorBackground(component: unknown, bgAnsi: string): void {
	if (!component || typeof component !== "object") {
		return;
	}

	const renderable = component as PaddedComponentLike;
	if (typeof renderable.setBgFn !== "function") {
		return;
	}

	renderable.setBgFn((content) => applyBackground(content, bgAnsi));
}

function patchToolExecutionPrototype(prototype: ToolExecutionComponentLike): void {
	if (markToolOutputPaddingPatched(prototype)) {
		return;
	}

	const originalRender = prototype.render as RenderMethod<ToolExecutionComponentLike>;
	prototype.render = function render(width: number): string[] {
		setHorizontalPadding(this.contentBox, HISTORY_MESSAGE_PADDING_X);
		setHorizontalPadding(this.contentText, HISTORY_MESSAGE_PADDING_X);
		return originalRender.call(this, width);
	};
}

function findUserContentBox(component: UserMessageComponentLike): unknown {
	if (component.contentBox) {
		return component.contentBox;
	}

	return component.children?.find(
		(child) => child && typeof child === "object" && typeof (child as PaddedComponentLike).setBgFn === "function",
	);
}

function patchUserMessagePrototype(prototype: UserMessageComponentLike, getTheme: () => Theme): void {
	if (markUserIndentPatched(prototype)) {
		return;
	}

	const originalRender = prototype.render as RenderMethod<UserMessageComponentLike>;
	prototype.render = function render(width: number): string[] {
		const contentBox = findUserContentBox(this);
		setHorizontalPadding(contentBox, HISTORY_MESSAGE_PADDING_X);
		applyEditorBackground(contentBox, loadEditorBgAnsi(getTheme()));
		return originalRender.call(this, width);
	};
}

function patchSelectListPrototype(prototype: SelectListLike, getTheme: () => Theme): void {
	if (markEditorThemePatched(prototype)) {
		return;
	}

	const originalRender = prototype.render as RenderMethod<SelectListLike>;
	prototype.render = function render(width: number): string[] {
		const bgAnsi = loadEditorBgAnsi(getTheme());
		return originalRender.call(this, width).map((line) => styleBlockLine(line, width, bgAnsi));
	};
}

function patchSettingsListPrototype(prototype: SettingsListLike, getTheme: () => Theme): void {
	if (markEditorThemePatched(prototype)) {
		return;
	}

	const originalRender = prototype.render as RenderMethod<SettingsListLike>;
	prototype.render = function render(width: number): string[] {
		const theme = getTheme();
		const bgAnsi = loadEditorBgAnsi(theme);
		const caret = theme.fg("accent", CARET);
		return originalRender.call(this, width).map((line) => {
			const styledLine = line.startsWith("> ") ? `${caret}${stripPlainPrefix(line, "> ")}` : line;
			return styleBlockLine(styledLine, width, bgAnsi);
		});
	};
}

function patchSettingsPanelPrototype(prototype: SettingsPanelLike, getTheme: () => Theme): void {
	if (markEditorThemePatched(prototype)) {
		return;
	}

	const originalRender = prototype.render as RenderMethod<SettingsPanelLike>;
	prototype.render = function render(width: number): string[] {
		const lines = originalRender.call(this, width);
		const lastLineIndex = lines.length - 1;
		const bgAnsi = loadEditorBgAnsi(getTheme());
		return lines.map((line, index) =>
			styleBlockLine(index === 0 || index === lastLineIndex ? "" : line, width, bgAnsi),
		);
	};
}

function getComponentName(component: unknown): string | undefined {
	if (!component || typeof component !== "object") {
		return undefined;
	}

	return (component as { constructor?: { name?: string | undefined } | undefined }).constructor?.name;
}

function applyStartupResourcePadding(component: ContainerLike): void {
	for (const child of component.children ?? []) {
		if (getComponentName(child) === "ExpandableText") {
			setHorizontalPadding(child, STARTUP_RESOURCE_PADDING_X);
		}
	}
}

function isPanelContainer(component: ContainerLike): boolean {
	const children = component.children ?? [];
	return getComponentName(children[0]) === "DynamicBorder" && getComponentName(children.at(-1)) === "DynamicBorder";
}

function patchPanelContainerPrototype(prototype: ContainerLike, getTheme: () => Theme): void {
	if (prototype.__piEnhancedPanelThemePatched) {
		return;
	}

	prototype.__piEnhancedPanelThemePatched = true;
	const originalRender = prototype.render as RenderMethod<ContainerLike>;
	prototype.render = function render(width: number): string[] {
		applyStartupResourcePadding(this);

		if (!isPanelContainer(this)) {
			return originalRender.call(this, width);
		}

		const paddingX = Math.min(PANEL_PADDING_X, Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - paddingX * 2);
		const padding = " ".repeat(paddingX);
		const lines = originalRender
			.call(this, contentWidth)
			.map((line) => `${padding}${fitVisible(line, contentWidth)}${padding}`);
		if (this.constructor.name !== "ScopedModelsSelectorComponent") {
			return lines;
		}

		const theme = getTheme();
		const bgAnsi = loadEditorBgAnsi(theme);
		const caret = theme.fg("accent", CARET);
		const contentLines = lines.slice(1, -1);
		contentLines.push("");
		return contentLines.map((line) => {
			const styledLine = line.startsWith("> ") ? `${caret}${stripPlainPrefix(line, "> ")}` : line;
			return styleBlockLine(styledLine, width, bgAnsi);
		});
	};
}

function patchEditorThemedComponentPrototype(
	prototype: ThemedComponentLike,
	getTheme: () => Theme,
	hideSurroundingLines = false,
): void {
	if (markEditorThemePatched(prototype)) {
		return;
	}

	const originalRender = prototype.render as RenderMethod<ThemedComponentLike>;
	prototype.render = function render(width: number): string[] {
		const theme = getTheme();
		const bgAnsi = loadEditorBgAnsi(theme);
		const caret = theme.fg("accent", CARET);
		const lines = originalRender.call(this, width);
		const contentLines = hideSurroundingLines ? lines.slice(1, -1) : lines;
		return contentLines.map((line) => {
			const styledLine = line.startsWith("> ") ? `${caret}${stripPlainPrefix(line, "> ")}` : line;
			return styleBlockLine(styledLine, width, bgAnsi);
		});
	};
}

export function installThemePatches(source?: ThemeSource): void {
	if (source) {
		bindThemeSource(source);
	}

	if (patchesInstalled) {
		return;
	}
	patchesInstalled = true;

	const getTheme = () => getActiveTheme();

	installAssistantMessageFormatPatch();
	installAssistantMarkdownPatch();
	installAssistantMessageGapPatch();

	patchPanelContainerPrototype(Container.prototype, getTheme);
	patchInputPrototype(Input.prototype);
	patchLoaderPrototype(Loader.prototype);
	patchAssistantMessagePrototype(AssistantMessageComponent.prototype as unknown as AssistantMessageComponentLike);
	patchToolExecutionPrototype(ToolExecutionComponent.prototype as unknown as ToolExecutionComponentLike);
	patchUserMessagePrototype(UserMessageComponent.prototype as unknown as UserMessageComponentLike, getTheme);
	patchSelectListPrototype(SelectList.prototype, getTheme);
	patchSettingsListPrototype(SettingsList.prototype, getTheme);
	patchSettingsPanelPrototype(SettingsSelectorComponent.prototype, getTheme);
	patchEditorThemedComponentPrototype(ModelSelectorComponent.prototype, getTheme, true);
	patchEditorThemedComponentPrototype(OAuthSelectorComponent.prototype, getTheme);
	patchEditorThemedComponentPrototype(LoginDialogComponent.prototype, getTheme);
}

export default function patchThemeExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}

		installThemePatches(ctx.ui);
	});
}
