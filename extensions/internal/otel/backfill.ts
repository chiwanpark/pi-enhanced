import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	migrateSessionEntries,
	parseSessionEntries,
	type ExtensionCommandContext,
	type FileEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { getPackageVersion } from "../common.ts";
import { buildStandardAttributes } from "./attributes.ts";
import { hasActiveExporter, type OtelExporterConfig } from "./config.ts";
import { detectEntrypoint, detectTerminalType, loadIdentity, resolveOrganizationId } from "./identity.ts";
import { codeEditToolName, isAnthropicProvider } from "./mappers.ts";
import { gitUserEmail } from "./observe.ts";
import {
	lineCountsFromDetails,
	lineCountsFromWrittenContent,
	recordAssistantMessage,
	recordToolResult,
	recordUserPrompt,
	textFromContent,
} from "./recorders.ts";
import { createTelemetrySink, type TelemetrySink } from "./sink.ts";

export const LIVE_EXPORT_ENTRY_TYPE = "otel-export";
export const BACKFILL_LEDGER_FILE = "pi-enhanced-otel-backfill.json";

const HARMFUL_MODE_ENTRY_TYPE = "harmful-mode";
const FLUSH_EVERY_EVENTS = 512;

export type TimeRange = { startMs: number; endMs: number };

export interface ReplayOptions {
	config: OtelExporterConfig;
	window: TimeRange;
	exported: readonly TimeRange[];
}

export interface ReplaySummary {
	events: number;
	metrics: number;
}

type CountingSink = TelemetrySink & { counts: ReplaySummary };

const NOOP_SINK: TelemetrySink = {
	addSession: () => {},
	addLinesOfCode: () => {},
	addPullRequests: () => {},
	addCommits: () => {},
	addCost: () => {},
	addTokens: () => {},
	addCodeEditDecision: () => {},
	addActiveTime: () => {},
	emitEvent: () => {},
	forceFlush: async () => {},
	shutdown: async () => {},
};

export function countingSink(target: TelemetrySink = NOOP_SINK): CountingSink {
	const counts: ReplaySummary = { events: 0, metrics: 0 };
	const metric =
		<T extends unknown[]>(forward: (...args: T) => void) =>
		(...args: T) => {
			counts.metrics += 1;
			forward(...args);
		};
	return {
		counts,
		addSession: metric((startType) => target.addSession(startType)),
		addLinesOfCode: metric((type, lines, model) => target.addLinesOfCode(type, lines, model)),
		addPullRequests: metric((count) => target.addPullRequests(count)),
		addCommits: metric((count) => target.addCommits(count)),
		addCost: metric((costUsd, extra) => target.addCost(costUsd, extra)),
		addTokens: metric((type, tokens, extra) => target.addTokens(type, tokens, extra)),
		addCodeEditDecision: metric((extra) => target.addCodeEditDecision(extra)),
		addActiveTime: metric((seconds, type) => target.addActiveTime(seconds, type)),
		emitEvent: (name, extra, timestampMs) => {
			counts.events += 1;
			target.emitEvent(name, extra, timestampMs);
		},
		forceFlush: () => target.forceFlush(),
		shutdown: () => target.shutdown(),
	};
}

function timestampOf(value: unknown): number {
	if (typeof value === "number") return value;
	return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

function sessionHeader(entries: readonly FileEntry[]): SessionHeader | undefined {
	return entries.find((entry): entry is SessionHeader => entry.type === "session");
}

function liveExportStartMs(entries: readonly FileEntry[]): number {
	let earliest = Number.POSITIVE_INFINITY;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== LIVE_EXPORT_ENTRY_TYPE) continue;
		const ms = timestampOf(entry.timestamp);
		if (ms < earliest) earliest = ms;
	}
	return earliest;
}

function initialProvider(entries: readonly FileEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type === "model_change") return entry.provider;
		if (entry.type === "message" && entry.message.role === "assistant") return entry.message.provider;
	}
	return undefined;
}

