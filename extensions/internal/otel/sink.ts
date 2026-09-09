import type { EventName, OtelTelemetry, TelemetryInit } from "./telemetry.ts";

/** The telemetry surface used by the extension, so the OpenTelemetry SDK can stay behind a lazy import. */
export interface TelemetrySink {
	addSession(startType: string, model: string | undefined): void;
	primeSeries(model: string | undefined, tokenTypes: readonly string[]): void;
	addLinesOfCode(type: "added" | "removed", lines: number, model: string | undefined): void;
	addPullRequests(count: number): void;
	addCommits(count: number): void;
	addCost(costUsd: number, extra: Record<string, unknown>): void;
	addTokens(type: string, tokens: number, extra: Record<string, unknown>): void;
	addCodeEditDecision(extra: Record<string, unknown>): void;
	addActiveTime(seconds: number, type: "user" | "cli"): void;
	emitEvent(name: EventName, extra?: Record<string, unknown>): void;
	forceFlush(): Promise<void>;
	shutdown(): Promise<void>;
}

/**
 * Create a sink that records calls immediately and forwards them once the SDK module is loaded.
 * The dynamic import keeps the OpenTelemetry packages out of the startup path of every pi run.
 */
export function createTelemetrySink(init: TelemetryInit): TelemetrySink {
	let telemetry: OtelTelemetry | undefined;
	const queue: ((target: OtelTelemetry) => void)[] = [];

	const ready = (async () => {
		try {
			const { OtelTelemetry: Telemetry } = await import("./telemetry.ts");
			const created = new Telemetry(init);
			telemetry = created;
			for (const task of queue.splice(0)) task(created);
		} catch (error) {
			queue.length = 0;
			init.onError?.(`telemetry sdk unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	})();

	function run(task: (target: OtelTelemetry) => void): void {
		if (telemetry) {
			task(telemetry);
			return;
		}
		queue.push(task);
	}

	return {
		addSession: (startType, model) => run((target) => target.addSession(startType, model)),
		primeSeries: (model, tokenTypes) => run((target) => target.primeSeries(model, tokenTypes)),
		addLinesOfCode: (type, lines, model) => run((target) => target.addLinesOfCode(type, lines, model)),
		addPullRequests: (count) => run((target) => target.addPullRequests(count)),
		addCommits: (count) => run((target) => target.addCommits(count)),
		addCost: (costUsd, extra) => run((target) => target.addCost(costUsd, extra)),
		addTokens: (type, tokens, extra) => run((target) => target.addTokens(type, tokens, extra)),
		addCodeEditDecision: (extra) => run((target) => target.addCodeEditDecision(extra)),
		addActiveTime: (seconds, type) => run((target) => target.addActiveTime(seconds, type)),
		emitEvent: (name, extra) => {
			// Stamp the time at call time so queued events keep their real ordering and timestamps.
			const timestampMs = Date.now();
			run((target) => target.emitEvent(name, extra, timestampMs));
		},
		forceFlush: async () => {
			await ready;
			await telemetry?.forceFlush();
		},
		shutdown: async () => {
			await ready;
			await telemetry?.shutdown();
		},
	};
}
