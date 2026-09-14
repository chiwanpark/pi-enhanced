export const USER_ACTIVITY_TIMEOUT_MS = 5_000;

export interface ActiveTimeOptions {
	userActivityTimeoutMs?: number;
}

/**
 * Accumulates user and CLI active time the way Claude Code does. `noteUserActivity` credits the gap
 * since the previous keystroke or submit while it is short and the CLI is idle; CLI spans run from
 * the first operation start to the last operation end.
 */
export class ActiveTimeTracker {
	private readonly userActivityTimeoutMs: number;
	private lastUserActivityMs: number | undefined;
	private cliStartMs: number | undefined;
	private cliDepth = 0;

	constructor(options: ActiveTimeOptions = {}) {
		this.userActivityTimeoutMs = options.userActivityTimeoutMs ?? USER_ACTIVITY_TIMEOUT_MS;
	}

	/** Returns the user-active seconds to record for this interaction. */
	noteUserActivity(nowMs: number): number {
		const previous = this.lastUserActivityMs;
		this.lastUserActivityMs = nowMs;
		if (previous === undefined || this.cliDepth > 0) return 0;
		const elapsed = nowMs - previous;
		if (elapsed <= 0 || elapsed >= this.userActivityTimeoutMs) return 0;
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
