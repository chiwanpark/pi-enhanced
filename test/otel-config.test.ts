import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildOtelConfig,
	hasActiveExporter,
	parseKeyValueList,
	resolveSignalEndpoint,
	resolveSignalHeaders,
	resolveSignalProtocol,
	type OtelEnv,
} from "../extensions/internal/otel/config.ts";

function build(env: OtelEnv = {}, sections: Record<string, unknown>[] = []) {
	return buildOtelConfig(env, sections);
}

test("telemetry stays disabled without the enable flag", () => {
	const config = build({ OTEL_METRICS_EXPORTER: "otlp" });
	assert.equal(config.enabled, false);
	assert.equal(hasActiveExporter(config), false);
});

test("claude code environment variables enable both signals", () => {
	const config = build({
		CLAUDE_CODE_ENABLE_TELEMETRY: "1",
		OTEL_METRICS_EXPORTER: "otlp",
		OTEL_LOGS_EXPORTER: "otlp",
		OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
		OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4317",
		OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer token,x-tenant=core",
	});

	assert.equal(hasActiveExporter(config), true);
	assert.deepEqual(config.metricsExporters, ["otlp"]);
	assert.deepEqual(config.logsExporters, ["otlp"]);
	assert.equal(config.protocol, "grpc");
	assert.deepEqual(config.headers, { Authorization: "Bearer token", "x-tenant": "core" });
});

test("exporter lists accept multiple values and none disables the signal", () => {
	const both = build({ CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "otlp,prometheus" });
	assert.deepEqual(both.metricsExporters, ["otlp", "prometheus"]);

	const disabled = build({ CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "none" });
	assert.deepEqual(disabled.metricsExporters, []);
});

test("assistant response logging falls back to the user prompt flag", () => {
	const inherited = build({ OTEL_LOG_USER_PROMPTS: "1" });
	assert.equal(inherited.content.logAssistantResponses, true);

	const overridden = build({ OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_ASSISTANT_RESPONSES: "0" });
	assert.equal(overridden.content.logAssistantResponses, false);
});

test("cardinality controls follow claude code defaults", () => {
	const config = build();
	assert.deepEqual(config.include, {
		sessionId: true,
		version: false,
		entrypoint: false,
		accountUuid: true,
		resourceAttributes: true,
	});

	const tuned = build({ OTEL_METRICS_INCLUDE_VERSION: "true", OTEL_METRICS_INCLUDE_SESSION_ID: "false" });
	assert.equal(tuned.include.version, true);
	assert.equal(tuned.include.sessionId, false);
});

test("settings override environment values", () => {
	const config = build({ CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318" }, [
		{ otelExporter: { endpoint: "http://global:4318", metricsExporter: "console" } },
	]);
	assert.equal(config.endpoint, "http://global:4318");
	assert.deepEqual(config.metricsExporters, ["console"]);
});

test("project settings win over global settings", () => {
	const config = build({}, [
		{ otelExporter: { enabled: true, serviceName: "global" } },
		{ otelExporter: { serviceName: "project" } },
	]);
	assert.equal(config.enabled, true);
	assert.equal(config.serviceName, "project");
});

test("signal toggles default to on and can be disabled individually", () => {
	const config = build({}, [{ otelExporter: { metrics: { activeTime: false }, events: { toolResult: false } } }]);
	assert.equal(config.metrics.activeTime, false);
	assert.equal(config.metrics.token, true);
	assert.equal(config.events.toolResult, false);
	assert.equal(config.events.apiRequest, true);
});

test("a boolean signal group toggles every signal in it", () => {
	const config = build({}, [{ otelExporter: { events: false } }]);
	assert.equal(Object.values(config.events).some(Boolean), false);
	assert.equal(config.metrics.token, true);
});

test("unknown signal names are ignored", () => {
	const config = build({}, [{ otelExporter: { metrics: { nope: false } } }]);
	assert.equal(Object.values(config.metrics).every(Boolean), true);
});

