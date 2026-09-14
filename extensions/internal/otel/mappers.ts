import type { Usage } from "@earendil-works/pi-ai";

export type TokenType = "input" | "output" | "cacheRead" | "cacheCreation";
export type SessionStartType = "fresh" | "resume" | "continue";
export type CodeEditToolName = "Edit" | "Write" | "NotebookEdit";

export const TRUNCATION_MARKER_PREFIX = "[TRUNCATED";

const EXTENSION_LANGUAGES: Record<string, string> = {
	ts: "TypeScript",
	tsx: "TypeScript",
	mts: "TypeScript",
	cts: "TypeScript",
	js: "JavaScript",
	jsx: "JavaScript",
	mjs: "JavaScript",
	cjs: "JavaScript",
	py: "Python",
	pyi: "Python",
	rb: "Ruby",
	rs: "Rust",
	go: "Go",
	java: "Java",
	kt: "Kotlin",
	kts: "Kotlin",
	swift: "Swift",
	c: "C",
	h: "C",
	cpp: "C++",
	cc: "C++",
	cxx: "C++",
	hpp: "C++",
	cs: "C#",
	php: "PHP",
	scala: "Scala",
	sc: "Scala",
	sh: "Shell",
	bash: "Shell",
	zsh: "Shell",
	fish: "Shell",
	ps1: "PowerShell",
	sql: "SQL",
	html: "HTML",
	htm: "HTML",
	css: "CSS",
	scss: "SCSS",
	sass: "Sass",
	less: "Less",
	json: "JSON",
	jsonc: "JSON",
	yaml: "YAML",
	yml: "YAML",
	toml: "TOML",
	ini: "INI",
	xml: "XML",
	md: "Markdown",
	markdown: "Markdown",
	mdx: "MDX",
	rst: "reStructuredText",
	txt: "Text",
	lua: "Lua",
	dart: "Dart",
	ex: "Elixir",
	exs: "Elixir",
	erl: "Erlang",
	hs: "Haskell",
	clj: "Clojure",
	r: "R",
	pl: "Perl",
	vim: "Vim script",
	dockerfile: "Dockerfile",
	tf: "Terraform",
	proto: "Protocol Buffers",
	gradle: "Gradle",
	groovy: "Groovy",
	nix: "Nix",
	zig: "Zig",
};

const FILENAME_LANGUAGES: Record<string, string> = {
	dockerfile: "Dockerfile",
	makefile: "Makefile",
	"cmakelists.txt": "CMake",
	".gitignore": "Ignore List",
	".env": "Properties",
};

export function languageFromPath(filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	const base = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	const byName = FILENAME_LANGUAGES[base];
	if (byName) return byName;
	const dot = base.lastIndexOf(".");
	if (dot <= 0 || dot === base.length - 1) return undefined;
	return EXTENSION_LANGUAGES[base.slice(dot + 1)];
}

export const ANTHROPIC_PROVIDER = "anthropic";

/**
 * Whether a request went to the first-party Anthropic API. Claude served through a gateway or
 * reseller (`openrouter`, `amazon-bedrock`, `github-copilot`, AI gateways) is deliberately excluded:
 * that traffic is not the Claude Code usage the borrowed endpoint and credential are meant to cover.
 */
export function isAnthropicProvider(provider: string | undefined): boolean {
	return provider === ANTHROPIC_PROVIDER;
}

/**
 * Map pi's `session_start` reason onto Claude Code's `start_type` attribute. Returns undefined for
 * `reload`, which re-binds extensions inside an existing session rather than starting a new one.
 */
export function sessionStartType(reason: string, hasExistingEntries = false): SessionStartType | undefined {
	switch (reason) {
		case "reload":
			return undefined;
		case "resume":
			return "resume";
		case "fork":
			return "continue";
		case "new":
			return "fresh";
		default:
			// Startup on a session file that already holds entries is a continuation, not a fresh start.
			return hasExistingEntries ? "continue" : "fresh";
	}
}

/**
 * Claude Code's token counter records all four types for every response, including empty buckets;
 * pi reports cache writes as `cacheWrite`.
 */
export function tokenUsageEntries(usage: Usage | undefined): { type: TokenType; tokens: number }[] {
	if (!usage) return [];
	const count = (value: number | undefined) =>
		Number.isFinite(value) && (value as number) > 0 ? (value as number) : 0;
	return [
		{ type: "input", tokens: count(usage.input) },
		{ type: "output", tokens: count(usage.output) },
		{ type: "cacheRead", tokens: count(usage.cacheRead) },
		{ type: "cacheCreation", tokens: count(usage.cacheWrite) },
	];
}

