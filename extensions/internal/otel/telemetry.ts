import type { Attributes, Counter } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import { hostDetector, osDetector, resourceFromAttributes } from "@opentelemetry/resources";
import {
	BatchLogRecordProcessor,
	ConsoleLogRecordExporter,
	LoggerProvider,
	type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
	AggregationTemporality,
	ConsoleMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
	type IMetricReader,
	type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
	resolveSignalEndpoint,
	resolveSignalHeaders,
	resolveSignalProtocol,
	type OtelExporterConfig,
} from "./config.ts";

export const METER_SCOPE = "com.anthropic.claude_code";
export const EVENT_LOGGER_SCOPE = "com.anthropic.claude_code.events";

export type EventName =
	| "user_prompt"
	| "assistant_response"
	| "tool_result"
	| "tool_decision"
	| "api_request"
	| "api_error"
	| "api_refusal"
	| "permission_mode_changed"
	| "compaction"
	| "internal_error";

export interface TelemetryInit {
	config: OtelExporterConfig;
	serviceVersion: string;
	standardAttributes: Record<string, unknown>;
	onError?: (message: string) => void;
}

type MetricCounters = {
	session: Counter;
	linesOfCode: Counter;
	pullRequest: Counter;
	commit: Counter;
	cost: Counter;
	token: Counter;
	codeEditDecision: Counter;
	activeTime: Counter;
};

function sanitizeAttributes(attributes: Record<string, unknown>): Attributes {
	const result: Attributes = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (value === undefined || value === null) continue;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			result[key] = value;
			continue;
		}
		if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
			result[key] = value as string[];
			continue;
		}
		result[key] = String(value);
	}
	return result;
}

function nonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function signalOptions(config: OtelExporterConfig, signal: "metrics" | "logs") {
	const url = resolveSignalEndpoint(config, signal);
	const headers = resolveSignalHeaders(config, signal);
	return {
		...(url ? { url } : {}),
		...(Object.keys(headers).length > 0 ? { headers } : {}),
	};
}

async function createOtlpMetricExporter(config: OtelExporterConfig): Promise<PushMetricExporter> {
	const options = {
		...signalOptions(config, "metrics"),
		temporalityPreference:
			config.temporalityPreference === "cumulative" ? AggregationTemporality.CUMULATIVE : AggregationTemporality.DELTA,
	};

	switch (resolveSignalProtocol(config, "metrics")) {
		case "grpc":
			return new (await import("@opentelemetry/exporter-metrics-otlp-grpc")).OTLPMetricExporter(options);
		case "http/json":
			return new (await import("@opentelemetry/exporter-metrics-otlp-http")).OTLPMetricExporter(options);
		default:
			return new (await import("@opentelemetry/exporter-metrics-otlp-proto")).OTLPMetricExporter(options);
	}
}

async function createOtlpLogProcessor(config: OtelExporterConfig): Promise<LogRecordProcessor> {
	const options = signalOptions(config, "logs");
	const exporter = await (async () => {
		switch (resolveSignalProtocol(config, "logs")) {
			case "grpc":
				return new (await import("@opentelemetry/exporter-logs-otlp-grpc")).OTLPLogExporter(options);
			case "http/json":
				return new (await import("@opentelemetry/exporter-logs-otlp-http")).OTLPLogExporter(options);
			default:
				return new (await import("@opentelemetry/exporter-logs-otlp-proto")).OTLPLogExporter(options);
		}
	})();

	return new BatchLogRecordProcessor({ exporter, scheduledDelayMillis: config.logsExportIntervalMillis });
}

