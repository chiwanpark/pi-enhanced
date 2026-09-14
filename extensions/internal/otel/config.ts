import { readPiEnhancedSettings } from "../common.ts";
import { readClaudeCodeTelemetryEnv } from "./claude-settings.ts";

export const OTLP_PROTOCOLS = ["grpc", "http/protobuf", "http/json"] as const;
export const METRICS_EXPORTERS = ["otlp", "console", "prometheus", "none"] as const;
export const LOGS_EXPORTERS = ["otlp", "console", "none"] as const;
export const TEMPORALITY_PREFERENCES = ["delta", "cumulative", "lowmemory"] as const;

export type OtlpProtocol = (typeof OTLP_PROTOCOLS)[number];
export type MetricsExporterKind = (typeof METRICS_EXPORTERS)[number];
export type LogsExporterKind = (typeof LOGS_EXPORTERS)[number];
export type TemporalityPreference = (typeof TEMPORALITY_PREFERENCES)[number];

export const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60_000;
export const DEFAULT_LOGS_EXPORT_INTERVAL_MS = 5_000;
export const DEFAULT_CONTENT_MAX_LENGTH = 61_440;
export const DEFAULT_PROMETHEUS_PORT = 9464;
export const DEFAULT_PROMETHEUS_HOST = "localhost";
export const DEFAULT_SERVICE_NAME = "pi";
export const CLAUDE_CODE_SERVICE_NAME = "claude-code";

export const METRIC_SIGNALS = [
	"sessionCount",
	"linesOfCode",
	"pullRequest",
	"commit",
	"cost",
	"token",
	"codeEditToolDecision",
	"activeTime",
] as const;

export const EVENT_SIGNALS = [
	"userPrompt",
	"assistantResponse",
	"toolResult",
	"toolDecision",
	"apiRequest",
	"apiError",
	"apiRefusal",
	"permissionModeChanged",
	"compaction",
	"internalError",
] as const;

export type MetricSignal = (typeof METRIC_SIGNALS)[number];
export type EventSignal = (typeof EVENT_SIGNALS)[number];

export type MetricToggles = Record<MetricSignal, boolean>;
export type EventToggles = Record<EventSignal, boolean>;

export interface OtelIncludeConfig {
	sessionId: boolean;
	version: boolean;
	entrypoint: boolean;
	accountUuid: boolean;
	resourceAttributes: boolean;
}

export interface OtelContentConfig {
	logUserPrompts: boolean;
	logAssistantResponses: boolean;
	logToolDetails: boolean;
	maxLength: number;
}

export interface OtelExporterConfig {
	enabled: boolean;
	/** Adopt the telemetry `env` block from the Claude Code settings chain as a fallback. */
	discoverClaudeCodeSettings: boolean;
	/**
	 * Report the user, account, and organization Claude Code reports on this machine.
	 * Defaults to true once the configuration is discovered from Claude Code.
	 */
	useClaudeCodeIdentity: boolean;
	/** Value for the `organization.id` attribute, which pi cannot derive on its own. */
	organizationId: string | undefined;
	/** Attach `os.*` and `host.*` resource attributes for fleet-level grouping. */
	includeHostAttributes: boolean;
	/**
	 * Export only requests to the first-party Anthropic API, excluding gateways and resellers.
	 * Defaults to true once the configuration is discovered from Claude Code.
	 */
	restrictToAnthropicProvider: boolean;
	serviceName: string;
	metricsExporters: MetricsExporterKind[];
	logsExporters: LogsExporterKind[];
	protocol: OtlpProtocol | undefined;
	metricsProtocol: OtlpProtocol | undefined;
	logsProtocol: OtlpProtocol | undefined;
	endpoint: string | undefined;
	metricsEndpoint: string | undefined;
	logsEndpoint: string | undefined;
	headers: Record<string, string>;
	metricsHeaders: Record<string, string>;
	logsHeaders: Record<string, string>;
	metricExportIntervalMillis: number;
	logsExportIntervalMillis: number;
	temporalityPreference: TemporalityPreference;
	prometheusHost: string;
	prometheusPort: number;
	resourceAttributes: Record<string, string>;
	include: OtelIncludeConfig;
	content: OtelContentConfig;
	metrics: MetricToggles;
	events: EventToggles;
}

export type OtelEnv = Record<string, string | undefined>;

