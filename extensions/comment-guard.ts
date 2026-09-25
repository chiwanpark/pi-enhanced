import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readPiEnhancedSettings } from "./internal/common.ts";
import { detectCommentSyntax, findComments, type CommentFinding } from "./internal/comment-analyzer.ts";

const STATE_ENTRY_TYPE = "comment-guard-mode";
const MAX_REPORTED = 5;
const GUIDELINE =
	"Do not add comments to code; `edit` and `write` reject them unless the user explicitly asks for comments.";

export type CommentGuardMode = "off" | "warn" | "block";

type CommentGuardConfig = {
	mode: CommentGuardMode;
	allowDirectives: boolean;
	allowPatterns: RegExp[];
	ignorePaths: string[];
};

type CommentGuardSettings = {
	mode?: unknown;
	allowDirectives?: unknown;
	allowPatterns?: unknown;
	ignorePaths?: unknown;
};

const DEFAULT_CONFIG: CommentGuardConfig = {
	mode: "block",
	allowDirectives: true,
	allowPatterns: [],
	ignorePaths: [],
};

function toStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function toRegExpList(value: unknown): RegExp[] {
	const patterns: RegExp[] = [];
	for (const entry of toStringList(value)) {
		try {
			patterns.push(new RegExp(entry));
		} catch {
			continue;
		}
	}
	return patterns;
}

function applySettings(config: CommentGuardConfig, settings: CommentGuardSettings | undefined): CommentGuardConfig {
	if (!settings) return config;

	const next = { ...config };
	if (settings.mode === "off" || settings.mode === "warn" || settings.mode === "block") next.mode = settings.mode;
	if (typeof settings.allowDirectives === "boolean") next.allowDirectives = settings.allowDirectives;
	if (settings.allowPatterns !== undefined)
		next.allowPatterns = [...next.allowPatterns, ...toRegExpList(settings.allowPatterns)];
	if (settings.ignorePaths !== undefined)
		next.ignorePaths = [...next.ignorePaths, ...toStringList(settings.ignorePaths)];
	return next;
}

function loadConfig(cwd: string): CommentGuardConfig {
	let config = { ...DEFAULT_CONFIG };
	for (const section of readPiEnhancedSettings(cwd)) {
		config = applySettings(config, (section as { commentGuard?: CommentGuardSettings }).commentGuard);
	}
	return config;
}

function isIgnored(absolutePath: string, cwd: string, ignorePaths: readonly string[]): boolean {
	if (ignorePaths.length === 0) return false;
	const relativePath = path.relative(cwd, absolutePath);
	return ignorePaths.some((entry) => {
		const normalized = entry.replace(/^\.\//, "").replace(/\/$/, "");
		if (!normalized) return false;
		return relativePath === normalized || relativePath.startsWith(`${normalized}/`) || absolutePath === entry;
	});
}

function readKnownLines(absolutePath: string): Set<string> {
	try {
		const content = readFileSync(absolutePath, "utf8");
		return new Set(
			content
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== ""),
		);
	} catch {
		return new Set();
	}
}

function parseEdits(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string") return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function chunkOf(edit: object): string[] {
	const { lines, newText } = edit as { lines?: unknown; newText?: unknown };
	if (typeof lines === "string") return lines.split("\n");
	if (Array.isArray(lines)) return lines.filter((line): line is string => typeof line === "string");
	if (typeof newText === "string") return newText.split("\n");
	return [];
}

function editedChunks(input: Record<string, unknown>): string[][] {
	const chunks: string[][] = [];
	for (const edit of parseEdits(input.edits)) {
		if (!edit || typeof edit !== "object") continue;
		const chunk = chunkOf(edit);
		if (chunk.length > 0) chunks.push(chunk);
	}
	if (chunks.length === 0 && typeof input.newText === "string") chunks.push(input.newText.split("\n"));
	return chunks;
}

function formatFindings(findings: readonly CommentFinding[], withLineNumbers: boolean): string {
	const shown = findings.slice(0, MAX_REPORTED).map((finding) => {
		const text = finding.text.length > 100 ? `${finding.text.slice(0, 97)}...` : finding.text;
		return withLineNumbers ? `- line ${finding.line}: ${text}` : `- ${text}`;
	});
	const remaining = findings.length - shown.length;
	if (remaining > 0) shown.push(`- ... and ${remaining} more`);
	return shown.join("\n");
}

