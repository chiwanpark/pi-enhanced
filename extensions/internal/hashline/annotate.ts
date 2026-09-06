import type { LineRange } from "./store.ts";
import { formatHeader, formatNumberedLines } from "./text.ts";

const SHOWING_RANGE_RE = /^\[Showing lines (\d+)-(\d+) of \d+/;
const MORE_LINES_RE = /^\[\d+ more lines in file\. Use offset=(\d+)/;

export interface AnnotateInput {
	output: string;
	fileLines: readonly string[];
	displayPath: string;
	tag: string;
	offset: number;
	outputLines?: number;
}

export interface AnnotateResult {
	text: string;
	header: string;
	shownCount: number;
	shown: LineRange | undefined;
}

export function normalizeOutputLine(line: string, isFileStart: boolean): string {
	const withoutBom = isFileStart && line.startsWith("\uFEFF") ? line.slice(1) : line;
	return withoutBom.endsWith("\r") ? withoutBom.slice(0, -1) : withoutBom;
}

function matchesFile(
	outputLines: readonly string[],
	fileLines: readonly string[],
	offset: number,
	index: number,
): boolean {
	const line = outputLines[index];
	if (line === undefined) return false;
	return normalizeOutputLine(line, offset === 1 && index === 0) === fileLines[offset - 1 + index];
}

function longestPrefix(outputLines: readonly string[], fileLines: readonly string[], offset: number): number {
	const available = Math.max(0, fileLines.length - (offset - 1));
	const max = Math.min(available, outputLines.length);
	let count = 0;
	while (count < max && matchesFile(outputLines, fileLines, offset, count)) count++;
	return count;
}

function fromNotes(outputLines: readonly string[], offset: number): number | undefined {
	for (const line of outputLines) {
		const showing = SHOWING_RANGE_RE.exec(line);
		if (showing) {
			const start = Number(showing[1]);
			const end = Number(showing[2]);
			if (start === offset && end >= start) return end - start + 1;
			return undefined;
		}
		const more = MORE_LINES_RE.exec(line);
		if (more) {
			const next = Number(more[1]);
			if (next > offset) return next - offset;
			return undefined;
		}
	}
	return undefined;
}

function trailerIsNote(trailer: readonly string[]): boolean {
	const meaningful = trailer.filter((line) => line.trim() !== "");
	if (meaningful.length === 0) return true;
	return meaningful.every((line) => line.startsWith("[") && line.endsWith("]"));
}

export function inferShownCount(input: AnnotateInput, outputLines: readonly string[]): number | undefined {
	const available = Math.max(0, input.fileLines.length - (input.offset - 1));
	if (input.outputLines !== undefined) {
		return Math.min(input.outputLines, available, outputLines.length);
	}
	const noted = fromNotes(outputLines, input.offset);
	if (noted !== undefined) return Math.min(noted, available, outputLines.length);
	return longestPrefix(outputLines, input.fileLines, input.offset);
}

export function annotateReadOutput(input: AnnotateInput): AnnotateResult | undefined {
	if (input.offset < 1) return undefined;
	const outputLines = input.output.split("\n");
	const shownCount = inferShownCount(input, outputLines);
	if (shownCount === undefined) return undefined;

	const start = input.offset - 1;
	for (let index = 0; index < shownCount; index++) {
		if (!matchesFile(outputLines, input.fileLines, input.offset, index)) return undefined;
	}
	const trailer = outputLines.slice(shownCount);
	if (!trailerIsNote(trailer)) return undefined;

	const numbered = formatNumberedLines(input.fileLines.slice(start, start + shownCount), input.offset);
	const header = formatHeader(input.displayPath, input.tag);
	const text = [header, ...numbered, ...trailer].join("\n");
	if (shownCount === 0) return { text, header, shownCount, shown: undefined };
	return { text, header, shownCount, shown: { from: input.offset, to: input.offset + shownCount - 1 } };
}
