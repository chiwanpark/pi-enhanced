import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { EDITOR_INPUT_EVENT } from "../extensions/internal/editor-activity.ts";
import { buildOtelConfig } from "../extensions/internal/otel/config.ts";
import { createOtelExporter } from "../extensions/otel-exporter.ts";

function metricsOnlyConfig(port: number) {
	return buildOtelConfig(
		{
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_METRICS_EXPORTER: "otlp",
			OTEL_LOGS_EXPORTER: "none",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
		},
		[],
	);
}

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

type Capture = { path: string; body: unknown };

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const busHandlers = new Map<string, ((data: unknown) => void)[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> | void }) {
			commands.set(name, command);
		},
		getThinkingLevel: () => "off",
		events: {
			emit(channel: string, data: unknown) {
				for (const handler of busHandlers.get(channel) ?? []) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				const list = busHandlers.get(channel) ?? [];
				list.push(handler);
				busHandlers.set(channel, list);
				return () => {};
			},
		},
	};

	async function fire(event: string, payload: Record<string, unknown>, ctx: unknown) {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
	}

	return { pi, fire, handlers, commands };
}

function fakeCtx(
	entries: { type: string; customType?: string; data?: unknown }[] = [],
	model: { id: string; provider: string } | undefined = { id: "claude-sonnet-5", provider: "anthropic" },
	notices: { message: string; level: string }[] = [],
) {
	return {
		mode: "tui",
		hasUI: false,
		cwd: "/tmp/project",
		model,
		ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
		sessionManager: {
			getSessionId: () => "session-test",
			getBranch: () => entries,
			getEntries: () => entries,
		},
	};
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello there" }],
		api: "anthropic-messages" as AssistantMessage["api"],
		provider: "anthropic" as AssistantMessage["provider"],
		model: "claude-sonnet-5",
		responseId: "req_123",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 20,
			cacheWrite: 2,
			totalTokens: 37,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

async function startCollector(): Promise<{ server: Server; port: number; captures: Capture[] }> {
	const captures: Capture[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			captures.push({ path: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	return { server, port: (server.address() as { port: number }).port, captures };
}

function metricNames(captures: Capture[]): string[] {
	const names: string[] = [];
	for (const capture of captures) {
		if (!capture.path.includes("metrics")) continue;
		const body = capture.body as {
			resourceMetrics: { scopeMetrics: { metrics: { name: string }[] }[] }[];
		};
		for (const resource of body.resourceMetrics) {
			for (const scope of resource.scopeMetrics) {
				for (const metric of scope.metrics) names.push(metric.name);
			}
		}
	}
	return names;
}

function metricScopes(captures: Capture[]): string[] {
	const scopes = new Set<string>();
	for (const capture of captures) {
		if (!capture.path.includes("metrics")) continue;
		const body = capture.body as { resourceMetrics: { scopeMetrics: { scope?: { name?: string } }[] }[] };
		for (const resource of body.resourceMetrics) {
			for (const scope of resource.scopeMetrics) if (scope.scope?.name) scopes.add(scope.scope.name);
		}
	}
	return [...scopes];
}

type MetricPoint = { value: number; attributes: Record<string, unknown> };

function metricPoints(captures: Capture[], name: string): MetricPoint[] {
	const points: MetricPoint[] = [];
	for (const capture of captures) {
		if (!capture.path.includes("metrics")) continue;
		const body = capture.body as {
			resourceMetrics: {
				scopeMetrics: {
					metrics: {
						name: string;
						sum?: {
							dataPoints: {
								asInt?: string;
								asDouble?: number;
								attributes: { key: string; value: Record<string, unknown> }[];
							}[];
						};
					}[];
				}[];
			}[];
		};
		for (const resource of body.resourceMetrics) {
			for (const scope of resource.scopeMetrics) {
				for (const metric of scope.metrics) {
					if (metric.name !== name) continue;
					for (const point of metric.sum?.dataPoints ?? []) {
						const attributes: Record<string, unknown> = {};
						for (const attribute of point.attributes) {
							attributes[attribute.key] = Object.values(attribute.value)[0];
						}
						points.push({ value: Number(point.asInt ?? point.asDouble ?? 0), attributes });
					}
				}
			}
		}
	}
	return points;
}

type LogRecord = {
	body?: { stringValue?: string };
	severityNumber?: number;
	timeUnixNano?: string;
	observedTimeUnixNano?: string;
	attributes: { key: string; value: Record<string, unknown> }[];
};

function logRecords(captures: Capture[]) {
	const records: LogRecord[] = [];
	const scopes: string[] = [];
	for (const capture of captures) {
		if (!capture.path.includes("logs")) continue;
		const body = capture.body as {
			resourceLogs: { scopeLogs: { scope?: { name?: string }; logRecords: LogRecord[] }[] }[];
		};
		for (const resource of body.resourceLogs) {
			for (const scope of resource.scopeLogs) {
				if (scope.scope?.name) scopes.push(scope.scope.name);
				records.push(...scope.logRecords);
			}
		}
	}
	return { records, scopes };
}

function eventName(record: LogRecord | undefined): string | undefined {
	return record?.body?.stringValue;
}

function attributeValue(
	record: { attributes: { key: string; value: Record<string, unknown> }[] } | undefined,
	key: string,
): unknown {
	const attribute = record?.attributes.find((entry) => entry.key === key);
	if (!attribute) return undefined;
	return Object.values(attribute.value)[0];
}

test("a full turn exports claude code metrics and events over otlp", async () => {
	const { server, port, captures } = await startCollector();
	const config = buildOtelConfig(
		{
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_METRICS_EXPORTER: "otlp",
			OTEL_LOGS_EXPORTER: "otlp",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
		},
		[],
	);

	const { pi, fire } = fakePi();
	createOtelExporter(config)(pi as never);
	const ctx = fakeCtx();

	await fire("session_start", { reason: "startup" }, ctx);
	await fire("input", { text: "add a test", source: "interactive" }, ctx);
	await fire("before_agent_start", { prompt: "add a test" }, ctx);
	await fire("agent_start", {}, ctx);
	await fire("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
	await fire("before_provider_request", { payload: {} }, ctx);
	await fire("after_provider_response", { status: 200, headers: { "request-id": "req_abc" } }, ctx);
	await fire("message_end", { message: assistantMessage({ providerThinkingLevel: "high" }) }, ctx);

	await fire(
		"tool_execution_start",
		{ toolCallId: "call-1", toolName: "bash", args: { command: "git commit -m x" } },
		ctx,
	);
	await fire("tool_result", { toolCallId: "call-1", toolName: "bash", input: { command: "git commit -m x" } }, ctx);
	await fire(
		"tool_execution_end",
		{
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "committed" }] },
			isError: false,
		},
		ctx,
	);

	await fire("agent_settled", {}, ctx);
	await fire("session_shutdown", { reason: "quit" }, ctx);
	await new Promise<void>((resolve) => server.close(() => resolve()));

	const names = new Set(metricNames(captures));
	assert.deepEqual([...names].sort(), [
		"claude_code.active_time.total",
		"claude_code.commit.count",
		"claude_code.cost.usage",
		"claude_code.session.count",
		"claude_code.token.usage",
	]);
	assert.deepEqual(metricScopes(captures), ["com.anthropic.claude_code"]);

	const sessions = metricPoints(captures, "claude_code.session.count");
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0]?.value, 1);
	assert.equal(sessions[0]?.attributes["start_type"], "fresh");
	assert.equal("model" in (sessions[0]?.attributes ?? {}), false);
	assert.deepEqual(
		metricPoints(captures, "claude_code.commit.count").map((point) => point.value),
		[1],
	);

	const tokens = metricPoints(captures, "claude_code.token.usage");
	assert.deepEqual(
		tokens.map((point) => [point.attributes["type"], point.value]).sort(),
		[
			["cacheCreation", 2],
			["cacheRead", 20],
			["input", 10],
			["output", 5],
		].sort(),
	);
	for (const point of tokens) {
		assert.equal(point.attributes["model"], "claude-sonnet-5");
		assert.equal(point.attributes["query_source"], "main");
		assert.equal(point.attributes["effort"], "high");
		assert.equal(point.attributes["provider"], undefined);
	}

	const costs = metricPoints(captures, "claude_code.cost.usage");
	assert.equal(costs.length, 1);
	assert.equal(costs[0]?.value, 0.033);
	assert.equal(costs[0]?.attributes["effort"], "high");
	assert.equal(costs[0]?.attributes["provider"], undefined);

	const { records: events, scopes } = logRecords(captures);
	assert.deepEqual(scopes, ["com.anthropic.claude_code.events"]);
	assert.deepEqual(events.map(eventName), [
		"claude_code.user_prompt",
		"claude_code.api_request",
		"claude_code.assistant_response",
		"claude_code.tool_result",
	]);

	const prompt = events[0];
	assert.equal(attributeValue(prompt, "prompt"), "<REDACTED>");
	assert.equal(attributeValue(prompt, "prompt_length"), 10);
	assert.equal(attributeValue(prompt, "session.id"), "session-test");
	assert.equal(attributeValue(prompt, "event.sequence"), 0);
	assert.equal(attributeValue(prompt, "app.version"), undefined);
	assert.equal(prompt?.severityNumber, undefined);
	assert.equal(prompt?.observedTimeUnixNano, prompt?.timeUnixNano);

	const apiRequest = events[1];
	assert.equal(attributeValue(apiRequest, "model"), "claude-sonnet-5");
	assert.equal(attributeValue(apiRequest, "provider"), "anthropic");
	assert.equal(attributeValue(apiRequest, "input_tokens"), 10);
	assert.equal(attributeValue(apiRequest, "cache_creation_tokens"), 2);
	assert.equal(attributeValue(apiRequest, "request_id"), "req_123");
	assert.equal(attributeValue(apiRequest, "cost_usd_micros"), 33000);

	const toolResult = events[3];
	assert.equal(attributeValue(toolResult, "tool_name"), "bash");
	assert.equal(attributeValue(toolResult, "tool_use_id"), "call-1");
	assert.equal(attributeValue(toolResult, "success"), "true");
	assert.equal(attributeValue(toolResult, "decision_type"), "accept");

	// Every event from one prompt shares the correlation id.
	const promptIds = new Set(events.map((record) => attributeValue(record, "prompt.id")));
	assert.equal(promptIds.size, 1);
	assert.equal(typeof [...promptIds][0], "string");
});

