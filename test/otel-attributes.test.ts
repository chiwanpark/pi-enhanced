import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStandardAttributes } from "../extensions/internal/otel/attributes.ts";
import { buildOtelConfig, type OtelEnv } from "../extensions/internal/otel/config.ts";
import {
	detectEntrypoint,
	detectTerminalType,
	readAccountIdentity,
	resolveOrganizationId,
	taggedAccountId,
} from "../extensions/internal/otel/identity.ts";

const ACCOUNT_UUID = "ce981faa-6215-4839-84d4-5435845a6352";
const identity = { userId: "anon-1", email: "dev@example.com", accountUuid: ACCOUNT_UUID, organizationId: undefined };

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

test("the standard attribute set follows the claude code cardinality defaults", () => {
	const standard = attributes();
	assert.equal(standard["session.id"], "session-1");
	assert.equal(standard["user.id"], "anon-1");
	assert.equal(standard["user.email"], "dev@example.com");
	assert.equal(standard["user.account_uuid"], ACCOUNT_UUID);
	assert.equal(standard["terminal.type"], "tmux");
	assert.equal("app.version" in standard, false);
	assert.equal("app.entrypoint" in standard, false);
});

test("user.account_id is the claude code typed id, not the raw uuid", () => {
	assert.equal(attributes()["user.account_id"], "user_01SWeTu6bba167t5S7FHQ1us");
	assert.equal(taggedAccountId("00000000-0000-0000-0000-000000000001"), "user_011111111111111111111112");
	assert.equal(taggedAccountId("ffffffff-ffff-ffff-ffff-ffffffffffff"), "user_01YcVfxkQb6JRzqk5kF2tNLv");
	assert.equal(taggedAccountId("not-a-uuid"), undefined);
	assert.equal(taggedAccountId(undefined), undefined);
});

test("cardinality controls apply to the whole set, as they do in claude code", () => {
	const standard = attributes({
		OTEL_METRICS_INCLUDE_SESSION_ID: "false",
		OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false",
		OTEL_METRICS_INCLUDE_VERSION: "true",
		OTEL_METRICS_INCLUDE_ENTRYPOINT: "true",
	});
	assert.equal("session.id" in standard, false);
	assert.equal("user.account_uuid" in standard, false);
	assert.equal("user.account_id" in standard, false);
	assert.equal(standard["app.version"], "1.2.3");
	assert.equal(standard["app.entrypoint"], "cli");
});

test("resource attributes are stamped on datapoints only while enabled", () => {
	const included = attributes({ OTEL_RESOURCE_ATTRIBUTES: "department=eng" });
	assert.equal(included["department"], "eng");

	const excluded = attributes({
		OTEL_RESOURCE_ATTRIBUTES: "department=eng",
		OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES: "false",
	});
	assert.equal("department" in excluded, false);
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

test("organization id reaches the standard set when set", () => {
	const standard = buildStandardAttributes({
		config: buildOtelConfig({}, []),
		sessionId: "session-1",
		appVersion: "1.2.3",
		entrypoint: "cli",
		identity,
		terminalType: undefined,
		organizationId: "org-7",
	});
	assert.equal(standard["organization.id"], "org-7");
	assert.equal("terminal.type" in standard, false);
});
