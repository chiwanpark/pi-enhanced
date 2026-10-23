import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import {
	BACKFILL_LEDGER_FILE,
	parseBackfillArgs,
	parseTimeExpression,
	readLedger,
	replaySession,
	runBackfillCommand,
	writeLedger,
} from "../extensions/internal/otel/backfill.ts";
import { buildOtelConfig } from "../extensions/internal/otel/config.ts";
import type { TelemetrySink } from "../extensions/internal/otel/sink.ts";

type Call = { method: string; args: unknown[] };

function recordingSink(): TelemetrySink & { calls: Call[] } {
	const calls: Call[] = [];
	const record =
		(method: string) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
		};
	return {
		calls,
		addSession: record("addSession"),
		addLinesOfCode: record("addLinesOfCode"),
		addPullRequests: record("addPullRequests"),
		addCommits: record("addCommits"),
		addCost: record("addCost"),
		addTokens: record("addTokens"),
		addCodeEditDecision: record("addCodeEditDecision"),
		addActiveTime: record("addActiveTime"),
		emitEvent: record("emitEvent"),
		forceFlush: async () => {},
		shutdown: async () => {},
	};
}

function config(env: Record<string, string> = {}) {
	return buildOtelConfig(
		{ CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "console", OTEL_LOGS_EXPORTER: "console", ...env },
		[],
	);
}

const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function usage(total: number) {
	return {
		input: 10,
		output: 5,
		cacheRead: 20,
		cacheWrite: 2,
		totalTokens: 37,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

function sessionEntries(options: { provider?: string; sessionId?: string; extra?: FileEntry[] } = {}): FileEntry[] {
	const provider = options.provider ?? "anthropic";
	return [
		{ type: "session", version: 3, id: options.sessionId ?? "session-1", timestamp: at(0), cwd: "/tmp/project" },
		{ type: "model_change", id: "m1", parentId: null, timestamp: at(0), provider, modelId: "claude-opus-5" },
		{ type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: at(0), thinkingLevel: "xhigh" },
		{
			type: "message",
			id: "u1",
			parentId: "t1",
			timestamp: at(1),
			message: { role: "user", content: [{ type: "text", text: "fix the bug" }], timestamp: T0 + 1000 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: at(4),
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Editing now." },
					{ type: "toolCall", id: "call-edit", name: "edit", arguments: { path: "src/a.ts" } },
					{ type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "git commit -m fix" } },
				],
				api: "anthropic-messages",
				provider,
				model: "claude-opus-5",
				responseId: "msg_1",
				usage: usage(0.5),
				stopReason: "toolUse",
				timestamp: T0 + 1000,
			},
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: at(5),
			message: {
				role: "toolResult",
				toolCallId: "call-edit",
				toolName: "edit",
				content: [{ type: "text", text: "ok" }],
				details: { patch: "--- a\n+++ b\n+one\n+two\n-three" },
				isError: false,
				timestamp: T0 + 5000,
			},
		},
		{
			type: "message",
			id: "r2",
			parentId: "r1",
			timestamp: at(7),
			message: {
				role: "toolResult",
				toolCallId: "call-bash",
				toolName: "bash",
				content: [{ type: "text", text: "committed" }],
				isError: false,
				timestamp: T0 + 7000,
			},
		},
		...(options.extra ?? []),
	] as FileEntry[];
}

const everything = { startMs: 0, endMs: Number.POSITIVE_INFINITY };

test("a saved session replays the events and metrics the live exporter reports", async () => {
	const sink = recordingSink();
	const summary = await replaySession(sessionEntries(), sink, { config: config(), window: everything, exported: [] });

	const events = sink.calls.filter((call) => call.method === "emitEvent");
	assert.deepEqual(
		events.map((call) => call.args[0]),
		["user_prompt", "api_request", "assistant_response", "tool_result", "tool_result"],
	);
	assert.deepEqual(
		events.map((call) => call.args[2]),
		[T0 + 1000, T0 + 4000, T0 + 4000, T0 + 5000, T0 + 7000],
	);
	const promptIds = new Set(events.map((call) => (call.args[1] as Record<string, unknown>)["prompt.id"]));
	assert.equal(promptIds.size, 1);

	const apiRequest = events[1]?.args[1] as Record<string, unknown>;
	assert.equal(apiRequest["duration_ms"], 3000);
	assert.equal(apiRequest["effort"], "xhigh");
	assert.equal(apiRequest["request_id"], "msg_1");
	assert.equal((events[0]?.args[1] as Record<string, unknown>)["prompt"], "<REDACTED>");
	assert.equal((events[4]?.args[1] as Record<string, unknown>)["duration_ms"], 3000);

	const metric = (method: string) => sink.calls.filter((call) => call.method === method).map((call) => call.args);
	assert.deepEqual(metric("addSession"), [["fresh"]]);
	assert.deepEqual(metric("addCost"), [[0.5, { model: "claude-opus-5", query_source: "main", effort: undefined }]]);
	assert.equal(metric("addTokens").length, 4);
	assert.deepEqual(metric("addLinesOfCode"), [
		["added", 2, "claude-opus-5"],
		["removed", 1, "claude-opus-5"],
	]);
	assert.deepEqual(metric("addCommits"), [[1]]);
	assert.deepEqual(metric("addActiveTime"), [[6, "cli"]]);
	assert.equal(summary.events, 5);
	assert.equal(summary.metrics, sink.calls.length - 5);
});