test("a blocked tool call reports a rejected decision instead of a result", async () => {
	const { server, port, captures } = await startCollector();
	const config = buildOtelConfig(
		{
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_LOGS_EXPORTER: "otlp",
			OTEL_METRICS_EXPORTER: "none",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
		},
		[],
	);

	const { pi, fire } = fakePi();
	createOtelExporter(config)(pi as never);
	const ctx = fakeCtx();

	await fire("session_start", { reason: "startup" }, ctx);
	await fire("before_agent_start", { prompt: "delete everything" }, ctx);
	await fire("tool_execution_start", { toolCallId: "call-2", toolName: "edit", args: { path: "a.ts" } }, ctx);
	// No tool_result event: the guard blocked the call before execution.
	await fire(
		"tool_execution_end",
		{
			toolCallId: "call-2",
			toolName: "edit",
			result: { content: [{ type: "text", text: "Command blocked" }] },
			isError: true,
		},
		ctx,
	);
	await fire("session_shutdown", { reason: "quit" }, ctx);
	await new Promise<void>((resolve) => server.close(() => resolve()));

	const { records: events } = logRecords(captures);
	const decision = events.find((record) => eventName(record) === "claude_code.tool_decision");
	assert.ok(decision, "expected a tool_decision event");
	assert.equal(attributeValue(decision, "decision"), "reject");
	assert.equal(attributeValue(decision, "tool_name"), "edit");
	assert.equal(
		events.some((record) => eventName(record) === "claude_code.tool_result"),
		false,
	);
});

