import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { OtelExporterConfig } from "./config.ts";
import {
	byteLength,
	codeEditToolName,
	commandCreatesCommit,
	costUsdMicros,
	diffLineCounts,
	filePathFromToolInput,
	languageFromPath,
	pullRequestsCreated,
	serializeToolInput,
	tokenUsageEntries,
	toolErrorType,
	toolParameters,
	truncateContent,
} from "./mappers.ts";
import type { TelemetrySink } from "./sink.ts";

export const REDACTED = "<REDACTED>";

export type LineCounts = { added: number; removed: number };

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as { type?: unknown; text?: unknown };
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("");
}

export function detailsOf(result: unknown): Record<string, unknown> | undefined {
	if (!result || typeof result !== "object") return undefined;
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return undefined;
	return details as Record<string, unknown>;
}

export function lineCountsFromDetails(details: Record<string, unknown> | undefined): LineCounts | undefined {
	const added = details?.["addedLines"];
	const removed = details?.["removedLines"];
	if (typeof added === "number" || typeof removed === "number") {
		return { added: typeof added === "number" ? added : 0, removed: typeof removed === "number" ? removed : 0 };
	}
	if (typeof details?.["patch"] === "string") return diffLineCounts(details["patch"] as string);
	return undefined;
}

export function lineCountsFromWrittenContent(input: unknown): LineCounts | undefined {
	const content = (input as { content?: unknown } | undefined)?.content;
	if (typeof content === "string" && content.length > 0) {
		return { added: content.split("\n").length, removed: 0 };
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

export function recordUserPrompt(
	sink: TelemetrySink,
	config: OtelExporterConfig,
	prompt: string,
	extra: Record<string, unknown>,
	timestampMs?: number,
): void {
	if (!config.events.userPrompt) return;
	const isCommand = prompt.startsWith("/");
	const commandName = isCommand ? prompt.slice(1).split(/\s+/)[0] : undefined;
	sink.emitEvent(
		"user_prompt",
		{
			...extra,
			prompt_length: prompt.length,
			prompt: config.content.logUserPrompts ? truncateContent(prompt, config.content.maxLength) : REDACTED,
			...(commandName
				? { command_name: config.content.logToolDetails ? commandName : "custom", command_source: "custom" }
				: {}),
		},
		timestampMs,
	);
}

export interface AssistantMessageContext {
	base: Record<string, unknown>;
	durationMs: number;
	statusCode: number | undefined;
	requestId: string | undefined;
	thinkingLevel: string | undefined;
	timestampMs?: number;
}

export function recordAssistantMessage(
	sink: TelemetrySink,
	config: OtelExporterConfig,
	message: AssistantMessage,
	context: AssistantMessageContext,
): void {
	const { base, durationMs, timestampMs, thinkingLevel } = context;
	const model = message.responseModel ?? message.model;
	const requestId = message.responseId ?? context.requestId;
	const metricAttribution = { model, query_source: "main", effort: message.providerThinkingLevel };
	const attribution = {
		...metricAttribution,
		provider: message.provider,
		effort: message.providerThinkingLevel ?? (!thinkingLevel || thinkingLevel === "off" ? undefined : thinkingLevel),
	};

	if (message.stopReason === "error") {
		if (config.events.apiError) {
			sink.emitEvent(
				"api_error",
				{
					...base,
					...attribution,
					error: message.errorMessage ?? "unknown error",
					status_code: context.statusCode,
					duration_ms: durationMs,
					attempt: 1,
					request_id: requestId,
				},
				timestampMs,
			);
		}
		return;
	}

	if (message.rawStopReason === "refusal" && config.events.apiRefusal) {
		sink.emitEvent("api_refusal", { ...base, ...attribution, duration_ms: durationMs }, timestampMs);
	}

	const usage = message.usage;
	if (config.events.apiRequest) {
		sink.emitEvent(
			"api_request",
			{
				...base,
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
			},
			timestampMs,
		);
	}

	if (config.metrics.token) {
		for (const entry of tokenUsageEntries(usage)) sink.addTokens(entry.type, entry.tokens, metricAttribution);
	}
	if (config.metrics.cost) sink.addCost(usage.cost.total, metricAttribution);

	if (config.events.assistantResponse) {
		const text = textFromContent(message.content);
		if (text.length > 0) {
			sink.emitEvent(
				"assistant_response",
				{
					...base,
					...attribution,
					response_length: text.length,
					response: config.content.logAssistantResponses ? truncateContent(text, config.content.maxLength) : REDACTED,
					request_id: requestId,
				},
				timestampMs,
			);
		}
	}
}

export interface ToolResultContext {
	base: Record<string, unknown>;
	toolName: string;
	toolCallId: string;
	input: unknown;
	isError: boolean;
	resultText: string;
	durationMs: number;
	rejected: boolean;
	lineCounts: LineCounts | undefined;
	model: string | undefined;
	timestampMs?: number;
}

export function recordToolResult(sink: TelemetrySink, config: OtelExporterConfig, context: ToolResultContext): void {
	const { base, toolName, toolCallId, input, isError, resultText, timestampMs } = context;
	const editTool = codeEditToolName(toolName);
	const filePath = filePathFromToolInput(input);
	const withDetails = config.content.logToolDetails;

	if (context.rejected) {
		if (config.events.toolDecision) {
			sink.emitEvent(
				"tool_decision",
				{
					...base,
					tool_name: toolName,
					tool_use_id: toolCallId,
					decision: "reject",
					source: "hook",
					tool_source: "builtin",
					...(withDetails ? { tool_parameters: JSON.stringify(toolParameters(toolName, input) ?? {}) } : {}),
				},
				timestampMs,
			);
		}
		if (editTool && config.metrics.codeEditToolDecision) {
			sink.addCodeEditDecision({
				decision: "reject",
				source: "hook",
				tool_name: editTool,
				language: languageFromPath(filePath),
			});
		}
		return;
	}

	if (config.events.toolResult) {
		sink.emitEvent(
			"tool_result",
			{
				...base,
				tool_name: toolName,
				tool_use_id: toolCallId,
				success: isError ? "false" : "true",
				duration_ms: context.durationMs,
				error_type: isError ? toolErrorType(resultText) : undefined,
				error: isError && withDetails ? truncateContent(resultText, config.content.maxLength) : undefined,
				decision_type: "accept",
				decision_source: "config",
				tool_input_size_bytes: byteLength(serializeToolInput(input, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)),
				tool_result_size_bytes: byteLength(resultText),
				...(withDetails
					? {
							tool_parameters: JSON.stringify(toolParameters(toolName, input) ?? {}),
							tool_input: serializeToolInput(input),
						}
					: {}),
			},
			timestampMs,
		);
	}

	if (editTool && config.metrics.codeEditToolDecision) {
		sink.addCodeEditDecision({
			decision: "accept",
			source: "config",
			tool_name: editTool,
			language: languageFromPath(filePath),
		});
	}

	if (!isError && config.metrics.linesOfCode && editTool && context.lineCounts) {
		sink.addLinesOfCode("added", context.lineCounts.added, context.model);
		sink.addLinesOfCode("removed", context.lineCounts.removed, context.model);
	}

	if (isShellTool(toolName) && !isError) {
		const command = commandOf(input);
		if (config.metrics.commit && commandCreatesCommit(command)) sink.addCommits(1);
		if (config.metrics.pullRequest) sink.addPullRequests(pullRequestsCreated(command));
	}
}
