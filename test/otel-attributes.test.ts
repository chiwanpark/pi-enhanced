import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStandardAttributes } from "../extensions/internal/otel/attributes.ts";
import { buildOtelConfig, type OtelEnv } from "../extensions/internal/otel/config.ts";
import {
	detectEntrypoint,
	detectTerminalType,
	readAccountIdentity,
	resolveOrganizationId,
} from "../extensions/internal/otel/identity.ts";

const identity = { userId: "anon-1", email: "dev@example.com", accountUuid: "acct-9", organizationId: undefined };

function attributes(env: OtelEnv = {}) {
	return buildStandardAttributes({
		config: buildOtelConfig(env, []),
		sessionId: "session-1",
		appVersion: "1.2.3",
		entrypoint: "cli",
		identity,
		terminalType: "tmux",
	});
}

test("events always carry the full standard attribute set", () => {
	const { events } = attributes();
	assert.equal(events["session.id"], "session-1");
	assert.equal(events["app.version"], "1.2.3");
	assert.equal(events["app.entrypoint"], "cli");
	assert.equal(events["user.id"], "anon-1");
	assert.equal(events["user.email"], "dev@example.com");
	assert.equal(events["user.account_uuid"], "acct-9");
	assert.equal(events["user.account_id"], "acct-9");
	assert.equal(events["terminal.type"], "tmux");
});

test("metric attributes honour the cardinality defaults", () => {
	const { metrics } = attributes();
	assert.equal(metrics["session.id"], "session-1");
	assert.equal(metrics["user.account_uuid"], "acct-9");
	assert.equal("app.version" in metrics, false);
	assert.equal("app.entrypoint" in metrics, false);
});

test("cardinality controls can drop session id and account attributes from metrics", () => {
	const { metrics, events } = attributes({
		OTEL_METRICS_INCLUDE_SESSION_ID: "false",
		OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false",
		OTEL_METRICS_INCLUDE_VERSION: "true",
		OTEL_METRICS_INCLUDE_ENTRYPOINT: "true",
	});
	assert.equal("session.id" in metrics, false);
	assert.equal("user.account_uuid" in metrics, false);
	assert.equal(metrics["app.version"], "1.2.3");
	assert.equal(metrics["app.entrypoint"], "cli");
	// Events are unaffected by the metric cardinality controls.
	assert.equal(events["session.id"], "session-1");
	assert.equal(events["user.account_uuid"], "acct-9");
});

test("resource attributes reach metrics only while enabled", () => {
	const included = attributes({ OTEL_RESOURCE_ATTRIBUTES: "department=eng" });
	assert.equal(included.metrics["department"], "eng");
	assert.equal(included.events["department"], "eng");

	const excluded = attributes({
		OTEL_RESOURCE_ATTRIBUTES: "department=eng",
		OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES: "false",
	});
	assert.equal("department" in excluded.metrics, false);
	assert.equal(excluded.events["department"], "eng");
});

test("anthropic and gemini accounts resolve offline from auth data", () => {
	const anthropic = readAccountIdentity("anthropic", { anthropic: { email: "a@example.com" } } as never);
	assert.equal(anthropic.email, "a@example.com");

	const missing = readAccountIdentity("anthropic", null);
	assert.deepEqual(missing, { email: undefined, accountUuid: undefined });

	const unknownProvider = readAccountIdentity(undefined, { anthropic: { email: "a@example.com" } } as never);
	assert.equal(unknownProvider.email, undefined);
});

test("terminal type prefers tmux then the terminal program", () => {
	assert.equal(detectTerminalType({ TMUX: "/tmp/tmux-1", TERM_PROGRAM: "iTerm.app" }), "tmux");
	assert.equal(detectTerminalType({ TERM_PROGRAM: "vscode" }), "vscode");
	assert.equal(detectTerminalType({ TERMINAL_EMULATOR: "JetBrains-JediTerm" }), "JetBrains-JediTerm");
	assert.equal(detectTerminalType({ TERM: "xterm-256color" }), "xterm-256color");
	assert.equal(detectTerminalType({}), undefined);
});

test("entrypoint uses the claude code vocabulary", () => {
	assert.equal(detectEntrypoint("tui", {}), "cli");
	assert.equal(detectEntrypoint("print", {}), "cli");
	assert.equal(detectEntrypoint("rpc", {}), "sdk-cli");
	assert.equal(detectEntrypoint(undefined, {}), "cli");
	assert.equal(detectEntrypoint(undefined, { PI_ENHANCED_ENTRYPOINT: "ci" }), "ci");
});

test("organization id comes from configuration only", () => {
	assert.equal(resolveOrganizationId("org-from-settings", {}), "org-from-settings");
	assert.equal(resolveOrganizationId(undefined, { CLAUDE_CODE_ORGANIZATION_ID: "org-from-env" }), "org-from-env");
	assert.equal(resolveOrganizationId(undefined, {}), undefined);
	// An email domain is not an organization id, so nothing is guessed from the identity.
	assert.equal(resolveOrganizationId("  ", {}), undefined);
});

test("organization id reaches metrics and events when set", () => {
	const { metrics, events } = buildStandardAttributes({
		config: buildOtelConfig({}, []),
		sessionId: "session-1",
		appVersion: "1.2.3",
		entrypoint: "cli",
		identity,
		terminalType: undefined,
		organizationId: "org-7",
	});
	assert.equal(metrics["organization.id"], "org-7");
	assert.equal(events["organization.id"], "org-7");
});