test("api errors are reported from failed http responses", async () => {
	const { server, port, captures } = await startCollector();
	const config = buildOtelConfig(
		{
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_LOGS_EXPORTER: "otlp",
			OTEL_METRICS_EXPORTER: "none",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
		},
		[],
	);

	const { pi, fire } = fakePi();
	createOtelExporter(config)(pi as never);
	const ctx = fakeCtx();

	await fire("session_start", { reason: "startup" }, ctx);
	await fire("before_provider_request", { payload: {} }, ctx);
	await fire("after_provider_response", { status: 429, headers: { "request-id": "req_429" } }, ctx);
	await fire("session_shutdown", { reason: "quit" }, ctx);
	await new Promise<void>((resolve) => server.close(() => resolve()));

	const error = logRecords(captures).records.find((record) => eventName(record) === "claude_code.api_error");
	assert.ok(error, "expected an api_error event");
	assert.equal(attributeValue(error, "status_code"), 429);
	assert.equal(attributeValue(error, "request_id"), "req_429");
});

test("disabled signals stop their exports", async () => {
	const { server, port, captures } = await startCollector();
	const config = buildOtelConfig(
		{
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_LOGS_EXPORTER: "otlp",
			OTEL_METRICS_EXPORTER: "none",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
		},
		[{ otelExporter: { events: { userPrompt: false } } }],
	);

	const { pi, fire } = fakePi();
	createOtelExporter(config)(pi as never);
	const ctx = fakeCtx();

	await fire("session_start", { reason: "startup" }, ctx);
	await fire("before_agent_start", { prompt: "hi" }, ctx);
	await fire("message_end", { message: assistantMessage() }, ctx);
	await fire("session_shutdown", { reason: "quit" }, ctx);
	await new Promise<void>((resolve) => server.close(() => resolve()));

	const eventNames = logRecords(captures).records.map(eventName);
	assert.equal(eventNames.includes("claude_code.user_prompt"), false);
	assert.ok(eventNames.includes("claude_code.api_request"));
});

