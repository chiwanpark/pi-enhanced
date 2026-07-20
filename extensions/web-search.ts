import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readUsageAuth, refreshUsageAuthIfNeeded } from "./internal/usage-status";

export const DEFAULT_SEARCH_MODEL = "gpt-5.4-mini";
export const DEFAULT_MAX_SOURCES = 5;
export const MAX_ALLOWED_SOURCES = 10;
export const DEFAULT_SEARCH_TIMEOUT_MS = 120_000;
export const DEFAULT_SEARCH_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

const searchWebSchema = Type.Object({
	query: Type.String({ description: "What to search for on the web" }),
	maxSources: Type.Optional(Type.Number({ description: "Maximum number of sources to return" })),
	freshness: Type.Optional(
		StringEnum(["cached", "live"] as const, {
			description: "Use 'cached' for stable topics, 'live' for time-sensitive queries.",
		}),
	),
});

export type SearchWebToolInput = Static<typeof searchWebSchema>;

export interface SearchWebAuth {
	accessToken: string;
	accountId: string;
}

export interface SearchWebSource {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchWebToolDetails {
	query: string;
	freshness: "cached" | "live";
	sourceCount: number;
	sources: SearchWebSource[];
	summary: string;
	truncated: boolean;
}

export interface SearchWebToolConfig {
	model?: string;
	maxSources?: number;
	timeoutMs?: number;
	endpoint?: string;
	maxAllowedSources?: number;
}

export interface SearchWebToolOptions extends SearchWebToolConfig {
	getAuth: () => Promise<SearchWebAuth>;
	fetch?: typeof fetch;
}

const SEARCH_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		summary: { type: "string" },
		sources: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					title: { type: "string" },
					url: { type: "string" },
					snippet: { type: "string" },
				},
				required: ["title", "url", "snippet"],
			},
		},
	},
	required: ["summary", "sources"],
};

interface SSEEvent {
	type: string;
	data: Record<string, unknown>;
}

type OpenAICodexTokenPayload = {
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
	};
};

