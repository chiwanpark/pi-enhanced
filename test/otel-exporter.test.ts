import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { buildOtelConfig } from "../extensions/internal/otel/config.ts";
import { createOtelExporter } from "../extensions/otel-exporter.ts";

const run = promisify(execFile);

/** Metrics-only export with priming off, so every datapoint in a test comes from a real action. */
function metricsOnlyConfig(port: number) {
	return buildOtelConfig(
		{
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_METRICS_EXPORTER: "otlp",
			OTEL_LOGS_EXPORTER: "none",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
		},
		[{ otelExporter: { primeMetricSeries: false } }],
	);
}

async function git(cwd: string, args: string[]): Promise<void> {
	await run("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd });
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

function logRecords(captures: Capture[]) {
	const records: { eventName?: string; attributes: { key: string; value: Record<string, unknown> }[] }[] = [];
	for (const capture of captures) {
		if (!capture.path.includes("logs")) continue;
		const body = capture.body as {
			resourceLogs: {
				scopeLogs: {
					logRecords: { eventName?: string; attributes: { key: string; value: Record<string, unknown> }[] }[];
				}[];
			}[];
		};
		for (const resource of body.resourceLogs) {
			for (const scope of resource.scopeLogs) records.push(...scope.logRecords);
		}
	}
	return records;
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
	await fire("message_end", { message: assistantMessage() }, ctx);

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
	// Priming publishes every series at session start, so all eight exist before anything happens.
	assert.deepEqual([...names].sort(), [
		"claude_code.active_time.total",
		"claude_code.code_edit_tool.decision",
		"claude_code.commit.count",
		"claude_code.cost.usage",
		"claude_code.lines_of_code.count",
		"claude_code.pull_request.count",
		"claude_code.session.count",
		"claude_code.token.usage",
	]);

	const sessions = metricPoints(captures, "claude_code.session.count");
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0]?.value, 1);
	assert.equal(sessions[0]?.attributes["start_type"], "fresh");
	assert.equal(sessions[0]?.attributes["model"], "claude-sonnet-5");
	// The command was never run, so HEAD did not move and no commit is counted.
	assert.deepEqual(
		metricPoints(captures, "claude_code.commit.count").map((point) => point.value),
		[0],
	);

	const events = logRecords(captures);
	const eventNames = events.map((record) => record.eventName);
	assert.deepEqual(eventNames, [
		"claude_code.user_prompt",
		"claude_code.api_request",
		"claude_code.assistant_response",
		"claude_code.tool_result",
	]);

	const prompt = events[0];
	assert.equal(attributeValue(prompt, "prompt"), "<REDACTED>");
	assert.equal(attributeValue(prompt, "prompt_length"), 10);
	assert.equal(attributeValue(prompt, "session.id"), "session-test");
	assert.equal(attributeValue(prompt, "event.sequence"), 1);

	const apiRequest = events[1];
	assert.equal(attributeValue(apiRequest, "model"), "claude-sonnet-5");
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

	const events = logRecords(captures);
	const decision = events.find((record) => record.eventName === "claude_code.tool_decision");
	assert.ok(decision, "expected a tool_decision event");
	assert.equal(attributeValue(decision, "decision"), "reject");
	assert.equal(attributeValue(decision, "tool_name"), "edit");
	assert.equal(
		events.some((record) => record.eventName === "claude_code.tool_result"),
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

	const error = logRecords(captures).find((record) => record.eventName === "claude_code.api_error");
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

	const eventNames = logRecords(captures).map((record) => record.eventName);
	assert.equal(eventNames.includes("claude_code.user_prompt"), false);
	assert.ok(eventNames.includes("claude_code.api_request"));
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
});

test("a commit counts only when head actually moves", async () => {
	const dir = await mkdtemp(join(tmpdir(), "otel-commit-"));
	const { server, port, captures } = await startCollector();
	const config = metricsOnlyConfig(port);

	const { pi, fire } = fakePi();
	createOtelExporter(config)(pi as never);
	const ctx = { ...fakeCtx(), cwd: dir };

	try {
		await git(dir, ["init", "-q"]);
		await git(dir, ["commit", "-q", "--allow-empty", "-m", "root"]);
		await fire("session_start", { reason: "startup" }, ctx);

		const args = { command: 'git commit --allow-empty -m "work"' };
		await fire("tool_execution_start", { toolCallId: "call-1", toolName: "bash", args }, ctx);
		await fire("tool_result", { toolCallId: "call-1", toolName: "bash", input: args }, ctx);
		await git(dir, ["commit", "-q", "--allow-empty", "-m", "work"]);
		await fire(
			"tool_execution_end",
			{ toolCallId: "call-1", toolName: "bash", result: { content: [] }, isError: false },
			ctx,
		);

		// The same command runs again but creates nothing, so the counter must not move.
		await fire("tool_execution_start", { toolCallId: "call-2", toolName: "bash", args }, ctx);
		await fire("tool_result", { toolCallId: "call-2", toolName: "bash", input: args }, ctx);
		await fire(
			"tool_execution_end",
			{ toolCallId: "call-2", toolName: "bash", result: { content: [] }, isError: false },
			ctx,
		);
		await fire("session_shutdown", { reason: "quit" }, ctx);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}

	assert.deepEqual(
		metricPoints(captures, "claude_code.commit.count").map((point) => point.value),
		[1],
	);
});

test("pull requests count once per created url", async () => {
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
	// A retry that prints the same url is the same pull request.
	await fire("tool_execution_start", { toolCallId: "call-2", toolName: "bash", args }, ctx);
	await fire("tool_result", { toolCallId: "call-2", toolName: "bash", input: args }, ctx);
	await fire("tool_execution_end", { toolCallId: "call-2", toolName: "bash", result, isError: false }, ctx);
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

	const change = logRecords(captures).find((record) => record.eventName === "claude_code.permission_mode_changed");
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
	assert.ok(logRecords(captures).some((record) => record.eventName === "claude_code.api_request"));
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
		.filter((record) => record.eventName === "claude_code.api_request")
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

	assert.ok(logRecords(captures).some((record) => record.eventName === "claude_code.api_request"));
});