export async function replaySession(
	entries: readonly FileEntry[],
	target: TelemetrySink,
	options: ReplayOptions,
): Promise<ReplaySummary> {
	const { config, window, exported } = options;
	const sink = countingSink(target);
	const liveSinceMs = liveExportStartMs(entries);
	const include = (ms: number) =>
		Number.isFinite(ms) &&
		ms >= window.startMs &&
		ms < window.endMs &&
		ms < liveSinceMs &&
		!exported.some((range) => ms >= range.startMs && ms < range.endMs);
	const gate = (provider: string | undefined) =>
		config.restrictToAnthropicProvider && !isAnthropicProvider(provider) ? undefined : sink;

	let provider = initialProvider(entries);
	let modelId: string | undefined;
	let thinkingLevel: string | undefined;
	let permissionMode: "default" | "bypassPermissions" = "default";
	let promptId: string | undefined;
	let span: { startMs: number; endMs: number; provider: string | undefined } | undefined;
	let flushedEvents = 0;
	const toolCalls = new Map<string, { startMs: number; input: unknown }>();
	const base = () => (promptId ? { "prompt.id": promptId } : {});

	const closeSpan = () => {
		if (span && config.metrics.activeTime && include(span.startMs)) {
			gate(span.provider)?.addActiveTime((span.endMs - span.startMs) / 1000, "cli");
		}
		span = undefined;
	};

	const header = sessionHeader(entries);
	if (header && config.metrics.sessionCount && include(timestampOf(header.timestamp))) {
		gate(provider)?.addSession(header.parentSession ? "continue" : "fresh");
	}

	for (const entry of entries) {
		if (entry.type === "session") continue;
		const ms = timestampOf(entry.timestamp);

		if (entry.type === "model_change") {
			provider = entry.provider;
			modelId = entry.modelId;
		} else if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "custom" && entry.customType === HARMFUL_MODE_ENTRY_TYPE) {
			const next = (entry.data as { active?: unknown } | undefined)?.active === true ? "bypassPermissions" : "default";
			if (next !== permissionMode && config.events.permissionModeChanged && include(ms)) {
				gate(provider)?.emitEvent(
					"permission_mode_changed",
					{ ...base(), from_mode: permissionMode, to_mode: next, trigger: "shift_tab" },
					ms,
				);
			}
			permissionMode = next;
		} else if (entry.type === "compaction") {
			if (config.events.compaction && include(ms)) {
				gate(provider)?.emitEvent(
					"compaction",
					{ ...base(), success: "true", pre_tokens: entry.tokensBefore, from_extension: entry.fromHook },
					ms,
				);
			}
		} else if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user") {
				closeSpan();
				promptId = randomUUID();
				span = { startMs: ms, endMs: ms, provider };
				const target = include(ms) ? gate(provider) : undefined;
				if (target) {
					recordUserPrompt(
						target,
						config,
						textFromContent(message.content),
						{ ...base(), model: modelId, provider },
						ms,
					);
				}
			} else if (message.role === "assistant") {
				const assistant = message as AssistantMessage;
				if (span) span.endMs = ms;
				for (const block of assistant.content) {
					if (block.type === "toolCall") toolCalls.set(block.id, { startMs: ms, input: block.arguments });
				}
				const target = include(ms) ? gate(assistant.provider) : undefined;
				if (target) {
					const startMs = timestampOf(assistant.timestamp);
					recordAssistantMessage(target, config, assistant, {
						base: base(),
						durationMs: Number.isFinite(startMs) ? Math.max(0, ms - startMs) : 0,
						statusCode: undefined,
						requestId: undefined,
						thinkingLevel,
						timestampMs: ms,
					});
				}
			} else if (message.role === "toolResult") {
				if (span) span.endMs = ms;
				const call = toolCalls.get(message.toolCallId);
				toolCalls.delete(message.toolCallId);
				const target = include(ms) ? gate(provider) : undefined;
				if (target) {
					const input = call?.input;
					const details = (message as { details?: unknown }).details as Record<string, unknown> | undefined;
					const wantsLineCounts =
						!message.isError && config.metrics.linesOfCode && codeEditToolName(message.toolName) !== undefined;
					recordToolResult(target, config, {
						base: base(),
						toolName: message.toolName,
						toolCallId: message.toolCallId,
						input,
						isError: message.isError,
						resultText: textFromContent(message.content),
						durationMs: call ? Math.max(0, ms - call.startMs) : 0,
						rejected: false,
						lineCounts: wantsLineCounts
							? (lineCountsFromDetails(details) ?? lineCountsFromWrittenContent(input))
							: undefined,
						model: modelId,
						timestampMs: ms,
					});
				}
			}
		}

		if (sink.counts.events - flushedEvents >= FLUSH_EVERY_EVENTS) {
			flushedEvents = sink.counts.events;
			await sink.forceFlush();
		}
	}
	closeSpan();
	return { ...sink.counts };
}