export function createSearchWebTool(
	options: SearchWebToolOptions,
): AgentTool<typeof searchWebSchema, SearchWebToolDetails | undefined> {
	const fetchImpl = options.fetch ?? fetch;
	const configuredMaxSources = normalizePositiveInteger(options.maxSources, DEFAULT_MAX_SOURCES);
	const maxAllowedSources = normalizePositiveInteger(options.maxAllowedSources, MAX_ALLOWED_SOURCES);
	const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS);
	const model = options.model?.trim() || DEFAULT_SEARCH_MODEL;
	const endpoint = options.endpoint?.trim() || DEFAULT_SEARCH_ENDPOINT;

	return {
		name: "search_web",
		label: "Search Web",
		description:
			"Search the public web with OpenAI and return a concise summary with sources. Use cached freshness for stable topics and live freshness for time-sensitive queries.",
		parameters: searchWebSchema,
		execute: async (_toolCallId, input, signal) => {
			const query = input.query.trim();
			if (query.length === 0) throw new Error("search_web requires a non-empty query.");

			const requestedSources = normalizePositiveInteger(input.maxSources, configuredMaxSources);
			const maxSources = Math.min(requestedSources, maxAllowedSources);
			const freshness = input.freshness ?? "cached";
			const auth = await options.getAuth();

			const controller = new AbortController();
			const timeout = setTimeout(
				() => controller.abort(new Error(`search_web timed out after ${timeoutMs}ms`)),
				timeoutMs,
			);
			const abort = () => controller.abort(signal?.reason);
			signal?.addEventListener("abort", abort, { once: true });

			try {
				if (signal?.aborted) throw new Error("Operation aborted");
				const response = await fetchImpl(endpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${auth.accessToken}`,
						"ChatGPT-Account-ID": auth.accountId,
					},
					body: JSON.stringify({
						model,
						instructions: buildSearchPrompt(query, maxSources, freshness),
						input: [{ role: "user", content: `Search the web for: ${query}` }],
						tools: [{ type: "web_search" }],
						store: false,
						stream: true,
					}),
					signal: controller.signal,
				});

				if (!response.ok) {
					const error = await response.text().catch(() => "Unknown error");
					if (response.status === 401) {
						throw new Error("OpenAI authentication failed. Run /login openai-codex to refresh credentials.");
					}
					if (response.status === 429) {
						throw new Error("OpenAI rate limited the search request. Try again later.");
					}
					throw new Error(`OpenAI search API error (${response.status}): ${error}`);
				}

				const rawOutput = collectOutputText(parseSSE(await response.text()));
				if (rawOutput.length === 0) throw new Error("Empty response from OpenAI search API.");

				const parsed = parseSearchResponse(rawOutput);
				const sources = parsed.sources.slice(0, maxSources);
				const summary = parsed.summary.trim();
				if (summary.length === 0) throw new Error("Empty summary in OpenAI search response.");

				const formatted = formatSearchResult(summary, sources);
				const formattedResult = await truncateSearchResult(formatted);

				return {
					content: [{ type: "text", text: formattedResult.text }],
					details: {
						query,
						freshness,
						sourceCount: sources.length,
						sources,
						summary,
						truncated: formattedResult.truncated,
					},
				};
			} finally {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", abort);
			}
		},
	};
}

async function getOpenAICodexAuth(): Promise<SearchWebAuth> {
	const auth = readUsageAuth();
	if (!auth) {
		throw new Error("OpenAI authentication is required. Run /login openai-codex first.");
	}

	const refreshed = await refreshUsageAuthIfNeeded(auth, "openai-codex");
	const accessToken = refreshed["openai-codex"]?.access;
	if (!accessToken) {
		throw new Error("OpenAI authentication is required. Run /login openai-codex first.");
	}

	const accountId = extractOpenAIAccountId(accessToken);
	if (!accountId) {
		throw new Error("Could not determine the OpenAI account ID. Run /login openai-codex to refresh credentials.");
	}

	return { accessToken, accountId };
}

function extractOpenAIAccountId(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;

	try {
		const payloadPart = parts[1];
		if (!payloadPart) return undefined;
		const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as OpenAICodexTokenPayload;
		const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function buildSearchPrompt(query: string, maxSources: number, freshness: "cached" | "live"): string {
	return [
		"You are performing web research for a coding agent.",
		"Search the public web and answer the user's query using current online sources.",
		freshness === "live"
			? "Prioritize the most recent and up-to-date information available."
			: "Cached results are fine; prioritize accuracy over recency.",
		"Return ONLY a JSON object matching this schema:",
		JSON.stringify(SEARCH_OUTPUT_SCHEMA),
		"Do not wrap the JSON in markdown fences or add any extra commentary.",
		`Keep the summary concise and useful. Limit sources to at most ${maxSources} items.`,
		"Prefer primary or official sources when available.",
		"Each source snippet should be short and directly relevant.",
		"",
		`User query: ${query}`,
	].join("\n");
}

function parseSSE(text: string): SSEEvent[] {
	const events: SSEEvent[] = [];
	let eventType = "";
	let dataLines: string[] = [];

	const flush = () => {
		if (dataLines.length > 0) {
			const rawData = dataLines.join("\n");
			if (rawData !== "[DONE]") {
				try {
					const data = JSON.parse(rawData) as Record<string, unknown>;
					const type = eventType || (typeof data.type === "string" ? data.type : "");
					if (type) events.push({ type, data });
				} catch {
					// Ignore malformed SSE data frames.
				}
			}
		}
		eventType = "";
		dataLines = [];
	};

	for (const line of text.split(/\r?\n/)) {
		if (line === "") {
			flush();
		} else if (line.startsWith("event:")) {
			eventType = line.slice(6).trimStart();
		} else if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).trimStart());
		}
	}
	flush();

	return events;
}

function collectOutputText(events: SSEEvent[]): string {
	let output = "";
	for (const event of events) {
		if (event.type !== "response.output_text.delta") continue;
		const delta = event.data.delta;
		if (typeof delta === "string") output += delta;
	}
	if (output.length > 0) return output;

	for (const event of events) {
		if (event.type !== "response.output_text.done") continue;
		const text = event.data.text;
		if (typeof text === "string") return text;
	}
	return "";
}

function parseSearchResponse(rawOutput: string): { summary: string; sources: SearchWebSource[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawOutput);
	} catch (error) {
		throw new Error(
			`Invalid JSON from OpenAI search response: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error("Invalid OpenAI search response: expected an object.");
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.summary !== "string") {
		throw new Error("Invalid OpenAI search response: missing summary.");
	}
	if (!Array.isArray(record.sources)) {
		throw new Error("Invalid OpenAI search response: missing sources.");
	}

	return {
		summary: record.summary,
		sources: record.sources.flatMap((source) => (isSearchSource(source) ? [source] : [])),
	};
}

function isSearchSource(value: unknown): value is SearchWebSource {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.title === "string" && typeof record.url === "string" && typeof record.snippet === "string";
}

function formatSearchResult(summary: string, sources: SearchWebSource[]): string {
	const lines = [summary];
	if (sources.length > 0) {
		lines.push("", "Sources:");
		sources.forEach((source, index) => {
			lines.push(`${index + 1}. ${source.title}`, `   ${source.url}`);
			if (source.snippet.length > 0) lines.push(`   ${source.snippet}`);
		});
	}
	return lines.join("\n");
}

async function truncateSearchResult(output: string): Promise<{ text: string; truncated: boolean }> {
	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return { text: output, truncated: false };

	const tempFile = path.join(os.tmpdir(), `pi-search-web-${randomUUID()}.txt`);
	await writeFile(tempFile, output, "utf8");
	const notice =
		`[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
		`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
		`Full output saved to: ${tempFile}]`;
	return { text: `${truncation.content}\n\n${notice}`, truncated: true };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool(
		createSearchWebTool({
			getAuth: getOpenAICodexAuth,
		}),
	);
}