export interface OtelConfigDefaults {
	/** Baseline for `restrictToAnthropicProvider` before env and settings are applied. */
	restrictToAnthropicProvider?: boolean;
	serviceName?: string;
	useClaudeCodeIdentity?: boolean;
}

function defaultConfig(defaults: OtelConfigDefaults = {}): OtelExporterConfig {
	return {
		enabled: false,
		discoverClaudeCodeSettings: false,
		useClaudeCodeIdentity: defaults.useClaudeCodeIdentity ?? false,
		organizationId: undefined,
		includeHostAttributes: true,
		restrictToAnthropicProvider: defaults.restrictToAnthropicProvider ?? false,
		serviceName: defaults.serviceName ?? DEFAULT_SERVICE_NAME,
		metricsExporters: [],
		logsExporters: [],
		protocol: undefined,
		metricsProtocol: undefined,
		logsProtocol: undefined,
		endpoint: undefined,
		metricsEndpoint: undefined,
		logsEndpoint: undefined,
		headers: {},
		metricsHeaders: {},
		logsHeaders: {},
		metricExportIntervalMillis: DEFAULT_METRIC_EXPORT_INTERVAL_MS,
		logsExportIntervalMillis: DEFAULT_LOGS_EXPORT_INTERVAL_MS,
		temporalityPreference: "delta",
		prometheusHost: DEFAULT_PROMETHEUS_HOST,
		prometheusPort: DEFAULT_PROMETHEUS_PORT,
		resourceAttributes: {},
		include: {
			sessionId: true,
			version: false,
			entrypoint: false,
			accountUuid: true,
			resourceAttributes: true,
		},
		content: {
			logUserPrompts: false,
			logAssistantResponses: false,
			logToolDetails: false,
			maxLength: DEFAULT_CONTENT_MAX_LENGTH,
		},
		metrics: Object.fromEntries(METRIC_SIGNALS.map((signal) => [signal, true])) as MetricToggles,
		events: Object.fromEntries(EVENT_SIGNALS.map((signal) => [signal, true])) as EventToggles,
	};
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value.trim());
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return Math.floor(parsed);
}

/** Parse `key=value,key2=value2` pairs used by `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_RESOURCE_ATTRIBUTES`. */
export function parseKeyValueList(value: string | undefined): Record<string, string> {
	if (!value) return {};
	const result: Record<string, string> = {};
	for (const pair of value.split(",")) {
		const separator = pair.indexOf("=");
		if (separator <= 0) continue;
		const key = pair.slice(0, separator).trim();
		const entryValue = pair.slice(separator + 1).trim();
		if (!key) continue;
		result[key] = decodeURIComponentSafe(entryValue);
	}
	return result;
}

function decodeURIComponentSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function parseExporterList<T extends string>(value: string | undefined, allowed: readonly T[]): T[] | undefined {
	if (value === undefined) return undefined;
	const entries = value
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
	if (entries.length === 0) return undefined;
	if (entries.includes("none")) return [];
	const selected = entries.filter((entry): entry is T => (allowed as readonly string[]).includes(entry));
	return selected.length > 0 ? [...new Set(selected)] : [];
}

function parseProtocol(value: string | undefined): OtlpProtocol | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	return (OTLP_PROTOCOLS as readonly string[]).includes(normalized) ? (normalized as OtlpProtocol) : undefined;
}

function parseTemporality(value: string | undefined): TemporalityPreference | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	return (TEMPORALITY_PREFERENCES as readonly string[]).includes(normalized)
		? (normalized as TemporalityPreference)
		: undefined;
}