export function listSessionFiles(roots: readonly string[]): string[] {
	const files = new Set<string>();
	const collect = (dir: string, depth: number) => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const full = path.join(dir, name);
			if (name.endsWith(".jsonl")) {
				files.add(full);
				continue;
			}
			if (depth > 0) {
				try {
					if (statSync(full).isDirectory()) collect(full, depth - 1);
				} catch {
					continue;
				}
			}
		}
	};
	for (const root of roots) collect(root, 1);
	return [...files].sort();
}

export function readSessionFile(file: string): FileEntry[] {
	try {
		const entries = parseSessionEntries(readFileSync(file, "utf8"));
		migrateSessionEntries(entries);
		return entries;
	} catch {
		return [];
	}
}

type LedgerFile = { sessions?: Record<string, { start?: unknown; end?: unknown }[]> };

export function readLedger(file: string): Map<string, TimeRange[]> {
	const ledger = new Map<string, TimeRange[]>();
	let parsed: LedgerFile;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8")) as LedgerFile;
	} catch {
		return ledger;
	}
	for (const [sessionId, ranges] of Object.entries(parsed.sessions ?? {})) {
		if (!Array.isArray(ranges)) continue;
		const valid = ranges
			.map((range) => ({ startMs: timestampOf(range.start), endMs: timestampOf(range.end) }))
			.filter((range) => Number.isFinite(range.startMs) && Number.isFinite(range.endMs));
		if (valid.length > 0) ledger.set(sessionId, valid);
	}
	return ledger;
}

export function writeLedger(file: string, ledger: ReadonlyMap<string, readonly TimeRange[]>): void {
	const sessions: Record<string, { start: string; end: string }[]> = {};
	for (const [sessionId, ranges] of ledger) {
		sessions[sessionId] = ranges.map((range) => ({
			start: new Date(range.startMs).toISOString(),
			end: new Date(range.endMs).toISOString(),
		}));
	}
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
}

export interface BackfillArgs {
	sinceMs: number | undefined;
	untilMs: number | undefined;
	dryRun: boolean;
	yes: boolean;
}

export function parseBackfillArgs(args: readonly string[]): BackfillArgs | { error: string } {
	const result: BackfillArgs = { sinceMs: undefined, untilMs: undefined, dryRun: false, yes: false };
	const tokens = args.filter((token) => token.length > 0);
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as string;
		if (token === "--dry-run") {
			result.dryRun = true;
			continue;
		}
		if (token === "--yes" || token === "-y") {
			result.yes = true;
			continue;
		}
		const [flag, inline] = token.split("=", 2) as [string, string | undefined];
		if (flag !== "--since" && flag !== "--until") return { error: `unknown option: ${token}` };
		const value = inline ?? tokens[++index];
		const ms = value === undefined ? Number.NaN : Date.parse(value);
		if (!Number.isFinite(ms)) return { error: `${flag} needs a date such as 2026-10-01 or 2026-10-01T09:00:00Z` };
		if (flag === "--since") result.sinceMs = ms;
		else result.untilMs = ms;
	}
	if (result.sinceMs !== undefined && result.untilMs !== undefined && result.sinceMs >= result.untilMs) {
		return { error: "--since must be earlier than --until" };
	}
	return result;
}

export interface BackfillCommandOptions {
	agentDir?: string;
	now?: () => number;
}

type PlannedSession = { file: string; sessionId: string; summary: ReplaySummary };

function formatWindow(window: TimeRange): string {
	const since = window.startMs > 0 ? new Date(window.startMs).toISOString() : "the beginning";
	return `${since} to ${new Date(window.endMs).toISOString()}`;
}

