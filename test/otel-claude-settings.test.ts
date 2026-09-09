import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { claudeCodeSettingsFiles, readClaudeCodeTelemetryEnv } from "../extensions/internal/otel/claude-settings.ts";
import { buildOtelConfig, mergeDiscoveredEnv } from "../extensions/internal/otel/config.ts";

function scratch() {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-otel-claude-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	mkdirSync(path.join(home, ".claude"), { recursive: true });
	mkdirSync(path.join(cwd, ".claude"), { recursive: true });
	return { root, home, cwd };
}

function writeSettings(filePath: string, settings: unknown) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(settings), "utf8");
}

test("the settings chain is ordered from lowest to highest precedence", () => {
	const files = claudeCodeSettingsFiles({ cwd: "/proj", home: "/home/dev", platform: "linux" });
	assert.deepEqual(files, [
		"/home/dev/.claude/settings.json",
		"/proj/.claude/settings.json",
		"/proj/.claude/settings.local.json",
		"/etc/claude-code/managed-settings.json",
		"/home/dev/.claude/remote-settings.json",
	]);
});

test("system settings directories follow the platform", () => {
	const macos = claudeCodeSettingsFiles({ cwd: "/proj", home: "/Users/dev", platform: "darwin" });
	assert.ok(macos.includes("/Library/Application Support/ClaudeCode/managed-settings.json"));

	const windows = claudeCodeSettingsFiles({ cwd: "C:\\proj", home: "C:\\Users\\dev", platform: "win32" });
	assert.ok(windows.some((file) => file.includes(path.join("Program Files", "ClaudeCode", "managed-settings.json"))));
});

test("no claude code settings yields nothing to discover", () => {
	const { home, cwd } = scratch();
	assert.deepEqual(readClaudeCodeTelemetryEnv({ cwd, home, platform: "linux" }), {});
});

test("server managed settings supply the endpoint and headers", () => {
	const { home, cwd } = scratch();
	writeSettings(path.join(home, ".claude", "remote-settings.json"), {
		companyAnnouncements: ["hello"],
		env: {
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_METRICS_EXPORTER: "otlp",
			OTEL_LOGS_EXPORTER: "otlp",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.corp.example.com",
			OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer secret-token",
			OTEL_LOG_TOOL_DETAILS: "1",
		},
	});

	const discovered = readClaudeCodeTelemetryEnv({ cwd, home, platform: "linux" });
	assert.equal(discovered["OTEL_EXPORTER_OTLP_ENDPOINT"], "https://collector.corp.example.com");
	assert.equal(discovered["OTEL_EXPORTER_OTLP_HEADERS"], "Authorization=Bearer secret-token");
	assert.equal(discovered["CLAUDE_CODE_ENABLE_TELEMETRY"], "1");
	assert.equal(discovered["OTEL_LOG_TOOL_DETAILS"], "1");
});

test("only telemetry keys are adopted from the env block", () => {
	const { home, cwd } = scratch();
	writeSettings(path.join(home, ".claude", "settings.json"), {
		env: {
			OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.corp.example.com",
			CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: "262144",
			ANTHROPIC_API_KEY: "sk-should-never-be-read",
			HTTPS_PROXY: "http://proxy:3128",
			CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192",
		},
	});

	const discovered = readClaudeCodeTelemetryEnv({ cwd, home, platform: "linux" });
	assert.deepEqual(Object.keys(discovered).sort(), [
		"CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH",
		"OTEL_EXPORTER_OTLP_ENDPOINT",
	]);
});

test("higher precedence files override lower ones per key", () => {
	const { home, cwd } = scratch();
	writeSettings(path.join(home, ".claude", "settings.json"), {
		env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://user:4318", OTEL_METRICS_EXPORTER: "console" },
	});
	writeSettings(path.join(cwd, ".claude", "settings.json"), {
		env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://project:4318" },
	});
	writeSettings(path.join(home, ".claude", "remote-settings.json"), {
		env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://managed:4318" },
	});

	const discovered = readClaudeCodeTelemetryEnv({ cwd, home, platform: "linux" });
	assert.equal(discovered["OTEL_EXPORTER_OTLP_ENDPOINT"], "http://managed:4318");
	// Keys the higher source leaves unset still come from the lower one.
	assert.equal(discovered["OTEL_METRICS_EXPORTER"], "console");
});

