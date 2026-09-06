import { computeTag, splitLines } from "./text.ts";

export interface LineRange {
	from: number;
	to: number;
}

export interface Snapshot {
	path: string;
	tag: string;
	content: string;
	lines: string[];
	seen: LineRange[];
}

export const DEFAULT_MAX_PATHS = 128;
export const DEFAULT_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
	const sorted = [...ranges].filter((range) => range.to >= range.from).sort((a, b) => a.from - b.from);
	const merged: LineRange[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.from <= last.to + 1) {
			last.to = Math.max(last.to, range.to);
			continue;
		}
		merged.push({ from: range.from, to: range.to });
	}
	return merged;
}

export function isRangeSeen(seen: readonly LineRange[], from: number, to: number): boolean {
	if (to < from) return true;
	return seen.some((range) => range.from <= from && range.to >= to);
}

export function unseenLines(seen: readonly LineRange[], from: number, to: number): number[] {
	const missing: number[] = [];
	for (let line = from; line <= to; line++) {
		if (!seen.some((range) => range.from <= line && range.to >= line)) missing.push(line);
	}
	return missing;
}

export function formatRanges(ranges: readonly LineRange[]): string {
	if (ranges.length === 0) return "none";
	return ranges.map((range) => (range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`)).join(",");
}

export interface EditSpan {
	start: number;
	end: number;
	delta: number;
}

export function shiftRanges(seen: readonly LineRange[], spans: readonly EditSpan[]): LineRange[] {
	const kept: LineRange[] = [];
	for (const range of seen) {
		for (let line = range.from; line <= range.to; line++) {
			const index = line - 1;
			if (spans.some((span) => span.start <= index && index < span.end)) continue;
			let delta = 0;
			for (const span of spans) {
				if (span.end <= index) delta += span.delta;
			}
			kept.push({ from: line + delta, to: line + delta });
		}
	}
	return mergeRanges(kept);
}

export class SnapshotStore {
	readonly #maxPaths: number;
	readonly #maxBytes: number;
	readonly #snapshots = new Map<string, Snapshot>();

	constructor(options?: { maxPaths?: number; maxBytes?: number }) {
		this.#maxPaths = options?.maxPaths ?? DEFAULT_MAX_PATHS;
		this.#maxBytes = options?.maxBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
	}

	get size(): number {
		return this.#snapshots.size;
	}

	get(path: string): Snapshot | undefined {
		const snapshot = this.#snapshots.get(path);
		if (!snapshot) return undefined;
		this.#snapshots.delete(path);
		this.#snapshots.set(path, snapshot);
		return snapshot;
	}

	record(path: string, content: string, seen: LineRange[] | "all"): Snapshot | undefined {
		if (Buffer.byteLength(content, "utf-8") > this.#maxBytes) {
			this.#snapshots.delete(path);
			return undefined;
		}
		const lines = splitLines(content);
		const previous = this.#snapshots.get(path);
		const tag = computeTag(content);
		const requested = seen === "all" ? [{ from: 1, to: lines.length }] : seen;
		const carried = previous && previous.tag === tag && previous.content === content ? previous.seen : [];
		const snapshot: Snapshot = {
			path,
			tag,
			content,
			lines,
			seen: mergeRanges([...carried, ...requested]).filter((range) => range.from >= 1 && range.to <= lines.length),
		};
		this.#snapshots.delete(path);
		this.#snapshots.set(path, snapshot);
		while (this.#snapshots.size > this.#maxPaths) {
			const oldest = this.#snapshots.keys().next();
			if (oldest.done) break;
			this.#snapshots.delete(oldest.value);
		}
		return snapshot;
	}

	replace(path: string, content: string, seen: LineRange[]): Snapshot | undefined {
		this.#snapshots.delete(path);
		return this.record(path, content, seen);
	}

	markSeen(path: string, ranges: LineRange[]): void {
		const snapshot = this.#snapshots.get(path);
		if (!snapshot) return;
		snapshot.seen = mergeRanges([...snapshot.seen, ...ranges]).filter(
			(range) => range.from >= 1 && range.to <= snapshot.lines.length,
		);
	}

	forget(path: string): void {
		this.#snapshots.delete(path);
	}
}
