import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getGlobalPiSettingsPath, getProjectPiSettingsPath } from "./internal/common";

export type SemanticDisciplineMode = "off" | "warn" | "block";

type SemanticDisciplineConfig = {
	mode: SemanticDisciplineMode;
	warnLargeReadLines: number;
	warnUnboundedRead: boolean;
	warnBroadBash: boolean;
};

type PiSettingsFile = {
	piEnhanced?: {
		semanticDiscipline?: {
			mode?: unknown;
			warnLargeReadLines?: unknown;
			warnUnboundedRead?: unknown;
			warnBroadBash?: unknown;
		};
	};
};

type Finding = {
	kind: "broad-bash" | "large-read";
	message: string;
	reason: string;
};

const DEFAULT_CONFIG: SemanticDisciplineConfig = {
	mode: "warn",
	warnLargeReadLines: 400,
	warnUnboundedRead: true,
	warnBroadBash: true,
};

const SEMANTIC_DISCIPLINE_GUIDANCE = [
	"Semantic code navigation policy:",
	"- For unfamiliar repositories, call code_overview before using ls, find, tree, or broad directory scans.",
	"- For named code symbols, use lsp_symbols, lsp_definition, lsp_references, lsp_hover, or ast_search before rg/grep.",
	"- For definitions, references, hovers, diagnostics, completions, and renames, use LSP tools instead of textual search.",
	"- Use ast_search/code_rewrite for source-code structure and transformations instead of regex search/replace.",
	"- Use rg/grep only for literal strings, docs, configs, routes, CSS classes, test titles, generated files, unsupported languages, or after semantic tools fail.",
	"- If using bash search, scope it to the smallest path and file glob; avoid repo-wide scans and installed/generated directories.",
	"- Do not read entire large files. Prefer document symbols, hover, definitions, references, diagnostics, or small read slices.",
	"- Good: code_overview -> lsp_symbols/ast_search -> lsp_definition/lsp_references -> read only relevant slices.",
	"- Bad: ls/find/tree for initial repo mapping, repo-wide rg for symbols, or unbounded reads of large source files.",
].join("\n");

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "warning"): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