test("malformed and non object settings files are skipped", () => {
	const { home, cwd } = scratch();
	writeFileSync(path.join(home, ".claude", "settings.json"), "{ not json", "utf8");
	writeSettings(path.join(cwd, ".claude", "settings.json"), ["array"]);
	writeSettings(path.join(cwd, ".claude", "settings.local.json"), { env: "not-an-object" });
	writeSettings(path.join(home, ".claude", "remote-settings.json"), {
		env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://survivor:4318" },
	});

	const discovered = readClaudeCodeTelemetryEnv({ cwd, home, platform: "linux" });
	assert.deepEqual(discovered, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://survivor:4318" });
});

test("process environment wins over discovered values", () => {
	const merged = mergeDiscoveredEnv(
		{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://shell:4318", OTEL_LOGS_EXPORTER: undefined },
		{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://discovered:4318", OTEL_LOGS_EXPORTER: "otlp" },
	);
	assert.equal(merged["OTEL_EXPORTER_OTLP_ENDPOINT"], "http://shell:4318");
	// An undefined shell value must not blank out a discovered one.
	assert.equal(merged["OTEL_LOGS_EXPORTER"], "otlp");
});

test("discovered values activate the exporter and settings still override them", () => {
	const discovered = {
		CLAUDE_CODE_ENABLE_TELEMETRY: "1",
		OTEL_METRICS_EXPORTER: "otlp",
		OTEL_LOGS_EXPORTER: "otlp",
		OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
		OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.corp.example.com",
	};

	const adopted = buildOtelConfig(mergeDiscoveredEnv({}, discovered), []);
	assert.equal(adopted.enabled, true);
	assert.equal(adopted.endpoint, "https://collector.corp.example.com");
	assert.equal(adopted.protocol, "http/json");

	const overridden = buildOtelConfig(mergeDiscoveredEnv({}, discovered), [
		{ otelExporter: { logsExporter: "none", serviceName: "pi-lab" } },
	]);
	assert.deepEqual(overridden.logsExporters, []);
	assert.equal(overridden.serviceName, "pi-lab");
	assert.deepEqual(overridden.metricsExporters, ["otlp"]);
});

test("discovery is off unless the setting turns it on", () => {
	assert.equal(buildOtelConfig({}, []).discoverClaudeCodeSettings, false);
	assert.equal(
		buildOtelConfig({}, [{ otelExporter: { discoverClaudeCodeSettings: true } }]).discoverClaudeCodeSettings,
		true,
	);
});

test("borrowed configuration defaults to anthropic only export", () => {
	const discovered = { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOGS_EXPORTER: "otlp" };

	const borrowed = buildOtelConfig(mergeDiscoveredEnv({}, discovered), [], { restrictToAnthropicProvider: true });
	assert.equal(borrowed.restrictToAnthropicProvider, true);

	// Configuration the user wrote themselves keeps exporting every provider.
	const own = buildOtelConfig(mergeDiscoveredEnv({}, discovered), []);
	assert.equal(own.restrictToAnthropicProvider, false);
});

test("restrictToAnthropicProvider can be overridden either way", () => {
	const opened = buildOtelConfig({}, [{ otelExporter: { restrictToAnthropicProvider: false } }], {
		restrictToAnthropicProvider: true,
	});
	assert.equal(opened.restrictToAnthropicProvider, false);

	const closed = buildOtelConfig({}, [{ otelExporter: { restrictToAnthropicProvider: true } }]);
	assert.equal(closed.restrictToAnthropicProvider, true);
});
