import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function getPackageVersion(): string {
	try {
		const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version?: unknown;
		};
		return typeof packageJson.version === "string" ? packageJson.version : "dev";
	} catch {
		return "dev";
	}
}

export function withHomeTilde(inputPath: string): string {
	const home = os.homedir();
	if (home && inputPath.startsWith(home)) {
		return `~${inputPath.slice(home.length)}`;
	}
	return inputPath;
}

export function getGlobalPiSettingsPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

export function getProjectPiSettingsPath(cwd: string): string {
	return path.join(cwd, ".pi", "settings.json");
}

export type DrawBoxOptions = {
	indent?: string;
	paddingX?: number;
	maxWidth?: number;
	preferredContentWidth?: number;
	minContentWidth?: number;
};

export function fitVisible(text: string, width: number): string {
	const truncated = truncateToWidth(text, width);
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

export function drawBox(theme: Theme, contents: readonly string[], options: DrawBoxOptions = {}): string[] {
	const indent = options.indent ?? "";
	const paddingX = Math.max(0, options.paddingX ?? 0);
	const naturalContentWidth = contents.length === 0 ? 0 : Math.max(...contents.map((line) => visibleWidth(line)));
	const preferredContentWidth = Math.max(
		0,
		options.preferredContentWidth ?? naturalContentWidth,
		options.minContentWidth ?? 0,
	);
	const reservedWidth = visibleWidth(indent) + 2 + paddingX * 2;
	const maxContentWidth =
		options.maxWidth == null ? preferredContentWidth : Math.max(0, options.maxWidth - reservedWidth);
	const contentWidth = Math.min(preferredContentWidth, maxContentWidth);
	const padding = " ".repeat(paddingX);
	const horizontal = "─".repeat(contentWidth + paddingX * 2);
	const border = (text: string) => theme.fg("border", text);

	return [
		`${indent}${border(`╭${horizontal}╮`)}`,
		...contents.map(
			(line) => `${indent}${border("│")}${padding}${fitVisible(line, contentWidth)}${padding}${border("│")}`,
		),
		`${indent}${border(`╰${horizontal}╯`)}`,
	];
}