function trimmedString(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Apply the Claude Code compatible `OTEL_*` / `CLAUDE_CODE_*` environment variables. */
export function applyEnv(config: OtelExporterConfig, env: OtelEnv): OtelExporterConfig {
	const next = { ...config };

	const enabled = parseBoolean(env["CLAUDE_CODE_ENABLE_TELEMETRY"] ?? env["PI_ENHANCED_ENABLE_TELEMETRY"]);
	if (enabled !== undefined) next.enabled = enabled;

	next.serviceName = trimmedString(env["OTEL_SERVICE_NAME"]) ?? next.serviceName;
	next.organizationId = trimmedString(env["CLAUDE_CODE_ORGANIZATION_ID"]) ?? next.organizationId;

	next.metricsExporters = parseExporterList(env["OTEL_METRICS_EXPORTER"], METRICS_EXPORTERS) ?? next.metricsExporters;
	next.logsExporters = parseExporterList(env["OTEL_LOGS_EXPORTER"], LOGS_EXPORTERS) ?? next.logsExporters;

	next.protocol = parseProtocol(env["OTEL_EXPORTER_OTLP_PROTOCOL"]) ?? next.protocol;
	next.metricsProtocol = parseProtocol(env["OTEL_EXPORTER_OTLP_METRICS_PROTOCOL"]) ?? next.metricsProtocol;
	next.logsProtocol = parseProtocol(env["OTEL_EXPORTER_OTLP_LOGS_PROTOCOL"]) ?? next.logsProtocol;

	next.endpoint = trimmedString(env["OTEL_EXPORTER_OTLP_ENDPOINT"]) ?? next.endpoint;
	next.metricsEndpoint = trimmedString(env["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"]) ?? next.metricsEndpoint;
	next.logsEndpoint = trimmedString(env["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"]) ?? next.logsEndpoint;

	next.headers = { ...next.headers, ...parseKeyValueList(env["OTEL_EXPORTER_OTLP_HEADERS"]) };
	next.metricsHeaders = { ...next.metricsHeaders, ...parseKeyValueList(env["OTEL_EXPORTER_OTLP_METRICS_HEADERS"]) };
	next.logsHeaders = { ...next.logsHeaders, ...parseKeyValueList(env["OTEL_EXPORTER_OTLP_LOGS_HEADERS"]) };

	next.metricExportIntervalMillis =
		parsePositiveInteger(env["OTEL_METRIC_EXPORT_INTERVAL"]) ?? next.metricExportIntervalMillis;
	next.logsExportIntervalMillis =
		parsePositiveInteger(env["OTEL_LOGS_EXPORT_INTERVAL"]) ?? next.logsExportIntervalMillis;
	next.temporalityPreference =
		parseTemporality(env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"]) ?? next.temporalityPreference;

	next.resourceAttributes = { ...next.resourceAttributes, ...parseKeyValueList(env["OTEL_RESOURCE_ATTRIBUTES"]) };

	next.include = {
		sessionId: parseBoolean(env["OTEL_METRICS_INCLUDE_SESSION_ID"]) ?? next.include.sessionId,
		version: parseBoolean(env["OTEL_METRICS_INCLUDE_VERSION"]) ?? next.include.version,
		entrypoint: parseBoolean(env["OTEL_METRICS_INCLUDE_ENTRYPOINT"]) ?? next.include.entrypoint,
		accountUuid: parseBoolean(env["OTEL_METRICS_INCLUDE_ACCOUNT_UUID"]) ?? next.include.accountUuid,
		resourceAttributes:
			parseBoolean(env["OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES"]) ?? next.include.resourceAttributes,
	};

	const logUserPrompts = parseBoolean(env["OTEL_LOG_USER_PROMPTS"]);
	next.content = {
		logUserPrompts: logUserPrompts ?? next.content.logUserPrompts,
		// Claude Code falls back to OTEL_LOG_USER_PROMPTS when OTEL_LOG_ASSISTANT_RESPONSES is unset.
		logAssistantResponses:
			parseBoolean(env["OTEL_LOG_ASSISTANT_RESPONSES"]) ?? logUserPrompts ?? next.content.logAssistantResponses,
		logToolDetails: parseBoolean(env["OTEL_LOG_TOOL_DETAILS"]) ?? next.content.logToolDetails,
		maxLength: parsePositiveInteger(env["CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH"]) ?? next.content.maxLength,
	};

	const prometheusPort = parsePositiveInteger(env["OTEL_EXPORTER_PROMETHEUS_PORT"]);
	if (prometheusPort !== undefined) next.prometheusPort = prometheusPort;
	next.prometheusHost = trimmedString(env["OTEL_EXPORTER_PROMETHEUS_HOST"]) ?? next.prometheusHost;

	return next;
}

type OtelSettings = {
	enabled?: unknown;
	discoverClaudeCodeSettings?: unknown;
	useClaudeCodeIdentity?: unknown;
	organizationId?: unknown;
	includeHostAttributes?: unknown;
	restrictToAnthropicProvider?: unknown;
	serviceName?: unknown;
	metricsExporter?: unknown;
	logsExporter?: unknown;
	protocol?: unknown;
	metricsProtocol?: unknown;
	logsProtocol?: unknown;
	endpoint?: unknown;
	metricsEndpoint?: unknown;
	logsEndpoint?: unknown;
	headers?: unknown;
	metricsHeaders?: unknown;
	logsHeaders?: unknown;
	metricExportIntervalMillis?: unknown;
	logsExportIntervalMillis?: unknown;
	temporalityPreference?: unknown;
	prometheusHost?: unknown;
	prometheusPort?: unknown;
	resourceAttributes?: unknown;
	includeSessionId?: unknown;
	includeVersion?: unknown;
	includeEntrypoint?: unknown;
	includeAccountUuid?: unknown;
	includeResourceAttributes?: unknown;
	logUserPrompts?: unknown;
	logAssistantResponses?: unknown;
	logToolDetails?: unknown;
	contentMaxLength?: unknown;
	metrics?: unknown;
	events?: unknown;
};

const SETTINGS_ENV_KEYS: Record<string, string> = {
	enabled: "CLAUDE_CODE_ENABLE_TELEMETRY",
	serviceName: "OTEL_SERVICE_NAME",
	organizationId: "CLAUDE_CODE_ORGANIZATION_ID",
	metricsExporter: "OTEL_METRICS_EXPORTER",
	logsExporter: "OTEL_LOGS_EXPORTER",
	protocol: "OTEL_EXPORTER_OTLP_PROTOCOL",
	metricsProtocol: "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
	logsProtocol: "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
	endpoint: "OTEL_EXPORTER_OTLP_ENDPOINT",
	metricsEndpoint: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
	logsEndpoint: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	headers: "OTEL_EXPORTER_OTLP_HEADERS",
	metricsHeaders: "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
	logsHeaders: "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
	metricExportIntervalMillis: "OTEL_METRIC_EXPORT_INTERVAL",
	logsExportIntervalMillis: "OTEL_LOGS_EXPORT_INTERVAL",
	temporalityPreference: "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE",
	prometheusHost: "OTEL_EXPORTER_PROMETHEUS_HOST",
	prometheusPort: "OTEL_EXPORTER_PROMETHEUS_PORT",
	resourceAttributes: "OTEL_RESOURCE_ATTRIBUTES",
	includeSessionId: "OTEL_METRICS_INCLUDE_SESSION_ID",
	includeVersion: "OTEL_METRICS_INCLUDE_VERSION",
	includeEntrypoint: "OTEL_METRICS_INCLUDE_ENTRYPOINT",
	includeAccountUuid: "OTEL_METRICS_INCLUDE_ACCOUNT_UUID",
	includeResourceAttributes: "OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES",
	logUserPrompts: "OTEL_LOG_USER_PROMPTS",
	logAssistantResponses: "OTEL_LOG_ASSISTANT_RESPONSES",
	logToolDetails: "OTEL_LOG_TOOL_DETAILS",
	contentMaxLength: "CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH",
};

function toggleRecord<T extends string>(
	value: unknown,
	current: Record<T, boolean>,
	signals: readonly T[],
): Record<T, boolean> {
	if (typeof value === "boolean") {
		return Object.fromEntries(signals.map((signal) => [signal, value])) as Record<T, boolean>;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return current;
	const next = { ...current };
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry !== "boolean") continue;
		if (!(signals as readonly string[]).includes(key)) continue;
		next[key as T] = entry;
	}
	return next;
}

function settingAsEnvValue(value: unknown): string | undefined {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string").join(",");
	if (!value || typeof value !== "object") return undefined;
	const pairs: string[] = [];
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") continue;
		pairs.push(`${key}=${encodeURIComponent(String(entry))}`);
	}
	return pairs.join(",");
}