async function createMetricReaders(config: OtelExporterConfig, onError: (message: string) => void) {
	const readers: IMetricReader[] = [];
	for (const kind of config.metricsExporters) {
		try {
			if (kind === "otlp") {
				readers.push(
					new PeriodicExportingMetricReader({
						exporter: await createOtlpMetricExporter(config),
						exportIntervalMillis: config.metricExportIntervalMillis,
					}),
				);
			} else if (kind === "console") {
				readers.push(
					new PeriodicExportingMetricReader({
						exporter: new ConsoleMetricExporter(),
						exportIntervalMillis: config.metricExportIntervalMillis,
					}),
				);
			} else if (kind === "prometheus") {
				const { PrometheusExporter } = await import("@opentelemetry/exporter-prometheus");
				readers.push(new PrometheusExporter({ host: config.prometheusHost, port: config.prometheusPort }));
			}
		} catch (error) {
			onError(`failed to start ${kind} metrics exporter: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return readers;
}

async function createLogProcessors(config: OtelExporterConfig, onError: (message: string) => void) {
	const processors: LogRecordProcessor[] = [];
	for (const kind of config.logsExporters) {
		try {
			if (kind === "otlp") processors.push(await createOtlpLogProcessor(config));
			else if (kind === "console") {
				processors.push(new BatchLogRecordProcessor({ exporter: new ConsoleLogRecordExporter() }));
			}
		} catch (error) {
			onError(`failed to start ${kind} logs exporter: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return processors;
}

/**
 * Owns the OpenTelemetry providers and exposes Claude Code compatible metrics and events.
 * Provider setup runs in the background so session startup never waits on exporter modules;
 * calls made before setup finishes are queued and replayed in order.
 */
export class OtelTelemetry {
	private readonly config: OtelExporterConfig;
	private readonly serviceVersion: string;
	private readonly onError: (message: string) => void;
	private readonly attributeBase: Attributes;
	private meterProvider: MeterProvider | undefined;
	private loggerProvider: LoggerProvider | undefined;
	private logger: Logger | undefined;
	private counters: MetricCounters | undefined;
	private readonly pending: (() => void)[] = [];
	private readonly readyPromise: Promise<void>;
	private ready = false;
	private sequence = 0;

	constructor(init: TelemetryInit) {
		this.config = init.config;
		this.serviceVersion = init.serviceVersion;
		this.onError = init.onError ?? (() => {});
		this.attributeBase = sanitizeAttributes(init.standardAttributes);
		this.readyPromise = this.start();
	}

	private async start(): Promise<void> {
		try {
			const hostArch = hostDetector.detect().attributes?.["host.arch"];
			const resource = resourceFromAttributes({
				"service.name": this.config.serviceName,
				"service.version": this.serviceVersion,
				...(this.config.includeHostAttributes
					? { ...(osDetector.detect().attributes ?? {}), ...(hostArch ? { "host.arch": hostArch } : {}) }
					: {}),
				...this.config.resourceAttributes,
			});
			const readers = await createMetricReaders(this.config, this.onError);
			const processors = await createLogProcessors(this.config, this.onError);

			if (readers.length > 0) {
				this.meterProvider = new MeterProvider({ resource, readers });
				this.counters = this.createCounters(this.meterProvider);
			}
			if (processors.length > 0) {
				this.loggerProvider = new LoggerProvider({ resource, processors });
				this.logger = this.loggerProvider.getLogger(EVENT_LOGGER_SCOPE, this.serviceVersion);
			}
		} catch (error) {
			this.onError(`telemetry setup failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.ready = true;
			const queued = this.pending.splice(0);
			for (const task of queued) {
				try {
					task();
				} catch {
					// A single dropped datapoint must not break the replay of the rest.
				}
			}
		}
	}

	private createCounters(meterProvider: MeterProvider): MetricCounters {
		const meter = meterProvider.getMeter(METER_SCOPE, this.serviceVersion);
		// Prometheus-only scrapes drop units so the exposition format stays valid.
		const prometheusOnly =
			this.config.metricsExporters.length === 1 && this.config.metricsExporters[0] === "prometheus";
		const unit = (value: string) => (prometheusOnly ? {} : { unit: value });
		return {
			session: meter.createCounter("claude_code.session.count", { description: "Count of CLI sessions started" }),
			linesOfCode: meter.createCounter("claude_code.lines_of_code.count", {
				description:
					"Count of lines of code modified, with the 'type' attribute indicating whether lines were added or removed and the 'model' attribute indicating which model made the change",
			}),
			pullRequest: meter.createCounter("claude_code.pull_request.count", {
				description: "Number of pull requests created",
			}),
			commit: meter.createCounter("claude_code.commit.count", { description: "Number of git commits created" }),
			cost: meter.createCounter("claude_code.cost.usage", {
				description: "Cost of the Claude Code session",
				...unit("USD"),
			}),
			token: meter.createCounter("claude_code.token.usage", {
				description: "Number of tokens used",
				...unit("tokens"),
			}),
			codeEditDecision: meter.createCounter("claude_code.code_edit_tool.decision", {
				description:
					"Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools",
			}),
			activeTime: meter.createCounter("claude_code.active_time.total", {
				description: "Total active time in seconds",
				...unit("s"),
			}),
		};
	}

	/** Run now when the providers exist, otherwise replay in call order once setup finishes. */
	private enqueue(task: () => void): void {
		if (this.ready) {
			task();
			return;
		}
		this.pending.push(task);
	}

	private metricAttributes(extra: Record<string, unknown> = {}): Attributes {
		return { ...this.attributeBase, ...sanitizeAttributes(extra) };
	}

	addSession(startType: string): void {
		const attributes = this.metricAttributes({ start_type: startType });
		this.enqueue(() => this.counters?.session.add(1, attributes));
	}

	addLinesOfCode(type: "added" | "removed", lines: number, model: string | undefined): void {
		const attributes = this.metricAttributes({ type, model });
		this.enqueue(() => this.counters?.linesOfCode.add(nonNegative(lines), attributes));
	}

	addPullRequests(count: number): void {
		if (count <= 0) return;
		const attributes = this.metricAttributes();
		this.enqueue(() => this.counters?.pullRequest.add(count, attributes));
	}

	addCommits(count: number): void {
		if (count <= 0) return;
		const attributes = this.metricAttributes();
		this.enqueue(() => this.counters?.commit.add(count, attributes));
	}

	addCost(costUsd: number, extra: Record<string, unknown>): void {
		const attributes = this.metricAttributes(extra);
		this.enqueue(() => this.counters?.cost.add(nonNegative(costUsd), attributes));
	}

	addTokens(type: string, tokens: number, extra: Record<string, unknown>): void {
		const attributes = this.metricAttributes({ ...extra, type });
		this.enqueue(() => this.counters?.token.add(nonNegative(tokens), attributes));
	}

	addCodeEditDecision(extra: Record<string, unknown>): void {
		const attributes = this.metricAttributes(extra);
		this.enqueue(() => this.counters?.codeEditDecision.add(1, attributes));
	}

	addActiveTime(seconds: number, type: "user" | "cli"): void {
		if (!Number.isFinite(seconds) || seconds <= 0) return;
		const attributes = this.metricAttributes({ type });
		this.enqueue(() => this.counters?.activeTime.add(seconds, attributes));
	}

	emitEvent(name: EventName, extra: Record<string, unknown> = {}, timestampMs?: number): void {
		const timestamp = timestampMs ?? Date.now();
		const attributes: Attributes = {
			...this.attributeBase,
			...sanitizeAttributes({
				"event.name": name,
				"event.timestamp": new Date(timestamp).toISOString(),
				"event.sequence": this.sequence,
				...extra,
			}),
		};
		this.sequence += 1;
		this.enqueue(() =>
			this.logger?.emit({
				body: `claude_code.${name}`,
				timestamp,
				observedTimestamp: timestamp,
				attributes,
			}),
		);
	}

	async forceFlush(): Promise<void> {
		await this.readyPromise;
		await Promise.allSettled([this.meterProvider?.forceFlush(), this.loggerProvider?.forceFlush()]);
	}

	async shutdown(): Promise<void> {
		await this.readyPromise;
		await Promise.allSettled([this.meterProvider?.shutdown(), this.loggerProvider?.shutdown()]);
	}
}
