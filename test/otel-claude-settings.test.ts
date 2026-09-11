import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	claudeCodeSettingsFiles,
	readClaudeCodeIdentity,
	readClaudeCodeTelemetryEnv,
} from "../extensions/internal/otel/claude-settings.ts";
import { buildOtelConfig, mergeDiscoveredEnv } from "../extensions/internal/otel/config.ts";
import { loadIdentity, resolveOrganizationId } from "../extensions/internal/otel/identity.ts";

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

test("borrowed configuration reports under the claude code service name", () => {
	const discovered = { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "otlp" };

	const borrowed = buildOtelConfig(mergeDiscoveredEnv({}, discovered), [], { serviceName: "claude-code" });
	assert.equal(borrowed.serviceName, "claude-code");

	const own = buildOtelConfig(mergeDiscoveredEnv({}, discovered), []);
	assert.equal(own.serviceName, "pi");

	const named = buildOtelConfig(mergeDiscoveredEnv({ OTEL_SERVICE_NAME: "pi-lab" }, discovered), [], {
		serviceName: "claude-code",
	});
	assert.equal(named.serviceName, "pi-lab");
});

test("borrowed configuration adopts the claude code identity", () => {
	const discovered = { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "otlp" };

	const borrowed = buildOtelConfig(mergeDiscoveredEnv({}, discovered), [], { useClaudeCodeIdentity: true });
	assert.equal(borrowed.useClaudeCodeIdentity, true);

	const own = buildOtelConfig(mergeDiscoveredEnv({}, discovered), []);
	assert.equal(own.useClaudeCodeIdentity, false);

	const declined = buildOtelConfig(
		mergeDiscoveredEnv({}, discovered),
		[{ otelExporter: { useClaudeCodeIdentity: false } }],
		{ useClaudeCodeIdentity: true },
	);
	assert.equal(declined.useClaudeCodeIdentity, false);
});

test("the claude code identity comes from the account it is logged in as", () => {
	const { home } = scratch();
	writeSettings(path.join(home, ".claude.json"), {
		userID: "39f98816c16768b6",
		machineID: "machine-1",
		oauthAccount: {
			accountUuid: "ce981faa-6215-4839-84d4-5435845a6352",
			emailAddress: "dev@corp.example.com",
			organizationUuid: "12adddf0-463e-4253-a843-8d54149b34b1",
		},
	});

	assert.deepEqual(readClaudeCodeIdentity(home), {
		userId: "39f98816c16768b6",
		email: "dev@corp.example.com",
		accountUuid: "ce981faa-6215-4839-84d4-5435845a6352",
		organizationId: "12adddf0-463e-4253-a843-8d54149b34b1",
	});
});

test("the consent record supplies the account when no oauth block exists", () => {
	const { home } = scratch();
	writeSettings(path.join(home, ".claude.json"), { userID: "anon-42" });
	writeSettings(path.join(home, ".claude", "remote-settings-consent.json"), {
		version: 1,
		records: {
			"12adddf0-463e-4253-a843-8d54149b34b1": {
				accountUuid: "ce981faa-6215-4839-84d4-5435845a6352",
				updatedAt: 1788883302688,
			},
		},
	});

	assert.deepEqual(readClaudeCodeIdentity(home), {
		userId: "anon-42",
		email: undefined,
		accountUuid: "ce981faa-6215-4839-84d4-5435845a6352",
		organizationId: "12adddf0-463e-4253-a843-8d54149b34b1",
	});
});

test("an install without claude code reports nothing to adopt", () => {
	const { home } = scratch();
	assert.deepEqual(readClaudeCodeIdentity(home), {
		userId: undefined,
		email: undefined,
		accountUuid: undefined,
		organizationId: undefined,
	});
});

test("the adopted identity wins over pi's own anonymous id", () => {
	const { home, root } = scratch();
	writeSettings(path.join(home, ".claude.json"), {
		userID: "claude-user",
		oauthAccount: {
			accountUuid: "acct-claude",
			emailAddress: "dev@corp.example.com",
			organizationUuid: "org-claude",
		},
	});
	const identityFile = path.join(root, "pi-enhanced-otel.json");

	const adopted = loadIdentity(undefined, { claudeCode: true, home, identityFile });
	assert.deepEqual(adopted, {
		userId: "claude-user",
		email: "dev@corp.example.com",
		accountUuid: "acct-claude",
		organizationId: "org-claude",
	});
	assert.equal(resolveOrganizationId(undefined, {}, adopted.organizationId), "org-claude");
	assert.equal(resolveOrganizationId("org-settings", {}, adopted.organizationId), "org-settings");

	const own = loadIdentity(undefined, { home, identityFile });
	assert.notEqual(own.userId, "claude-user");
	assert.equal(own.organizationId, undefined);
});
