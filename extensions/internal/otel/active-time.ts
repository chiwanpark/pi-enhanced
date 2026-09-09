export const DEFAULT_IDLE_THRESHOLD_MS = 60_000;

export interface ActiveTimeOptions {
	/** Gaps longer than this are treated as idle and dropped, like Claude Code's active-time metric. */
	idleThresholdMs?: number;
}

/**
 * Accumulates user and CLI active time. `noteUserActivity` credits the gap since the previous
 * interaction when it is short enough to count as continuous work; CLI spans are measured directly.
 */
export class ActiveTimeTracker {
	private readonly idleThresholdMs: number;
	private lastUserActivityMs: number | undefined;
	private cliStartMs: number | undefined;
	private cliDepth = 0;

	constructor(options: ActiveTimeOptions = {}) {
		this.idleThresholdMs = options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
	}

	/** Returns the user-active seconds to record for this interaction. */
	noteUserActivity(nowMs: number): number {
		const previous = this.lastUserActivityMs;
		this.lastUserActivityMs = nowMs;
		if (previous === undefined) return 0;
		const elapsed = nowMs - previous;
		if (elapsed <= 0 || elapsed > this.idleThresholdMs) return 0;
		return elapsed / 1000;
	}

	startCli(nowMs: number): void {
		this.cliDepth += 1;
		if (this.cliStartMs === undefined) this.cliStartMs = nowMs;
	}

	/** Returns the CLI-active seconds for the completed span, or 0 while spans remain open. */
	endCli(nowMs: number): number {
		if (this.cliDepth === 0) return 0;
		this.cliDepth -= 1;
		if (this.cliDepth > 0) return 0;
		const start = this.cliStartMs;
		this.cliStartMs = undefined;
		this.lastUserActivityMs = nowMs;
		if (start === undefined) return 0;
		const elapsed = nowMs - start;
		return elapsed > 0 ? elapsed / 1000 : 0;
	}

	/** Close any open CLI span, e.g. on shutdown. */
	flushCli(nowMs: number): number {
		if (this.cliDepth === 0) return 0;
		this.cliDepth = 1;
		return this.endCli(nowMs);
	}
}
