import type { AppliedRegion } from "./apply.ts";
import { mergeRanges, type LineRange } from "./store.ts";
import { formatHeader } from "./text.ts";

export const PREVIEW_CONTEXT_LINES = 2;
export const PREVIEW_MAX_LINES = 120;
export const PREVIEW_MAX_BYTES = 16 * 1024;

export interface PreviewOptions {
	contextLines?: number;
	maxLines?: number;
	maxBytes?: number;
}

export interface PreviewResult {
	text: string;
	shown: LineRange[];
	truncated: boolean;
}

export function buildPreview(
	displayPath: string,
	tag: string,
	lines: readonly string[],
	regions: readonly AppliedRegion[],
	options?: PreviewOptions,
): PreviewResult {
	const contextLines = options?.contextLines ?? PREVIEW_CONTEXT_LINES;
	const maxLines = options?.maxLines ?? PREVIEW_MAX_LINES;
	const maxBytes = options?.maxBytes ?? PREVIEW_MAX_BYTES;

	const windows = mergeRanges(
		regions.map((region) => ({
			from: Math.max(1, Math.min(region.from, region.to) - contextLines),
			to: Math.min(lines.length, Math.max(region.from - 1, region.to) + contextLines),
		})),
	).filter((range) => range.to >= range.from);

	const body: string[] = [];
	const shown: LineRange[] = [];
	let budget = maxLines;
	let bytes = 0;
	let truncated = false;
	let pendingSeparator = false;

	for (const window of windows) {
		if (budget <= 0) {
			truncated = true;
			break;
		}
		const wanted = window.to - window.from + 1;
		const limit = Math.min(budget, wanted);
		let emitted = 0;
		for (let offset = 0; offset < limit; offset++) {
			const lineNumber = window.from + offset;
			const text = `${lineNumber}:${lines[lineNumber - 1] ?? ""}`;
			const size = Buffer.byteLength(text, "utf-8") + 1;
			if (bytes + size > maxBytes) {
				truncated = true;
				break;
			}
			if (pendingSeparator) {
				body.push("...");
				pendingSeparator = false;
			}
			body.push(text);
			bytes += size;
			emitted++;
		}
		if (emitted > 0) {
			shown.push({ from: window.from, to: window.from + emitted - 1 });
			pendingSeparator = true;
		}
		budget -= emitted;
		if (emitted < wanted) {
			truncated = true;
			break;
		}
	}

	const header = formatHeader(displayPath, tag);
	const notice = truncated ? "\n[Preview truncated. Read the file for the full picture.]" : "";
	const text = body.length > 0 ? `${header}\n${body.join("\n")}${notice}` : `${header}${notice}`;
	return { text, shown: mergeRanges(shown), truncated };
}

export function summarizeEdit(count: number, addedLines: number, removedLines: number): string {
	const plural = count === 1 ? "edit" : "edits";
	return `Applied ${count} ${plural} (+${addedLines} -${removedLines} lines). Current content with fresh line numbers:`;
}