test("entries outside the window, already backfilled, or exported live are skipped", async () => {
	const live = {
		type: "custom",
		customType: "otel-export",
		id: "x1",
		parentId: "r2",
		timestamp: at(5),
		data: { sessionId: "session-1" },
	} as FileEntry;

	const windowed = recordingSink();
	await replaySession(sessionEntries(), windowed, {
		config: config(),
		window: { startMs: T0 + 2000, endMs: T0 + 6000 },
		exported: [],
	});
	assert.deepEqual(
		windowed.calls.filter((call) => call.method === "emitEvent").map((call) => call.args[2]),
		[T0 + 4000, T0 + 4000, T0 + 5000],
	);
	assert.equal(
		windowed.calls.some((call) => call.method === "addSession" || call.method === "addActiveTime"),
		false,
	);

	const ledgered = recordingSink();
	await replaySession(sessionEntries(), ledgered, {
		config: config(),
		window: everything,
		exported: [{ startMs: 0, endMs: T0 + 4500 }],
	});
	assert.deepEqual(
		ledgered.calls.filter((call) => call.method === "emitEvent").map((call) => call.args[2]),
		[T0 + 5000, T0 + 7000],
	);

	const marked = recordingSink();
	await replaySession(sessionEntries({ extra: [live] }), marked, {
		config: config(),
		window: everything,
		exported: [],
	});
	assert.deepEqual(
		marked.calls.filter((call) => call.method === "emitEvent").map((call) => call.args[2]),
		[T0 + 1000, T0 + 4000, T0 + 4000],
	);
});

test("anthropic only configuration replays nothing from another provider", async () => {
	const sink = recordingSink();
	const summary = await replaySession(sessionEntries({ provider: "openai-codex" }), sink, {
		config: config({ OTEL_SERVICE_NAME: "x" }),
		window: everything,
		exported: [],
	});
	assert.ok(summary.events > 0);

	const restricted = buildOtelConfig(
		{ CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "console", OTEL_LOGS_EXPORTER: "console" },
		[{ otelExporter: { restrictToAnthropicProvider: true } }],
	);
	const skipped = recordingSink();
	assert.deepEqual(
		await replaySession(sessionEntries({ provider: "openai-codex" }), skipped, {
			config: restricted,
			window: everything,
			exported: [],
		}),
		{ events: 0, metrics: 0 },
	);
	assert.deepEqual(skipped.calls, []);
});

test("backfill options accept dates and reject anything else", () => {
	assert.deepEqual(parseBackfillArgs(["--since", "2026-10-01", "--until=2026-10-02", "--dry-run"]), {
		sinceMs: Date.parse("2026-10-01"),
		untilMs: Date.parse("2026-10-02"),
		dryRun: true,
		yes: false,
	});
	assert.deepEqual(parseBackfillArgs([]), { sinceMs: undefined, untilMs: undefined, dryRun: false, yes: false });
	assert.ok("error" in parseBackfillArgs(["--since", "yesterday-ish"]));
	assert.ok("error" in parseBackfillArgs(["--since"]));
	assert.ok("error" in parseBackfillArgs(["--force"]));
	assert.ok("error" in parseBackfillArgs(["--since", "2026-10-02", "--until", "2026-10-01"]));
});