test("the otel command reports the destination and the export state", async () => {
	const { server, port, captures } = await startCollector();
	const config = metricsOnlyConfig(port);

	const { pi, fire, commands } = fakePi();
	createOtelExporter(config)(pi as never);
	const notices: { message: string; level: string }[] = [];
	const ctx = fakeCtx([], { id: "claude-sonnet-5", provider: "anthropic" }, notices);

	const command = commands.get("otel");
	assert.ok(command, "expected an /otel command");
	await command.handler("", ctx);
	assert.match(notices[0]?.message ?? "", /enabled: yes/);
	assert.match(notices[0]?.message ?? "", new RegExp(`metrics endpoint: http://127.0.0.1:${port}/v1/metrics`));
	assert.match(notices[0]?.message ?? "", /exporting this session: not yet/);
	assert.equal(notices[0]?.level, "info");

	// After a session has exported something the command says so.
	await fire("session_start", { reason: "startup" }, ctx);
	await command.handler("", ctx);
	assert.match(notices[1]?.message ?? "", /exporting this session: yes/);

	await fire("session_shutdown", { reason: "quit" }, ctx);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	assert.ok(captures.length >= 0);
});

test("the otel command explains a disabled exporter", async () => {
	const config = buildOtelConfig({}, []);
	const { pi, commands } = fakePi();
	createOtelExporter(config)(pi as never);
	const notices: { message: string; level: string }[] = [];

	await commands.get("otel")?.handler("", fakeCtx([], undefined, notices));
	assert.match(notices[0]?.message ?? "", /enabled: no/);
	assert.match(notices[0]?.message ?? "", /inactive: set piEnhanced.otelExporter.enabled/);
	assert.equal(notices[0]?.level, "warning");
});

test("lines of code are measured from the real file change", async () => {
	const dir = await mkdtemp(join(tmpdir(), "otel-lines-"));
	const file = join(dir, "app.ts");
	await writeFile(file, "one\ntwo\nthree\n", "utf8");
	const { server, port, captures } = await startCollector();
	const config = metricsOnlyConfig(port);

	const { pi, fire } = fakePi();
	createOtelExporter(config)(pi as never);
	const ctx = { ...fakeCtx(), cwd: dir };

	try {
		await fire("session_start", { reason: "startup" }, ctx);
		// A whole-file write reports no patch, so the counts have to come from the before and after files.
		const args = { path: "app.ts", content: "one\nTWO\nthree\nfour\n" };
		await fire("tool_execution_start", { toolCallId: "call-1", toolName: "write", args }, ctx);
		await fire("tool_result", { toolCallId: "call-1", toolName: "write", input: args }, ctx);
		await writeFile(file, args.content, "utf8");
		await fire(
			"tool_execution_end",
			{ toolCallId: "call-1", toolName: "write", result: { content: [] }, isError: false },
			ctx,
		);
		await fire("session_shutdown", { reason: "quit" }, ctx);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}

	const points = metricPoints(captures, "claude_code.lines_of_code.count");
	assert.equal(points.find((point) => point.attributes["type"] === "added")?.value, 2);
	assert.equal(points.find((point) => point.attributes["type"] === "removed")?.value, 1);
	for (const point of points) {
		assert.equal(point.attributes["model"], "claude-sonnet-5");
		assert.equal("query_source" in point.attributes, false);
	}

	const decisions = metricPoints(captures, "claude_code.code_edit_tool.decision");
	assert.equal(decisions.length, 1);
	assert.equal(decisions[0]?.attributes["tool_name"], "Write");
	assert.equal(decisions[0]?.attributes["decision"], "accept");
	assert.equal(decisions[0]?.attributes["source"], "config");
	assert.equal(decisions[0]?.attributes["language"], "TypeScript");
});