/**
 * The settings keys that mean exactly what an environment variable means, rendered in the string
 * form that variable would carry so `applyEnv` parses both through the same path.
 */
export function settingsAsEnv(settings: OtelSettings): OtelEnv {
	const env: OtelEnv = {};
	for (const [key, variable] of Object.entries(SETTINGS_ENV_KEYS)) {
		const value = settingAsEnvValue((settings as Record<string, unknown>)[key]);
		if (value !== undefined) env[variable] = value;
	}
	return env;
}

/**
 * Apply one settings section. Everything with an environment equivalent goes through `applyEnv`, so
 * a key cannot mean one thing in the environment and another in `settings.json`; the pi-specific
 * keys, which have no variable, are read here.
 */
function applySettings(config: OtelExporterConfig, settings: OtelSettings | undefined): OtelExporterConfig {
	if (!settings) return config;
	const next = applyEnv(config, settingsAsEnv(settings));

	if (typeof settings.discoverClaudeCodeSettings === "boolean") {
		next.discoverClaudeCodeSettings = settings.discoverClaudeCodeSettings;
	}
	if (typeof settings.useClaudeCodeIdentity === "boolean") next.useClaudeCodeIdentity = settings.useClaudeCodeIdentity;
	if (typeof settings.restrictToAnthropicProvider === "boolean") {
		next.restrictToAnthropicProvider = settings.restrictToAnthropicProvider;
	}
	if (typeof settings.includeHostAttributes === "boolean") next.includeHostAttributes = settings.includeHostAttributes;

	next.metrics = toggleRecord(settings.metrics, next.metrics, METRIC_SIGNALS);
	next.events = toggleRecord(settings.events, next.events, EVENT_SIGNALS);

	return next;
}