test("http endpoints get the per-signal path while grpc keeps the base url", () => {
	const http = build({ CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" });
	assert.equal(resolveSignalProtocol(http, "metrics"), "http/protobuf");
	assert.equal(resolveSignalEndpoint(http, "metrics"), "http://collector:4318/v1/metrics");
	assert.equal(resolveSignalEndpoint(http, "logs"), "http://collector:4318/v1/logs");

	const grpc = build({ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4317" });
	assert.equal(resolveSignalEndpoint(grpc, "metrics"), "http://collector:4317");
});

test("a base endpoint that already names the signal keeps a single path", () => {
	const config = build({
		CLAUDE_CODE_ENABLE_TELEMETRY: "1",
		OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/v1/metrics",
	});
	assert.equal(resolveSignalEndpoint(config, "metrics"), "http://collector:4318/v1/metrics");
});

test("host attributes, priming, and organization id are configurable", () => {
	const defaults = build({});
	assert.equal(defaults.includeHostAttributes, true);
	assert.equal(defaults.primeMetricSeries, true);
	assert.equal(defaults.organizationId, undefined);

	const fromSettings = build({}, [
		{ otelExporter: { includeHostAttributes: false, primeMetricSeries: false, organizationId: "org-7" } },
	]);
	assert.equal(fromSettings.includeHostAttributes, false);
	assert.equal(fromSettings.primeMetricSeries, false);
	assert.equal(fromSettings.organizationId, "org-7");

	// Settings win over the environment, which is the order used for every other key.
	const fromEnv = build({ CLAUDE_CODE_ORGANIZATION_ID: "org-env" });
	assert.equal(fromEnv.organizationId, "org-env");
});

test("per-signal endpoints and protocols override the generic ones", () => {
	const config = build({
		OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
		OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4317",
		OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
		OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://logs:4318/v1/logs",
	});
	assert.equal(resolveSignalProtocol(config, "logs"), "http/json");
	assert.equal(resolveSignalEndpoint(config, "logs"), "http://logs:4318/v1/logs");
	assert.equal(resolveSignalProtocol(config, "metrics"), "grpc");
});

test("per-signal headers merge with the generic headers", () => {
	const config = build({
		OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer base",
		OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-logs=1",
	});
	assert.deepEqual(resolveSignalHeaders(config, "logs"), { Authorization: "Bearer base", "x-logs": "1" });
	assert.deepEqual(resolveSignalHeaders(config, "metrics"), { Authorization: "Bearer base" });
});

test("export intervals and content limits use claude code defaults", () => {
	const config = build();
	assert.equal(config.metricExportIntervalMillis, 60_000);
	assert.equal(config.logsExportIntervalMillis, 5_000);
	assert.equal(config.content.maxLength, 61_440);
	assert.equal(config.temporalityPreference, "cumulative");

	const tuned = build({
		OTEL_METRIC_EXPORT_INTERVAL: "5000",
		OTEL_LOGS_EXPORT_INTERVAL: "1000",
		CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: "262144",
		OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta",
	});
	assert.equal(tuned.metricExportIntervalMillis, 5_000);
	assert.equal(tuned.logsExportIntervalMillis, 1_000);
	assert.equal(tuned.content.maxLength, 262_144);
	assert.equal(tuned.temporalityPreference, "delta");
});

test("resource attributes come from the standard variable and settings", () => {
	const config = build({ OTEL_RESOURCE_ATTRIBUTES: "department=eng,team.id=core" }, [
		{ otelExporter: { resourceAttributes: { cost_center: "1234" } } },
	]);
	assert.deepEqual(config.resourceAttributes, {
		department: "eng",
		"team.id": "core",
		cost_center: "1234",
	});
});

test("key value lists tolerate blanks and url encoding", () => {
	assert.deepEqual(parseKeyValueList("a=1,,b=hello%20world,=skip,c"), { a: "1", b: "hello world" });
	assert.deepEqual(parseKeyValueList(undefined), {});
});