test("a new file reports its line count as added and zero removed, like claude code", async () => {
	const dir = await mkdtemp(join(tmpdir(), "otel-lines-"));
	const { server, port, captures } = await startCollector();
	const config = metricsOnlyConfig(port);

	const { pi, fire } = fakePi();
	createOtelExporter(config)(pi as never);
	const ctx = { ...fakeCtx(), cwd: dir };

	try {
		await fire("session_start", { reason: "startup" }, ctx);
		const args = { path: "notes", content: "one\ntwo\nthree" };
		await fire("tool_execution_start", { toolCallId: "call-1", toolName: "write", args }, ctx);
		await fire("tool_result", { toolCallId: "call-1", toolName: "write", input: args }, ctx);
		await writeFile(join(dir, "notes"), args.content, "utf8");
		await fire(
			"tool_execution_end",
			{ toolCallId: "call-1", toolName: "write", result: { content: [] }, isError: false },
			ctx,
		);
		await fire("session_shutdown", { reason: "quit" }, ctx);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}

	const points = metricPoints(captures, "claude_code.lines_of_code.count");
	assert.deepEqual(points.map((point) => [point.attributes["type"], point.value]).sort(), [
		["added", 3],
		["removed", 0],
	]);
	const decision = metricPoints(captures, "claude_code.code_edit_tool.decision")[0];
	assert.equal("language" in (decision?.attributes ?? {}), false);
});

test("a successful git commit command counts one commit, as in claude code", async () => {
	const { server, port, captures } = await startCollector();
	const config = metricsOnlyConfig(port);

	const { pi, fire } = fakePi();
	createOtelExporter(config)(pi as never);
	const ctx = fakeCtx();

	async function shell(id: string, command: string, isError: boolean) {
		const args = { command };
		await fire("tool_execution_start", { toolCallId: id, toolName: "bash", args }, ctx);
		await fire("tool_result", { toolCallId: id, toolName: "bash", input: args }, ctx);
		await fire("tool_execution_end", { toolCallId: id, toolName: "bash", result: { content: [] }, isError }, ctx);
	}

	await fire("session_start", { reason: "startup" }, ctx);
	await shell("call-1", 'git add -A && git commit -m "work"', false);
	await shell("call-2", "git commit --amend --no-edit", false);
	await shell("call-3", 'git commit -m "fails the hook"', true);
	await shell("call-4", "git log --oneline -3", false);
	await fire("session_shutdown", { reason: "quit" }, ctx);
	await new Promise<void>((resolve) => server.close(() => resolve()));

	const points = metricPoints(captures, "claude_code.commit.count");
	assert.equal(
		points.reduce((sum, point) => sum + point.value, 0),
		2,
	);
	assert.equal("model" in (points[0]?.attributes ?? {}), false);
});

test("pull requests count one per successful create command", async () => {
	const { server, port, captures } = await startCollector();
	const config = metricsOnlyConfig(port);

	const { pi, fire } = fakePi();
	createOtelExporter(config)(pi as never);
	const ctx = fakeCtx();
	const args = { command: "gh pr create --fill" };
	const result = { content: [{ type: "text", text: "https://github.com/acme/app/pull/7\n" }] };

	await fire("session_start", { reason: "startup" }, ctx);
	await fire("tool_execution_start", { toolCallId: "call-1", toolName: "bash", args }, ctx);
	await fire("tool_result", { toolCallId: "call-1", toolName: "bash", input: args }, ctx);
	await fire("tool_execution_end", { toolCallId: "call-1", toolName: "bash", result, isError: false }, ctx);
	await fire("tool_execution_start", { toolCallId: "call-2", toolName: "bash", args }, ctx);
	await fire("tool_result", { toolCallId: "call-2", toolName: "bash", input: args }, ctx);
	await fire("tool_execution_end", { toolCallId: "call-2", toolName: "bash", result, isError: true }, ctx);
	await fire("session_shutdown", { reason: "quit" }, ctx);
	await new Promise<void>((resolve) => server.close(() => resolve()));

	assert.deepEqual(
		metricPoints(captures, "claude_code.pull_request.count").map((point) => point.value),
		[1],
	);
});