function formatWarning(message: string): string {
	return ["", "<comment-guard-warning>", message, "</comment-guard-warning>"].join("\n");
}

export default function commentGuardExtension(pi: ExtensionAPI) {
	const pendingWarnings = new Map<string, string>();

	function isGuardDisabled(ctx: ExtensionContext): boolean {
		let disabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
			const data = entry.data as { allowed?: unknown };
			if (typeof data.allowed === "boolean") disabled = data.allowed;
		}
		return disabled;
	}

	pi.registerCommand("comments", {
		description: "Toggle the comment guard, which blocks comments added by edit and write.",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			let allowed: boolean;
			if (!requested) allowed = !isGuardDisabled(ctx);
			else if (["on", "allow", "enable"].includes(requested)) allowed = true;
			else if (["off", "block", "disable"].includes(requested)) allowed = false;
			else {
				ctx.ui.notify("Usage: /comments [on|off]", "warning");
				return;
			}

			pi.appendEntry(STATE_ENTRY_TYPE, { allowed });
			ctx.ui.notify(
				allowed
					? "Comments are ALLOWED. edit and write may add comments in this session branch."
					: "Comments are BLOCKED. edit and write may not add comments.",
				allowed ? "warning" : "info",
			);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const cwd = event.systemPromptOptions.cwd ?? ctx.cwd;
		if (loadConfig(cwd).mode === "off" || isGuardDisabled(ctx)) return undefined;

		const { promptGuidelines } = event.systemPromptOptions;
		if (!promptGuidelines.includes(GUIDELINE)) promptGuidelines.push(GUIDELINE);
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		const config = loadConfig(ctx.cwd);
		if (config.mode === "off") return undefined;
		if (isGuardDisabled(ctx)) return undefined;

		const input = event.input as Record<string, unknown>;
		const pathArg = input.path ?? input.file_path;
		const rawPath = typeof pathArg === "string" ? pathArg : "";
		if (!rawPath) return undefined;
		const absolutePath = path.resolve(ctx.cwd, rawPath);
		if (isIgnored(absolutePath, ctx.cwd, config.ignorePaths)) return undefined;
		if (!detectCommentSyntax(absolutePath)) return undefined;

		const knownLines = readKnownLines(absolutePath);
		const scanOptions = {
			allowDirectives: config.allowDirectives,
			allowPatterns: config.allowPatterns,
			knownLines,
		};

		let findings: CommentFinding[] = [];
		let withLineNumbers = false;

		if (event.toolName === "write") {
			const content = typeof input.content === "string" ? input.content : "";
			findings = findComments(absolutePath, content.split("\n"), { ...scanOptions, wholeFile: true });
			withLineNumbers = true;
		} else {
			for (const chunk of editedChunks(input)) {
				findings.push(...findComments(absolutePath, chunk, scanOptions));
			}
		}

		if (findings.length === 0) return undefined;

		const summary = `${findings.length} comment${findings.length === 1 ? "" : "s"} in ${rawPath}`;
		const details = formatFindings(findings, withLineNumbers);
		const guidance = "Comments are not allowed unless the user explicitly requests them. Remove them and retry.";

		if (config.mode === "warn") {
			if (ctx.hasUI) ctx.ui.notify(`Comment guard: ${summary}`, "warning");
			pendingWarnings.set(event.toolCallId, `${summary}\n${details}\n${guidance}`);
			return undefined;
		}

		if (ctx.hasUI) ctx.ui.notify(`Comment guard blocked ${event.toolName}: ${summary}`, "error");
		return {
			block: true,
			reason: [
				`${event.toolName} blocked: ${summary}.`,
				details,
				guidance,
				"Run /comments to allow comments for this session branch.",
			].join("\n"),
		};
	});

	pi.on("tool_result", async (event) => {
		const warning = pendingWarnings.get(event.toolCallId);
		if (!warning) return undefined;

		pendingWarnings.delete(event.toolCallId);
		return { content: [...event.content, { type: "text" as const, text: formatWarning(warning) }] };
	});

	pi.on("tool_execution_end", async (event) => {
		pendingWarnings.delete(event.toolCallId);
	});
}
