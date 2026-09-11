import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { generateUnifiedPatch, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPackageVersion } from "./internal/common.ts";
import { ActiveTimeTracker } from "./internal/otel/active-time.ts";
import { buildStandardAttributes } from "./internal/otel/attributes.ts";
import {
	hasActiveExporter,
	resolveOtelConfig,
	resolveSignalEndpoint,
	type OtelExporterConfig,
} from "./internal/otel/config.ts";
import { detectEntrypoint, detectTerminalType, loadIdentity, resolveOrganizationId } from "./internal/otel/identity.ts";
import {
	byteLength,
	codeEditToolName,
	commandCreatesCommit,
	commandCreatesPullRequest,
	costUsdMicros,
	diffLineCounts,
	filePathFromToolInput,
	isAnthropicProvider,
	languageFromPath,
	pullRequestUrls,
	serializeToolInput,
	sessionStartType,
	tokenUsageEntries,
	toolErrorType,
	toolParameters,
	truncateContent,
} from "./internal/otel/mappers.ts";
import { gitCommitsBetween, gitHead, gitUserEmail, readTextForDiff } from "./internal/otel/observe.ts";
import { createTelemetrySink, type TelemetrySink } from "./internal/otel/sink.ts";
import { isPlanModeState, PLAN_MODE_STATE_EVENT } from "./internal/plan-mode-state.ts";

const REDACTED = "<REDACTED>";
const HARMFUL_MODE_ENTRY_TYPE = "harmful-mode";
const PLAN_MODE_ENTRY_TYPE = "plan-mode";
const MAX_PENDING_REQUESTS = 32;
const TOKEN_TYPES = ["input", "output", "cacheRead", "cacheCreation"] as const;

type PermissionMode = "default" | "plan" | "bypassPermissions";

type ToolRun = {
	toolName: string;
	input: unknown;
	startMs: number;
	executed: boolean;
	/** File content before a code edit, for the lines-of-code diff. */
	contentBefore: string | undefined;
	filePath: string | undefined;
	/** Commit at `HEAD` before a command that tries to commit. */
	headBefore: string | undefined;
	cwd: string | undefined;
};

type ProviderRequest = {
	startMs: number;
	status: number | undefined;
	requestId: string | undefined;
};

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as { type?: unknown; text?: unknown };
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("");
}

function assistantText(message: AssistantMessage): string {
	return textFromContent(message.content);
}

function detailsOf(result: unknown): Record<string, unknown> | undefined {
	if (!result || typeof result !== "object") return undefined;
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return undefined;
	return details as Record<string, unknown>;
}