test("backfill times accept wordy relative expressions", () => {
	const now = Date.parse("2026-10-23T15:30:00.000Z");
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	const yesterday = new Date(midnight);
	yesterday.setDate(yesterday.getDate() - 1);
	const monthAgo = new Date(now);
	monthAgo.setMonth(monthAgo.getMonth() - 1);

	assert.equal(parseTimeExpression("now", now), now);
	assert.equal(parseTimeExpression("Today", now), midnight.getTime());
	assert.equal(parseTimeExpression("yesterday", now), yesterday.getTime());
	assert.equal(parseTimeExpression("1 hour ago", now), now - 3_600_000);
	assert.equal(parseTimeExpression("an hour ago", now), now - 3_600_000);
	assert.equal(parseTimeExpression("2 days ago", now), now - 2 * 86_400_000);
	assert.equal(parseTimeExpression("30m ago", now), now - 30 * 60_000);
	assert.equal(parseTimeExpression("3 weeks ago", now), now - 21 * 86_400_000);
	assert.equal(parseTimeExpression("1 month ago", now), monthAgo.getTime());
	assert.equal(parseTimeExpression('"2 days ago"', now), now - 2 * 86_400_000);
	assert.equal(parseTimeExpression("2 fortnights ago", now), undefined);
	assert.equal(parseTimeExpression("soon", now), undefined);

	assert.deepEqual(parseBackfillArgs(["--since", "2", "days", "ago", "--until", "1", "hour", "ago", "--yes"], now), {
		sinceMs: now - 2 * 86_400_000,
		untilMs: now - 3_600_000,
		dryRun: false,
		yes: true,
	});
	assert.deepEqual(parseBackfillArgs(['--since="2', "days", 'ago"', "--until", "now"], now), {
		sinceMs: now - 2 * 86_400_000,
		untilMs: now,
		dryRun: false,
		yes: false,
	});
	assert.ok("error" in parseBackfillArgs(["--since", "today", "--until", "yesterday"], now));
});

test("the ledger round trips exported ranges per session", async () => {
	const dir = await mkdtemp(join(tmpdir(), "otel-ledger-"));
	try {
		const file = join(dir, BACKFILL_LEDGER_FILE);
		assert.equal(readLedger(file).size, 0);
		writeLedger(file, new Map([["session-1", [{ startMs: 0, endMs: T0 }]]]));
		assert.deepEqual(readLedger(file), new Map([["session-1", [{ startMs: 0, endMs: T0 }]]]));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

async function startCollector(): Promise<{ server: Server; port: number; bodies: { path: string; body: unknown }[] }> {
	const bodies: { path: string; body: unknown }[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			bodies.push({ path: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	return { server, port: (server.address() as { port: number }).port, bodies };
}

type LogRecord = { timeUnixNano?: string; attributes: { key: string; value: Record<string, unknown> }[] };

test("the backfill command exports saved sessions once and records them in the ledger", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "otel-backfill-"));
	const { server, port, bodies } = await startCollector();
	try {
		const sessionDir = join(agentDir, "sessions", "--tmp-project--");
		await mkdir(sessionDir, { recursive: true });
		const lines = sessionEntries({ sessionId: "saved-session" }).map((entry) => JSON.stringify(entry));
		await writeFile(join(sessionDir, "saved.jsonl"), `${lines.join("\n")}\n`);

		const otel = buildOtelConfig(
			{
				CLAUDE_CODE_ENABLE_TELEMETRY: "1",
				OTEL_METRICS_EXPORTER: "otlp",
				OTEL_LOGS_EXPORTER: "otlp",
				OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
				OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
			},
			[],
		);
		const notices: { message: string; level: string }[] = [];
		const ctx = {
			hasUI: false,
			mode: "tui",
			model: { id: "claude-opus-5", provider: "anthropic" },
			ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
			sessionManager: { getSessionDir: () => join(agentDir, "elsewhere") },
		};
		const now = () => T0 + 60_000;

		await runBackfillCommand([], ctx as never, otel, { agentDir, now });

		const records: LogRecord[] = [];
		for (const { path, body } of bodies) {
			if (!path.includes("logs")) continue;
			const logs = body as { resourceLogs: { scopeLogs: { logRecords: LogRecord[] }[] }[] };
			for (const resource of logs.resourceLogs)
				for (const scope of resource.scopeLogs) records.push(...scope.logRecords);
		}
		assert.equal(records.length, 5);
		assert.equal(records[0]?.timeUnixNano, String(BigInt(T0 + 1000) * 1_000_000n));
		const sessionIds = new Set(
			records.map((record) => Object.values(record.attributes.find((a) => a.key === "session.id")?.value ?? {})[0]),
		);
		assert.deepEqual([...sessionIds], ["saved-session"]);
		assert.ok(bodies.some(({ path }) => path.includes("metrics")));
		assert.match(notices.at(-1)?.message ?? "", /exported 1 of 1 sessions/);

		const ledger = JSON.parse(await readFile(join(agentDir, BACKFILL_LEDGER_FILE), "utf8")) as unknown;
		assert.deepEqual(ledger, {
			sessions: { "saved-session": [{ start: new Date(0).toISOString(), end: new Date(now()).toISOString() }] },
		});

		const sent = bodies.length;
		await runBackfillCommand([], ctx as never, otel, { agentDir, now });
		assert.equal(bodies.length, sent);
		assert.match(notices.at(-1)?.message ?? "", /nothing to export/);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(agentDir, { recursive: true, force: true });
	}
});