function readSettingsFile(settingsPath: string): PiSettingsFile {
	if (!existsSync(settingsPath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as PiSettingsFile;
	} catch {
		return {};
	}
}

function applySettings(config: SemanticDisciplineConfig, settings: PiSettingsFile): SemanticDisciplineConfig {
	const semantic = settings.piEnhanced?.semanticDiscipline;
	if (!semantic) return config;

	const next = { ...config };
	if (semantic.mode === "off" || semantic.mode === "warn" || semantic.mode === "block") {
		next.mode = semantic.mode;
	}
	if (typeof semantic.warnLargeReadLines === "number" && Number.isFinite(semantic.warnLargeReadLines)) {
		next.warnLargeReadLines = Math.max(1, Math.floor(semantic.warnLargeReadLines));
	}
	if (typeof semantic.warnUnboundedRead === "boolean") {
		next.warnUnboundedRead = semantic.warnUnboundedRead;
	}
	if (typeof semantic.warnBroadBash === "boolean") {
		next.warnBroadBash = semantic.warnBroadBash;
	}
	return next;
}

function loadConfig(cwd: string): SemanticDisciplineConfig {
	let config = { ...DEFAULT_CONFIG };
	config = applySettings(config, readSettingsFile(getGlobalPiSettingsPath()));
	config = applySettings(config, readSettingsFile(getProjectPiSettingsPath(cwd)));
	return config;
}

function firstCommandWord(command: string): string {
	const trimmed = command.trimStart();
	const match = /^(?:\w+=\S+\s+)*(?:command\s+)?([A-Za-z0-9_.+-]+)/.exec(trimmed);
	return match?.[1] ?? "";
}

function shellWords(command: string): string[] {
	return command
		.replace(/\\\n/g, " ")
		.split(/[\s;&|()]+/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function hasScopedPath(words: readonly string[]): boolean {
	return words.some((word) => {
		if (word === "." || word === "./" || word === "$PWD") return false;
		if (word.startsWith("--")) return false;
		return (
			word.includes("/") ||
			/^\w+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|kt|cs|cpp|c|h|hpp|css|scss|html|yaml|yml|toml)$/i.test(word)
		);
	});
}

function hasFileGlob(words: readonly string[]): boolean {
	return words.some(
		(word, index) => word === "-g" || word === "--glob" || word.startsWith("--glob=") || words[index - 1] === "-g",
	);
}

function inspectBash(command: string): Finding | null {
	const normalized = command.trim();
	const words = shellWords(normalized);
	const first = firstCommandWord(normalized);

	if (/\bls\b[^\n;|&]*\s-[A-Za-z]*R[A-Za-z]*/.test(normalized) || first === "tree") {
		return {
			kind: "broad-bash",
			message: "Broad directory scan detected. Prefer code_overview for initial repository mapping.",
			reason: "Use code_overview before ls -R/tree-style scans.",
		};
	}

	if (first === "find" && (words[1] === "." || words[1] === "./" || words[1] == null)) {
		return {
			kind: "broad-bash",
			message: "Repo-wide find detected. Prefer code_overview or a scoped glob/search tool first.",
			reason: "Use code_overview before broad find scans.",
		};
	}

	if ((first === "rg" || first === "grep") && !hasScopedPath(words) && !hasFileGlob(words)) {
		return {
			kind: "broad-bash",
			message:
				"Broad textual search detected. For code symbols, prefer lsp_symbols, lsp_references, or ast_search; otherwise scope rg/grep to a path/glob.",
			reason: "Use semantic tools for code symbols, or scope textual search.",
		};
	}

	if (/\bgrep\b[^\n;|&]*\s-R\b/.test(normalized) && !hasScopedPath(words)) {
		return {
			kind: "broad-bash",
			message: "Recursive grep detected. Prefer semantic tools for code or scope the search to a path/glob.",
			reason: "Avoid unscoped recursive grep.",
		};
	}

	return null;
}

function inspectRead(path: string, limit: number | undefined, config: SemanticDisciplineConfig): Finding | null {
	if (limit == null) {
		if (!config.warnUnboundedRead) return null;
		return {
			kind: "large-read",
			message: `Unbounded read of ${path}. Prefer symbols/LSP/AST or a small offset+limit slice for large files.`,
			reason: "Use offset/limit or semantic inspection before unbounded reads.",
		};
	}

	if (limit > config.warnLargeReadLines) {
		return {
			kind: "large-read",
			message: `Large read requested (${limit} lines) for ${path}. Prefer smaller slices or semantic inspection first.`,
			reason: `Read limit exceeds semanticDiscipline.warnLargeReadLines (${config.warnLargeReadLines}).`,
		};
	}

	return null;
}

function fingerprint(toolName: string, finding: Finding, detail: string): string {
	return `${toolName}:${finding.kind}:${finding.reason}:${detail.slice(0, 160)}`;
}

export function appendSemanticDisciplineGuidance(systemPrompt: string): string {
	if (systemPrompt.includes(SEMANTIC_DISCIPLINE_GUIDANCE)) {
		return systemPrompt;
	}
	return `${systemPrompt}\n\n${SEMANTIC_DISCIPLINE_GUIDANCE}`;
}

export default function semanticDisciplineExtension(pi: ExtensionAPI) {
	const notified = new Set<string>();

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: appendSemanticDisciplineGuidance(event.systemPrompt),
	}));

	pi.on("tool_call", async (event, ctx) => {
		const config = loadConfig(ctx.cwd);
		if (config.mode === "off") return undefined;

		let finding: Finding | null = null;
		let detail = "";

		if (event.toolName === "bash" && config.warnBroadBash) {
			const command = typeof event.input.command === "string" ? event.input.command : "";
			detail = command;
			finding = inspectBash(command);
		}

		if (event.toolName === "read") {
			const path = typeof event.input.path === "string" ? event.input.path : "<unknown>";
			const limit = typeof event.input.limit === "number" ? event.input.limit : undefined;
			detail = `${path}:${limit ?? "unbounded"}`;
			finding = inspectRead(path, limit, config);
		}

		if (!finding) return undefined;

		const key = fingerprint(event.toolName, finding, detail);
		if (!notified.has(key)) {
			notified.add(key);
			notify(ctx, finding.message, config.mode === "block" ? "error" : "warning");
		}

		if (config.mode === "block") {
			return { block: true, reason: finding.reason };
		}

		return undefined;
	});
}
