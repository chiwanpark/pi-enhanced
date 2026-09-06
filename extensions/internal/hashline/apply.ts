import {
	formatRanges,
	isRangeSeen,
	shiftRanges,
	unseenLines,
	type EditSpan,
	type LineRange,
	type Snapshot,
} from "./store.ts";
import { joinLines } from "./text.ts";

export const EDIT_OPS = ["replace", "insert_before", "insert_after", "delete"] as const;

export type EditOp = (typeof EDIT_OPS)[number];

export interface HashlineEdit {
	op: EditOp;
	from: number;
	to?: number;
	lines?: string[];
}

export interface AppliedRegion {
	from: number;
	to: number;
}

export interface ApplyResult {
	content: string;
	lines: string[];
	regions: AppliedRegion[];
	spans: EditSpan[];
	addedLines: number;
	removedLines: number;
}

export class HashlineEditError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(`[${code}] ${message}`);
		this.name = "HashlineEditError";
		this.code = code;
	}
}

interface PreparedEdit {
	index: number;
	op: EditOp;
	start: number;
	end: number;
	lines: string[];
	anchorFrom: number;
	anchorTo: number;
}

function describeEdit(edit: PreparedEdit): string {
	return `edits[${edit.index}] (${edit.op} ${edit.anchorTo >= edit.anchorFrom ? `${edit.anchorFrom}-${edit.anchorTo}` : edit.anchorFrom})`;
}

function requireInteger(value: number, label: string, index: number): number {
	if (!Number.isInteger(value)) {
		throw new HashlineEditError("E_BAD_RANGE", `edits[${index}].${label} must be an integer line number.`);
	}
	return value;
}

function prepare(edit: HashlineEdit, index: number, lineCount: number): PreparedEdit {
	if (!EDIT_OPS.includes(edit.op)) {
		throw new HashlineEditError("E_BAD_OP", `edits[${index}].op must be one of ${EDIT_OPS.join(", ")}.`);
	}
	const from = requireInteger(edit.from, "from", index);
	const lines = edit.lines ?? [];

	if (edit.op === "delete") {
		if (lines.length > 0) {
			throw new HashlineEditError("E_BAD_OP", `edits[${index}] is a delete and must not carry lines.`);
		}
		const to = requireInteger(edit.to ?? from, "to", index);
		if (from < 1 || to > lineCount) {
			throw new HashlineEditError(
				"E_BAD_RANGE",
				`edits[${index}] targets lines ${from}-${to} but the file has ${lineCount} lines.`,
			);
		}
		if (to < from) {
			throw new HashlineEditError("E_BAD_RANGE", `edits[${index}].to (${to}) is before .from (${from}).`);
		}
		return { index, op: edit.op, start: from - 1, end: to, lines: [], anchorFrom: from, anchorTo: to };
	}

	if (edit.op === "replace") {
		const to = requireInteger(edit.to ?? from, "to", index);
		if (from < 1 || to > lineCount) {
			throw new HashlineEditError(
				"E_BAD_RANGE",
				`edits[${index}] targets lines ${from}-${to} but the file has ${lineCount} lines.`,
			);
		}
		if (to < from) {
			throw new HashlineEditError("E_BAD_RANGE", `edits[${index}].to (${to}) is before .from (${from}).`);
		}
		return { index, op: edit.op, start: from - 1, end: to, lines, anchorFrom: from, anchorTo: to };
	}

	if (lines.length === 0) {
		throw new HashlineEditError("E_BAD_OP", `edits[${index}] is an ${edit.op} and needs at least one line.`);
	}
	if (edit.to !== undefined) {
		throw new HashlineEditError("E_BAD_OP", `edits[${index}] is an ${edit.op} and must not carry .to.`);
	}

	if (edit.op === "insert_before") {
		const upperBound = Math.max(lineCount, 1);
		if (from < 1 || from > upperBound) {
			throw new HashlineEditError(
				"E_BAD_RANGE",
				`edits[${index}] inserts before line ${from} but the file has ${lineCount} lines.`,
			);
		}
		const anchor = Math.min(from, lineCount);
		return { index, op: edit.op, start: from - 1, end: from - 1, lines, anchorFrom: anchor, anchorTo: anchor };
	}

	if (from < 0 || from > lineCount) {
		throw new HashlineEditError(
			"E_BAD_RANGE",
			`edits[${index}] inserts after line ${from} but the file has ${lineCount} lines (use 0 for the start of the file).`,
		);
	}
	const anchor = from === 0 ? Math.min(1, lineCount) : from;
	return { index, op: edit.op, start: from, end: from, lines, anchorFrom: anchor, anchorTo: anchor };
}