/** Resolve the effective config from raw inputs: defaults, then env, then each settings section in order. */
export function buildOtelConfig(
	env: OtelEnv,
	sections: readonly Record<string, unknown>[],
	defaults: OtelConfigDefaults = {},
): OtelExporterConfig {
	let config = applyEnv(defaultConfig(defaults), env);
	for (const section of sections) {
		config = applySettings(config, (section as { otelExporter?: OtelSettings }).otelExporter);
	}
	return config;
}

/** Merge discovered values under the process env, which keeps explicitly exported variables authoritative. */
export function mergeDiscoveredEnv(env: OtelEnv, discovered: Record<string, string>): OtelEnv {
	const merged: OtelEnv = { ...discovered };
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) merged[key] = value;
	}
	return merged;
}

/**
 * Resolve the effective config: defaults, then `OTEL_*` env, then global settings, then project settings.
 * When `discoverClaudeCodeSettings` is on, the Claude Code telemetry `env` block fills in whatever the
 * environment leaves unset, so pi reports to the collector the enterprise deployment already configured.
 * Borrowed configuration also defaults to exporting only first-party Anthropic API traffic, since the
 * destination and credential belong to the organization's Claude Code deployment;
 * `restrictToAnthropicProvider` overrides that. It reports under the `claude-code` service name and
 * under the Claude Code account identity too, so the dashboards that deployment already runs pick the
 * data up; `serviceName` and `useClaudeCodeIdentity` override those.
 */
export function resolveOtelConfig(cwd: string, env: OtelEnv = process.env): OtelExporterConfig {
	const sections = readPiEnhancedSettings(cwd);
	const config = buildOtelConfig(env, sections);
	if (!config.discoverClaudeCodeSettings) return config;

	const discovered = readClaudeCodeTelemetryEnv({ cwd });
	if (Object.keys(discovered).length === 0) return config;
	return buildOtelConfig(mergeDiscoveredEnv(env, discovered), sections, {
		restrictToAnthropicProvider: true,
		serviceName: CLAUDE_CODE_SERVICE_NAME,
		useClaudeCodeIdentity: true,
	});
}

/** True when telemetry is enabled and at least one signal has a live exporter. */
export function hasActiveExporter(config: OtelExporterConfig): boolean {
	if (!config.enabled) return false;
	return config.metricsExporters.length > 0 || config.logsExporters.length > 0;
}

export function resolveSignalProtocol(config: OtelExporterConfig, signal: "metrics" | "logs"): OtlpProtocol {
	const specific = signal === "metrics" ? config.metricsProtocol : config.logsProtocol;
	return specific ?? config.protocol ?? "http/protobuf";
}

export function resolveSignalHeaders(config: OtelExporterConfig, signal: "metrics" | "logs"): Record<string, string> {
	const specific = signal === "metrics" ? config.metricsHeaders : config.logsHeaders;
	return { ...config.headers, ...specific };
}

export function resolveSignalEndpoint(config: OtelExporterConfig, signal: "metrics" | "logs"): string | undefined {
	const specific = signal === "metrics" ? config.metricsEndpoint : config.logsEndpoint;
	if (specific) return specific;
	if (!config.endpoint) return undefined;
	const protocol = resolveSignalProtocol(config, signal);
	if (protocol === "grpc") return config.endpoint;
	const base = config.endpoint.replace(/\/+$/, "");
	// A base endpoint that already names the signal path must not gain a second one.
	return base.endsWith(`/v1/${signal}`) ? base : `${base}/v1/${signal}`;
}

export const testables = { defaultConfig, applySettings };