function requestIdFromHeaders(headers: Record<string, string>): string | undefined {
	for (const key of ["request-id", "x-request-id", "x-amzn-requestid"]) {
		const value = headers[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function isShellTool(toolName: string): boolean {
	return toolName === "bash" || toolName === "powershell";
}

function commandOf(input: unknown): string | undefined {
	const command = (input as { command?: unknown } | undefined)?.command;
	return typeof command === "string" ? command : undefined;
}

/**
 * Lines added and removed by a code edit. A tool-reported patch is used when present, otherwise the
 * file is re-read and diffed against the snapshot taken before the call, which is what makes the
 * count correct for whole-file writes.
 */
async function countChangedLines(
	run: ToolRun | undefined,
	details: Record<string, unknown> | undefined,
	input: unknown,
): Promise<{ added: number; removed: number } | undefined> {
	const added = details?.["addedLines"];
	const removed = details?.["removedLines"];
	if (typeof added === "number" || typeof removed === "number") {
		return { added: typeof added === "number" ? added : 0, removed: typeof removed === "number" ? removed : 0 };
	}
	if (typeof details?.["patch"] === "string") return diffLineCounts(details["patch"] as string);

	if (run?.filePath && run.contentBefore !== undefined) {
		const after = await readTextForDiff(run.filePath);
		if (after !== undefined) return diffLineCounts(generateUnifiedPatch(run.filePath, run.contentBefore, after));
	}

	// Last resort for a write with no snapshot: treat the written content as added lines.
	const content = (input as { content?: unknown } | undefined)?.content;
	if (typeof content === "string" && content.length > 0) {
		return { added: content.split("\n").length, removed: 0 };
	}
	return undefined;
}

type StatusState = { exporting: boolean; identity: string | undefined; lastError: string | undefined };

/**
 * Register `/otel`. It is registered even when nothing is exported, because a disabled exporter is
 * exactly the situation that needs explaining.
 */
function registerStatusCommand(pi: ExtensionAPI, config: OtelExporterConfig, state: () => StatusState): void {
	pi.registerCommand("otel", {
		description: "Show the OpenTelemetry exporter status, destination, and last error.",
		handler: async (_args, ctx) => {
			const { exporting, identity, lastError } = state();
			const active = hasActiveExporter(config);
			const lines = [
				`enabled: ${config.enabled ? "yes" : "no"}`,
				`metrics: ${config.metricsExporters.join(", ") || "none"}`,
				`events: ${config.logsExporters.join(", ") || "none"}`,
				`metrics endpoint: ${resolveSignalEndpoint(config, "metrics") ?? "(exporter default)"}`,
				`logs endpoint: ${resolveSignalEndpoint(config, "logs") ?? "(exporter default)"}`,
				`discovered from Claude Code: ${config.discoverClaudeCodeSettings ? "yes" : "no"}`,
				`anthropic only: ${config.restrictToAnthropicProvider ? "yes" : "no"}`,
				`exporting this session: ${exporting ? "yes" : "not yet"}`,
				`identity: ${identity ?? "(none)"}`,
				`content: prompts=${config.content.logUserPrompts} responses=${config.content.logAssistantResponses} tool details=${config.content.logToolDetails}`,
			];
			if (!active) {
				lines.push(
					config.enabled
						? "inactive: telemetry is enabled but no signal has an exporter"
						: "inactive: set piEnhanced.otelExporter.enabled or CLAUDE_CODE_ENABLE_TELEMETRY=1",
				);
			}
			if (lastError) lines.push(`last error: ${lastError}`);
			ctx.ui.notify(lines.join("\n"), lastError || !active ? "warning" : "info");
		},
	});
}

/** Wire the pi event surface to a telemetry sink. Exposed separately so tests can inject a config. */
export function createOtelExporter(config: OtelExporterConfig) {
	return function otelExporter(pi: ExtensionAPI) {
		const serviceVersion = getPackageVersion();
		const activeTime = new ActiveTimeTracker();
		const toolRuns = new Map<string, ToolRun>();
		const pendingRequests: ProviderRequest[] = [];
		// Commits and pull requests already counted, so a re-run of the same command cannot double count.
		const countedCommits = new Set<string>();
		const countedPullRequests = new Set<string>();

		let telemetry: TelemetrySink | undefined;
		let sessionCtx: ExtensionContext | undefined;
		const identityOptions = { claudeCode: config.useClaudeCodeIdentity };
		let identity = loadIdentity(undefined, identityOptions);
		let organizationId = resolveOrganizationId(config.organizationId, process.env, identity.organizationId);
		let activeProvider: string | undefined;
		let activeModel: string | undefined;
		let promptId: string | undefined;
		let lastRequest: ProviderRequest | undefined;
		let turnStartMs = Date.now();
		let permissionMode: PermissionMode = "default";
		let compactionStartMs: number | undefined;
		let lastErrorMessage: string | undefined;
		let notifiedError = false;

		function reportError(ctx: ExtensionContext | undefined, message: string): void {
			lastErrorMessage = message;
			tel()?.emitEvent("internal_error", { error: message, component: "otel-exporter" });
			if (notifiedError || !ctx?.hasUI) return;
			notifiedError = true;
			ctx.ui.notify(`OTEL exporter: ${message}`, "warning");
		}

		/** Run a handler body without letting telemetry failures affect the agent. */
		function guard<T extends unknown[]>(handler: (...args: T) => void | Promise<void>): (...args: T) => Promise<void> {
			return async (...args: T) => {
				const ctx = args[1] as ExtensionContext | undefined;
				if (ctx?.sessionManager) sessionCtx = ctx;
				if (ctx?.model) {
					activeProvider = ctx.model.provider;
					activeModel = ctx.model.id;
				}
				try {
					await handler(...args);
				} catch (error) {
					reportError(ctx, error instanceof Error ? error.message : String(error));
				}
			};
		}

		/**
		 * The telemetry sink for the provider that served this data, or undefined when export is
		 * restricted to the first-party Anthropic API and this request went elsewhere. Defaults to the
		 * session's active provider. The sink, and with it the OpenTelemetry SDK, is created on the
		 * first allowed export, so a session that never calls Anthropic loads nothing.
		 */
		function tel(provider = activeProvider): TelemetrySink | undefined {
			if (config.restrictToAnthropicProvider && !isAnthropicProvider(provider)) return undefined;
			if (telemetry) return telemetry;
			const ctx = sessionCtx;
			if (!ctx) return undefined;

			telemetry = createTelemetrySink({
				config,
				serviceVersion,
				standardAttributes: buildStandardAttributes({
					config,
					sessionId: ctx.sessionManager.getSessionId(),
					appVersion: serviceVersion,
					entrypoint: detectEntrypoint(ctx.mode),
					identity,
					terminalType: detectTerminalType(),
					organizationId,
				}),
				onError: (message) => reportError(ctx, message),
			});
			return telemetry;
		}

		function eventBase(): Record<string, unknown> {
			return promptId ? { "prompt.id": promptId } : {};
		}

		function modelAttributes(ctx: ExtensionContext): Record<string, unknown> {
			return { model: ctx.model?.id, provider: ctx.model?.provider };
		}

		function readPermissionMode(ctx: ExtensionContext): PermissionMode {
			let plan = false;
			let harmful = false;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom") continue;
				const active = (entry.data as { active?: unknown } | undefined)?.active;
				if (typeof active !== "boolean") continue;
				if (entry.customType === PLAN_MODE_ENTRY_TYPE) plan = active;
				else if (entry.customType === HARMFUL_MODE_ENTRY_TYPE) harmful = active;
			}
			if (harmful) return "bypassPermissions";
			return plan ? "plan" : "default";
		}

		function setPermissionMode(next: PermissionMode, trigger: string): void {
			if (next === permissionMode) return;
			const from = permissionMode;
			permissionMode = next;
			if (config.events.permissionModeChanged) {
				tel()?.emitEvent("permission_mode_changed", {
					...eventBase(),
					from_mode: from,
					to_mode: next,
					trigger,
				});
			}
		}

		function recordUserActivity(nowMs: number): void {
			if (!config.metrics.activeTime) return;
			tel()?.addActiveTime(activeTime.noteUserActivity(nowMs), "user");
		}

		pi.on(
			"session_start",
			guard(async (event, ctx) => {
				permissionMode = readPermissionMode(ctx);
				identity = loadIdentity(ctx.model?.provider, identityOptions);
				if (!identity.email) {
					// Providers that do not expose an email still resolve to a person through git config.
					identity = { ...identity, email: await gitUserEmail() };
				}
				organizationId = resolveOrganizationId(config.organizationId, process.env, identity.organizationId);

				const startType = sessionStartType(event.reason, ctx.sessionManager.getEntries().length > 0);
				if (startType && config.metrics.sessionCount) {
					tel()?.addSession(startType, activeModel);
				}
				if (config.primeMetricSeries) tel()?.primeSeries(activeModel, TOKEN_TYPES);
			}),
		);

		pi.on(
			"model_select",
			guard(async (event) => {
				activeProvider = event.model.provider;
				activeModel = event.model.id;
			}),
		);

		registerStatusCommand(pi, config, () => ({
			exporting: telemetry !== undefined,
			identity: identity.email ?? identity.userId,
			lastError: lastErrorMessage,
		}));

		pi.events.on(PLAN_MODE_STATE_EVENT, (value) => {
			if (!isPlanModeState(value)) return;
			if (permissionMode === "bypassPermissions") return;
			setPermissionMode(value.active ? "plan" : "default", "shift_tab");
		});

		pi.on(
			"input",
			guard(async (_event, _ctx) => {
				recordUserActivity(Date.now());
			}),
		);

		pi.on(
			"ui_prompt_end",
			guard(async () => {
				recordUserActivity(Date.now());
			}),
		);

		pi.on(
			"before_agent_start",
			guard(async (event, ctx) => {
				promptId = randomUUID();
				setPermissionMode(readPermissionMode(ctx), "shift_tab");
				recordUserActivity(Date.now());
				if (!config.events.userPrompt) return;

				const isCommand = event.prompt.startsWith("/");
				const commandName = isCommand ? event.prompt.slice(1).split(/\s+/)[0] : undefined;
				tel()?.emitEvent("user_prompt", {
					...eventBase(),
					prompt_length: event.prompt.length,
					prompt: config.content.logUserPrompts ? truncateContent(event.prompt, config.content.maxLength) : REDACTED,
					...(commandName
						? { command_name: config.content.logToolDetails ? commandName : "custom", command_source: "custom" }
						: {}),
					...modelAttributes(ctx),
				});
			}),
		);

		pi.on(
			"agent_start",
			guard(async () => {
				activeTime.startCli(Date.now());
			}),
		);

		pi.on(
			"agent_settled",
			guard(async () => {
				if (!config.metrics.activeTime) return;
				tel()?.addActiveTime(activeTime.endCli(Date.now()), "cli");
			}),
		);

		pi.on(
			"turn_start",
			guard(async () => {
				turnStartMs = Date.now();
			}),
		);

		pi.on(
			"before_provider_request",
			guard(async () => {
				// Providers that abstract HTTP never fire after_provider_response, so keep the queue bounded.
				if (pendingRequests.length >= MAX_PENDING_REQUESTS) pendingRequests.shift();
				pendingRequests.push({ startMs: Date.now(), status: undefined, requestId: undefined });
				return undefined;
			}),
		);

		pi.on(
			"after_provider_response",
			guard(async (event, ctx) => {
				const pending = pendingRequests.shift() ?? { startMs: turnStartMs, status: undefined, requestId: undefined };
				pending.status = event.status;
				pending.requestId = requestIdFromHeaders(event.headers);
				lastRequest = pending;

				if (event.status < 400 || !config.events.apiError) return;
				tel()?.emitEvent("api_error", {
					...eventBase(),
					...modelAttributes(ctx),
					error: `HTTP ${event.status}`,
					status_code: event.status,
					duration_ms: Date.now() - pending.startMs,
					attempt: 1,
					request_id: pending.requestId,
					query_source: "main",
				});
				lastRequest = undefined;
			}),
		);

		pi.on(
			"message_end",
			guard(async (event) => {
				if (event.message.role !== "assistant") return;
				const message = event.message;
				const request = lastRequest;
				lastRequest = undefined;
				const nowMs = Date.now();
				const durationMs = nowMs - (request?.startMs ?? turnStartMs);
				const model = message.responseModel ?? message.model;
				const requestId = message.responseId ?? request?.requestId;
				const thinkingLevel = pi.getThinkingLevel();
				const metricAttribution = { model, query_source: "main" };
				const attribution = {
					...metricAttribution,
					provider: message.provider,
					// Providers that report no native effort still have pi's thinking level, unless it is off.
					effort: message.providerThinkingLevel ?? (thinkingLevel === "off" ? undefined : thinkingLevel),
				};
				// Gate on the provider that served this response, not the session's current selection.
				const sink = tel(message.provider);

				if (message.stopReason === "error") {
					if (config.events.apiError) {
						sink?.emitEvent("api_error", {
							...eventBase(),
							...attribution,
							error: message.errorMessage ?? "unknown error",
							status_code: request?.status,
							duration_ms: durationMs,
							attempt: 1,
							request_id: requestId,
						});
					}
					return;
				}

				if (message.rawStopReason === "refusal" && config.events.apiRefusal) {
					sink?.emitEvent("api_refusal", { ...eventBase(), ...attribution, duration_ms: durationMs });
				}

				const usage = message.usage;
				if (config.events.apiRequest) {
					sink?.emitEvent("api_request", {
						...eventBase(),
						...attribution,
						cost_usd: usage.cost.total,
						cost_usd_micros: costUsdMicros(usage.cost.total),
						duration_ms: durationMs,
						input_tokens: usage.input,
						output_tokens: usage.output,
						cache_read_tokens: usage.cacheRead,
						cache_creation_tokens: usage.cacheWrite,
						reasoning_tokens: usage.reasoning,
						request_id: requestId,
						stop_reason: message.stopReason,
					});
				}

				if (config.metrics.token) {
					for (const entry of tokenUsageEntries(usage)) {
						sink?.addTokens(entry.type, entry.tokens, metricAttribution);
					}
				}
				if (config.metrics.cost) sink?.addCost(usage.cost.total, metricAttribution);

				if (config.events.assistantResponse) {
					const text = assistantText(message);
					// Claude Code only logs this event for responses that carry text content.
					if (text.length > 0) {
						sink?.emitEvent("assistant_response", {
							...eventBase(),
							...attribution,
							response_length: text.length,
							response: config.content.logAssistantResponses
								? truncateContent(text, config.content.maxLength)
								: REDACTED,
							request_id: requestId,
						});
					}
				}
			}),
		);

		pi.on(
			"tool_execution_start",
			guard(async (event, ctx) => {
				const run: ToolRun = {
					toolName: event.toolName,
					input: event.args,
					startMs: Date.now(),
					executed: false,
					contentBefore: undefined,
					filePath: undefined,
					headBefore: undefined,
					cwd: ctx.cwd,
				};
				toolRuns.set(event.toolCallId, run);
				if (!tel()) return;

				// Snapshot the file so lines added and removed can be measured from the real change.
				if (config.metrics.linesOfCode && codeEditToolName(event.toolName)) {
					const relativePath = filePathFromToolInput(event.args);
					if (relativePath) {
						run.filePath = resolvePath(ctx.cwd, relativePath);
						run.contentBefore = await readTextForDiff(run.filePath);
					}
				}

				// Snapshot HEAD so only commands that actually advance it are counted as commits.
				if (config.metrics.commit && isShellTool(event.toolName)) {
					const command = commandOf(event.args);
					if (commandCreatesCommit(command)) run.headBefore = await gitHead(ctx.cwd);
				}
			}),
		);

		pi.on(
			"tool_result",
			guard(async (event) => {
				const run = toolRuns.get(event.toolCallId);
				if (run) run.executed = true;
				return undefined;
			}),
		);

		pi.on(
			"tool_execution_end",
			guard(async (event, ctx) => {
				const run = toolRuns.get(event.toolCallId);
				toolRuns.delete(event.toolCallId);
				const durationMs = run ? Date.now() - run.startMs : 0;
				const input = run?.input ?? undefined;
				const resultText = textFromContent((event.result as { content?: unknown } | undefined)?.content);
				// Blocked calls never reach the tool_result hook, so a missing flag means the call was rejected.
				const rejected = run !== undefined && !run.executed;
				const editTool = codeEditToolName(event.toolName);
				const filePath = filePathFromToolInput(input);
				const details = detailsOf(event.result);
				const withDetails = config.content.logToolDetails;

				if (rejected) {
					if (config.events.toolDecision) {
						tel()?.emitEvent("tool_decision", {
							...eventBase(),
							tool_name: event.toolName,
							tool_use_id: event.toolCallId,
							decision: "reject",
							source: "hook",
							tool_source: "builtin",
							...(withDetails ? { tool_parameters: JSON.stringify(toolParameters(event.toolName, input) ?? {}) } : {}),
						});
					}
					if (editTool && config.metrics.codeEditToolDecision) {
						tel()?.addCodeEditDecision({
							tool_name: editTool,
							decision: "reject",
							source: "hook",
							language: languageFromPath(filePath),
						});
					}
					return;
				}

				if (config.events.toolResult) {
					tel()?.emitEvent("tool_result", {
						...eventBase(),
						tool_name: event.toolName,
						tool_use_id: event.toolCallId,
						success: event.isError ? "false" : "true",
						duration_ms: durationMs,
						error_type: event.isError ? toolErrorType(resultText) : undefined,
						error: event.isError && withDetails ? truncateContent(resultText, config.content.maxLength) : undefined,
						decision_type: "accept",
						decision_source: "config",
						tool_input_size_bytes: byteLength(
							serializeToolInput(input, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
						),
						tool_result_size_bytes: byteLength(resultText),
						...(withDetails
							? {
									tool_parameters: JSON.stringify(toolParameters(event.toolName, input) ?? {}),
									tool_input: serializeToolInput(input),
								}
							: {}),
					});
				}

				if (editTool && config.metrics.codeEditToolDecision) {
					tel()?.addCodeEditDecision({
						tool_name: editTool,
						decision: "accept",
						source: "config",
						language: languageFromPath(filePath),
					});
				}

				if (!event.isError && config.metrics.linesOfCode && editTool) {
					const model = ctx.model?.id;
					const counts = await countChangedLines(run, details, input);
					if (counts) {
						tel()?.addLinesOfCode("added", counts.added, model);
						tel()?.addLinesOfCode("removed", counts.removed, model);
					}
				}

				if (isShellTool(event.toolName)) {
					const command = commandOf(input);
					// A commit counts only when HEAD actually moved, so failed or empty commits are ignored.
					if (config.metrics.commit && run?.headBefore !== undefined && run.cwd) {
						const created = await gitCommitsBetween(run.cwd, run.headBefore, await gitHead(run.cwd));
						const fresh = created.filter((commit) => !countedCommits.has(commit));
						for (const commit of fresh) countedCommits.add(commit);
						if (fresh.length > 0) tel()?.addCommits(fresh.length);
					}
					// A pull request counts only when the command printed a new PR or MR url.
					if (config.metrics.pullRequest && !event.isError && commandCreatesPullRequest(command)) {
						const fresh = pullRequestUrls(resultText).filter((url) => !countedPullRequests.has(url));
						for (const url of fresh) countedPullRequests.add(url);
						if (fresh.length > 0) tel()?.addPullRequests(fresh.length);
					}
				}
			}),
		);

		pi.on(
			"session_before_compact",
			guard(async () => {
				compactionStartMs = Date.now();
				return undefined;
			}),
		);

		pi.on(
			"session_compact",
			guard(async (event) => {
				if (!config.events.compaction) return;
				tel()?.emitEvent("compaction", {
					...eventBase(),
					trigger: event.reason === "manual" ? "manual" : "auto",
					success: "true",
					duration_ms: Date.now() - (compactionStartMs ?? Date.now()),
					pre_tokens: event.compactionEntry?.tokensBefore,
					from_extension: event.fromExtension,
				});
				compactionStartMs = undefined;
			}),
		);

		pi.on(
			"session_compact_failed",
			guard(async (event) => {
				if (!config.events.compaction) return;
				tel()?.emitEvent("compaction", {
					...eventBase(),
					trigger: event.reason === "manual" ? "manual" : "auto",
					success: "false",
					duration_ms: Date.now() - (compactionStartMs ?? Date.now()),
					error: event.errorMessage ?? (event.aborted ? "aborted" : "unknown error"),
				});
				compactionStartMs = undefined;
			}),
		);

		pi.on(
			"session_shutdown",
			guard(async () => {
				const nowMs = Date.now();
				if (config.metrics.activeTime) tel()?.addActiveTime(activeTime.flushCli(nowMs), "cli");
				// Flush whatever was already recorded, even if the gate is closed for the current model.
				const current = telemetry;
				telemetry = undefined;
				sessionCtx = undefined;
				toolRuns.clear();
				pendingRequests.length = 0;
				await current?.shutdown();
			}),
		);
	};
}

export default function otelExporterExtension(pi: ExtensionAPI) {
	const config = resolveOtelConfig(process.cwd());
	if (!hasActiveExporter(config)) {
		// No hooks and no SDK, but `/otel` still explains why nothing is being exported.
		registerStatusCommand(pi, config, () => ({ exporting: false, identity: undefined, lastError: undefined }));
		return;
	}
	createOtelExporter(config)(pi);
}