test("plan mode changes emit a permission mode event", async () => {
	const { server, port, captures } = await startCollector();
	const config = buildOtelConfig(
		{
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_LOGS_EXPORTER: "otlp",
			OTEL_METRICS_EXPORTER: "none",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
		},
		[],
	);

	const { pi, fire } = fakePi();
	createOtelExporter(config)(pi as never);
	const ctx = fakeCtx();

	await fire("session_start", { reason: "startup" }, ctx);
	pi.events.emit("pi-enhanced:plan-mode-state", { active: true });
	await fire("session_shutdown", { reason: "quit" }, ctx);
	await new Promise<void>((resolve) => server.close(() => resolve()));

	const change = logRecords(captures).records.find(
		(record) => eventName(record) === "claude_code.permission_mode_changed",
	);
	assert.ok(change, "expected a permission_mode_changed event");
	assert.equal(attributeValue(change, "from_mode"), "default");
	assert.equal(attributeValue(change, "to_mode"), "plan");
});

function anthropicOnlyConfig(port: number) {
	return buildOtelConfig(
		{
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_METRICS_EXPORTER: "otlp",
			OTEL_LOGS_EXPORTER: "otlp",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
		},
		[],
		{ restrictToAnthropicProvider: true },
	);
}

test("borrowed configuration exports nothing for a non anthropic session", async () => {
	const { server, port, captures } = await startCollector();
	const { pi, fire } = fakePi();
	createOtelExporter(anthropicOnlyConfig(port))(pi as never);
	const ctx = fakeCtx([], { id: "gpt-5.6-luna", provider: "openai-codex" });

	await fire("session_start", { reason: "startup" }, ctx);
	await fire("before_agent_start", { prompt: "add a test" }, ctx);
	await fire("message_end", { message: assistantMessage({ provider: "openai-codex", model: "gpt-5.6-luna" }) }, ctx);
	await fire(
		"tool_execution_start",
		{ toolCallId: "call-1", toolName: "bash", args: { command: "git commit -m x" } },
		ctx,
	);
	await fire("tool_result", { toolCallId: "call-1", toolName: "bash", input: {} }, ctx);
	await fire(
		"tool_execution_end",
		{ toolCallId: "call-1", toolName: "bash", result: { content: [] }, isError: false },
		ctx,
	);
	await fire("session_shutdown", { reason: "quit" }, ctx);
	await new Promise<void>((resolve) => server.close(() => resolve()));

	assert.deepEqual(captures, []);
});

test("borrowed configuration still exports an anthropic session", async () => {
	const { server, port, captures } = await startCollector();
	const { pi, fire } = fakePi();
	createOtelExporter(anthropicOnlyConfig(port))(pi as never);
	const ctx = fakeCtx();

	await fire("session_start", { reason: "startup" }, ctx);
	await fire("before_agent_start", { prompt: "add a test" }, ctx);
	await fire("message_end", { message: assistantMessage() }, ctx);
	await fire("session_shutdown", { reason: "quit" }, ctx);
	await new Promise<void>((resolve) => server.close(() => resolve()));

	assert.ok(metricNames(captures).includes("claude_code.token.usage"));
	assert.ok(logRecords(captures).records.some((record) => eventName(record) === "claude_code.api_request"));
});

test("claude through openrouter is skipped, even though the model is claude", async () => {
	const { server, port, captures } = await startCollector();
	const { pi, fire } = fakePi();
	createOtelExporter(anthropicOnlyConfig(port))(pi as never);
	const ctx = fakeCtx([], { id: "anthropic/claude-fable-5", provider: "openrouter" });

	await fire("session_start", { reason: "startup" }, ctx);
	await fire("before_agent_start", { prompt: "hi" }, ctx);
	await fire(
		"message_end",
		{ message: assistantMessage({ provider: "openrouter", model: "anthropic/claude-fable-5" }) },
		ctx,
	);
	await fire("session_shutdown", { reason: "quit" }, ctx);
	await new Promise<void>((resolve) => server.close(() => resolve()));

	assert.deepEqual(captures, []);
});