function assertSeen(prepared: PreparedEdit[], snapshot: Snapshot): void {
	if (snapshot.lines.length === 0) return;
	for (const edit of prepared) {
		if (edit.anchorTo < edit.anchorFrom || edit.anchorFrom < 1) continue;
		if (isRangeSeen(snapshot.seen, edit.anchorFrom, edit.anchorTo)) continue;
		const missing = unseenLines(snapshot.seen, edit.anchorFrom, edit.anchorTo);
		throw new HashlineEditError(
			"E_UNSEEN",
			`${describeEdit(edit)} touches line(s) ${formatRanges([{ from: missing[0] ?? edit.anchorFrom, to: missing[missing.length - 1] ?? edit.anchorTo }])} that were never displayed. Lines shown so far: ${formatRanges(snapshot.seen)}. Read the target range first.`,
		);
	}
}

function assertDisjoint(prepared: PreparedEdit[]): void {
	const sorted = [...prepared].sort((a, b) => a.start - b.start || a.end - b.end);
	for (let index = 1; index < sorted.length; index++) {
		const previous = sorted[index - 1];
		const current = sorted[index];
		if (!previous || !current) continue;
		const previousEmpty = previous.start === previous.end;
		const currentEmpty = current.start === current.end;
		if (previousEmpty && currentEmpty && previous.start === current.start) {
			throw new HashlineEditError(
				"E_OVERLAP",
				`${describeEdit(previous)} and ${describeEdit(current)} insert at the same position. Merge them into one edit.`,
			);
		}
		if (current.start < previous.end) {
			throw new HashlineEditError(
				"E_OVERLAP",
				`${describeEdit(previous)} and ${describeEdit(current)} overlap. Target disjoint ranges or merge them into one edit.`,
			);
		}
	}
}

export function applyHashlineEdits(snapshot: Snapshot, edits: readonly HashlineEdit[]): ApplyResult {
	if (edits.length === 0) {
		throw new HashlineEditError("E_NO_EDITS", "edits must contain at least one operation.");
	}
	const lineCount = snapshot.lines.length;
	const prepared = edits.map((edit, index) => prepare(edit, index, lineCount));
	assertSeen(prepared, snapshot);
	assertDisjoint(prepared);

	const ordered = [...prepared].sort((a, b) => a.start - b.start || a.end - b.end);
	const result = [...snapshot.lines];
	const regions: AppliedRegion[] = [];
	const spans: EditSpan[] = [];
	let addedLines = 0;
	let removedLines = 0;
	let delta = 0;

	for (const edit of ordered) {
		const removed = edit.end - edit.start;
		result.splice(edit.start + delta, removed, ...edit.lines);
		const from = edit.start + delta + 1;
		regions.push({ from, to: from + edit.lines.length - 1 });
		spans.push({ start: edit.start, end: edit.end, delta: edit.lines.length - removed });
		addedLines += edit.lines.length;
		removedLines += removed;
		delta += edit.lines.length - removed;
	}

	const content = joinLines(result, snapshot.content === "" ? true : snapshot.content.endsWith("\n"));
	if (content === snapshot.content) {
		throw new HashlineEditError("E_NO_CHANGE", "the edits produced identical content.");
	}
	if (result.length === 0 && lineCount > 0) {
		throw new HashlineEditError("E_WOULD_EMPTY", "the edits would empty the file. Use write for a full rewrite.");
	}

	return { content, lines: result, regions, spans, addedLines, removedLines };
}

export function collectSeenAfterEdit(snapshot: Snapshot, spans: readonly EditSpan[]): LineRange[] {
	return snapshot.seen.length === 0 ? [] : shiftRanges(snapshot.seen, spans);
}