export function costUsdMicros(costUsd: number): number {
	if (!Number.isFinite(costUsd)) return 0;
	return Math.round(costUsd * 1_000_000);
}

/** Count added and removed lines in a unified diff, ignoring the `+++`/`---` file headers. */
export function diffLineCounts(patch: string | undefined): { added: number; removed: number } {
	if (!patch) return { added: 0, removed: 0 };
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added += 1;
		else if (line.startsWith("-")) removed += 1;
	}
	return { added, removed };
}

function gitSubcommandPattern(subcommand: string): RegExp {
	return new RegExp(String.raw`\bgit(?:\s+-[cC]\s+\S+|\s+--[^\s=]+=\S+)*\s+${subcommand}\b`);
}

const GIT_COMMIT_PATTERN = gitSubcommandPattern("commit");
const PULL_REQUEST_CREATE_PATTERNS = [/\bgh\s+pr\s+create\b/, /\bglab\s+mr\s+create\b/];

/**
 * Whether a bash command runs `git commit`. Claude Code counts one commit per successful command
 * that matches, without checking `HEAD`, so this is the same heuristic.
 */
export function commandCreatesCommit(command: string | undefined): boolean {
	return command !== undefined && GIT_COMMIT_PATTERN.test(command);
}

/**
 * Pull requests Claude Code counts for a successful bash command: one for `gh pr create` and one
 * for `glab mr create`, purely from the command text.
 */
export function pullRequestsCreated(command: string | undefined): number {
	if (!command) return 0;
	return PULL_REQUEST_CREATE_PATTERNS.filter((pattern) => pattern.test(command)).length;
}

/** pi tool names for the code editing tools tracked by `claude_code.code_edit_tool.decision`. */
export function codeEditToolName(toolName: string): CodeEditToolName | undefined {
	switch (toolName) {
		case "edit":
		case "Edit":
			return "Edit";
		case "write":
		case "Write":
			return "Write";
		case "notebook_edit":
		case "NotebookEdit":
			return "NotebookEdit";
		default:
			return undefined;
	}
}

/** Derive a stable, low-cardinality error category from a failed tool result. */
export function toolErrorType(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const errno = /\b(E[A-Z]{3,})\b/.exec(text);
	if (errno?.[1]) return `Error:${errno[1]}`;
	const named = /\b([A-Z][A-Za-z]*(?:Error|Exception))\b/.exec(text);
	if (named?.[1]) return named[1];
	return "Error";
}

/** Truncate content-bearing attributes the way `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` does. */
export function truncateContent(value: string, maxLength: number): string {
	if (maxLength <= 0) return "";
	if (value.length <= maxLength) return value;
	const removed = value.length - maxLength;
	const marker = `${TRUNCATION_MARKER_PREFIX} ${removed} chars]`;
	if (marker.length >= maxLength) return marker.slice(0, maxLength);
	return `${value.slice(0, maxLength - marker.length)}${marker}`;
}

export function byteLength(value: string | undefined): number {
	if (!value) return 0;
	return Buffer.byteLength(value, "utf8");
}

/** Serialize tool input for `tool_input`, bounding per-value and total size like Claude Code does. */
export function serializeToolInput(input: unknown, valueLimit = 512, totalLimit = 4096): string | undefined {
	if (input === undefined || input === null) return undefined;
	try {
		const shortened = shortenValues(input, valueLimit);
		const json = JSON.stringify(shortened);
		if (json === undefined) return undefined;
		return json.length > totalLimit ? `${json.slice(0, totalLimit)}…` : json;
	} catch {
		return undefined;
	}
}

function shortenValues(value: unknown, valueLimit: number): unknown {
	if (typeof value === "string") {
		return value.length > valueLimit ? `${value.slice(0, valueLimit)}…` : value;
	}
	if (Array.isArray(value)) return value.map((entry) => shortenValues(entry, valueLimit));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, shortenValues(entry, valueLimit)]),
		);
	}
	return value;
}

/** Tool-specific parameters exposed on `tool_result` when tool detail logging is enabled. */
export function toolParameters(toolName: string, input: unknown): Record<string, unknown> | undefined {
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;

	if (toolName === "bash" || toolName === "powershell") {
		const command = typeof record["command"] === "string" ? record["command"] : undefined;
		return {
			bash_command: command?.split(/\s+/)[0],
			full_command: command,
			timeout: record["timeout"],
			...(commandCreatesCommit(command) ? { git_commit: true } : {}),
		};
	}
	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		return { file_path: record["path"] };
	}
	if (toolName === "task" || toolName === "subagent") {
		return { subagent_type: record["type"] ?? record["agent"] };
	}
	return undefined;
}

export function filePathFromToolInput(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath", "file"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}