export async function runBackfillCommand(
	args: readonly string[],
	ctx: ExtensionCommandContext,
	config: OtelExporterConfig,
	options: BackfillCommandOptions = {},
): Promise<void> {
	if (!hasActiveExporter(config)) {
		ctx.ui.notify("otel backfill: no exporter is active, run /otel to see why", "warning");
		return;
	}
	const parsed = parseBackfillArgs(args);
	if ("error" in parsed) {
		ctx.ui.notify(`otel backfill: ${parsed.error}`, "error");
		return;
	}

	const nowMs = (options.now ?? Date.now)();
	const window: TimeRange = {
		startMs: parsed.sinceMs ?? 0,
		endMs: Math.min(parsed.untilMs ?? nowMs, nowMs),
	};
	const agentDir = options.agentDir ?? getAgentDir();
	const ledgerFile = path.join(agentDir, BACKFILL_LEDGER_FILE);
	const ledger = readLedger(ledgerFile);
	const files = listSessionFiles([path.join(agentDir, "sessions"), ctx.sessionManager.getSessionDir()]);

	const plan: PlannedSession[] = [];
	for (const file of files) {
		const entries = readSessionFile(file);
		const header = sessionHeader(entries);
		if (!header) continue;
		const summary = await replaySession(entries, NOOP_SINK, {
			config,
			window,
			exported: ledger.get(header.id) ?? [],
		});
		if (summary.events + summary.metrics > 0) plan.push({ file, sessionId: header.id, summary });
	}

	const events = plan.reduce((total, item) => total + item.summary.events, 0);
	const metrics = plan.reduce((total, item) => total + item.summary.metrics, 0);
	if (plan.length === 0) {
		ctx.ui.notify(`otel backfill: nothing to export from ${formatWindow(window)}`, "info");
		return;
	}
	const description = `${plan.length} sessions, ${events} events, ${metrics} metric updates, from ${formatWindow(window)}`;
	if (parsed.dryRun) {
		ctx.ui.notify(`otel backfill (dry run): ${description}`, "info");
		return;
	}
	if (ctx.hasUI && !parsed.yes) {
		const confirmed = await ctx.ui.confirm(
			"Backfill OpenTelemetry export",
			[
				`Export ${description}?`,
				"Events keep their original timestamps; metrics are stamped with the current time.",
				"Sessions exported live by an older pi-enhanced carry no marker and would be counted twice; narrow the range with --since and --until.",
			].join("\n"),
		);
		if (!confirmed) return;
	}

	const serviceVersion = getPackageVersion();
	let identity = loadIdentity(ctx.model?.provider, {
		claudeCode: config.useClaudeCodeIdentity,
		configured: { userId: config.userId, email: config.userEmail, accountUuid: config.accountUuid },
	});
	if (!identity.email) identity = { ...identity, email: await gitUserEmail() };
	const organizationId = resolveOrganizationId(config.organizationId, process.env, identity.organizationId);

	ctx.ui.notify(`otel backfill: exporting ${description}`, "info");
	let exportedSessions = 0;
	const failures: string[] = [];
	for (const item of plan) {
		const errors: string[] = [];
		const sink = createTelemetrySink({
			config,
			serviceVersion,
			standardAttributes: buildStandardAttributes({
				config,
				sessionId: item.sessionId,
				appVersion: serviceVersion,
				entrypoint: detectEntrypoint(ctx.mode),
				identity,
				terminalType: detectTerminalType(),
				organizationId,
			}),
			onError: (message) => errors.push(message),
			onExportError: (message) => errors.push(message),
		});
		await replaySession(readSessionFile(item.file), sink, {
			config,
			window,
			exported: ledger.get(item.sessionId) ?? [],
		});
		await sink.shutdown();

		if (errors.length > 0) {
			failures.push(`${item.sessionId}: ${errors[0]}`);
			continue;
		}
		ledger.set(item.sessionId, [...(ledger.get(item.sessionId) ?? []), window]);
		writeLedger(ledgerFile, ledger);
		exportedSessions += 1;
	}

	const lines = [`otel backfill: exported ${exportedSessions} of ${plan.length} sessions`];
	if (failures.length > 0) lines.push(`failed (retry with the same command): ${failures.slice(0, 3).join("; ")}`);
	ctx.ui.notify(lines.join("\n"), failures.length > 0 ? "warning" : "info");
}