test("claude through bedrock and copilot is skipped as well", async () => {
	const { server, port, captures } = await startCollector();
	const { pi, fire } = fakePi();
	createOtelExporter(anthropicOnlyConfig(port))(pi as never);

	for (const model of [
		{ id: "anthropic.claude-opus-4-1-20250805-v1:0", provider: "amazon-bedrock" },
		{ id: "claude-haiku-4.5", provider: "github-copilot" },
	]) {
		const ctx = fakeCtx([], model);
		await fire("session_start", { reason: "startup" }, ctx);
		await fire("message_end", { message: assistantMessage({ provider: model.provider, model: model.id }) }, ctx);
	}
	await fire(
		"session_shutdown",
		{ reason: "quit" },
		fakeCtx([], { id: "claude-haiku-4.5", provider: "github-copilot" }),
	);
	await new Promise<void>((resolve) => server.close(() => resolve()));

	assert.deepEqual(captures, []);
});

test("only the anthropic responses of a mixed session are exported", async () => {
	const { server, port, captures } = await startCollector();
	const { pi, fire } = fakePi();
	createOtelExporter(anthropicOnlyConfig(port))(pi as never);

	const claudeCtx = fakeCtx();
	await fire("session_start", { reason: "startup" }, claudeCtx);
	await fire("message_end", { message: assistantMessage({ responseId: "req_claude" }) }, claudeCtx);

	// The user switches to a non-Claude model mid-session.
	const otherModel = { id: "gpt-5.6-luna", provider: "openai-codex" };
	await fire("model_select", { model: otherModel, source: "set" }, fakeCtx([], otherModel));
	await fire(
		"message_end",
		{ message: assistantMessage({ provider: "openai-codex", model: "gpt-5.6-luna", responseId: "req_other" }) },
		fakeCtx([], otherModel),
	);
	await fire("session_shutdown", { reason: "quit" }, fakeCtx([], otherModel));
	await new Promise<void>((resolve) => server.close(() => resolve()));

	const requestIds = logRecords(captures)
		.records.filter((record) => eventName(record) === "claude_code.api_request")
		.map((record) => attributeValue(record, "request_id"));
	assert.deepEqual(requestIds, ["req_claude"]);
});

test("the gate is open for every provider unless restriction is on", async () => {
	const { server, port, captures } = await startCollector();
	const config = buildOtelConfig(
		{
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_LOGS_EXPORTER: "otlp",
			OTEL_METRICS_EXPORTER: "none",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
		},
		[],
	);

	const { pi, fire } = fakePi();
	createOtelExporter(config)(pi as never);
	const ctx = fakeCtx([], { id: "gpt-5.6-luna", provider: "openai-codex" });

	await fire("session_start", { reason: "startup" }, ctx);
	await fire("message_end", { message: assistantMessage({ provider: "openai-codex", model: "gpt-5.6-luna" }) }, ctx);
	await fire("session_shutdown", { reason: "quit" }, ctx);
	await new Promise<void>((resolve) => server.close(() => resolve()));

	assert.ok(logRecords(captures).records.some((record) => eventName(record) === "claude_code.api_request"));
});

test("active time credits keystroke gaps under five seconds and the agent run span", async () => {
	const { server, port, captures } = await startCollector();
	const config = metricsOnlyConfig(port);

	const { pi, fire } = fakePi();
	createOtelExporter(config)(pi as never);
	const ctx = fakeCtx();
	const base = Date.now();

	await fire("session_start", { reason: "startup" }, ctx);
	pi.events.emit(EDITOR_INPUT_EVENT, { at: base });
	pi.events.emit(EDITOR_INPUT_EVENT, { at: base + 1_000 });
	pi.events.emit(EDITOR_INPUT_EVENT, { at: base + 2_500 });
	pi.events.emit(EDITOR_INPUT_EVENT, { at: base + 60_000 });
	pi.events.emit(EDITOR_INPUT_EVENT, { at: base + 60_500 });
	await fire("agent_start", {}, ctx);
	pi.events.emit(EDITOR_INPUT_EVENT, { at: base + 61_000 });
	await new Promise((resolve) => setTimeout(resolve, 30));
	await fire("agent_settled", {}, ctx);
	await fire("session_shutdown", { reason: "quit" }, ctx);
	await new Promise<void>((resolve) => server.close(() => resolve()));

	const points = metricPoints(captures, "claude_code.active_time.total");
	const user = points.filter((point) => point.attributes["type"] === "user");
	const cli = points.filter((point) => point.attributes["type"] === "cli");
	assert.equal(Math.round(user.reduce((sum, point) => sum + point.value, 0) * 1000), 3_000);
	assert.equal(cli.length, 1);
	assert.ok((cli[0]?.value ?? 0) >= 0.03);
});
