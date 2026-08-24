import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readPiEnhancedSettings } from "./internal/common";

export type SemanticDisciplineMode = "off" | "warn" | "block";

type SemanticDisciplineConfig = {
	mode: SemanticDisciplineMode;
	warnLargeReadLines: number;
	warnUnboundedRead: boolean;
	warnBroadBash: boolean;
};

type SemanticDisciplineSettings = {
	mode?: unknown;
	warnLargeReadLines?: unknown;
	warnUnboundedRead?: unknown;
	warnBroadBash?: unknown;
};

type Finding = {
	kind: "broad-bash" | "broad-tool" | "large-read";
	message: string;
	reason: string;
};

const DEFAULT_CONFIG: SemanticDisciplineConfig = {
	mode: "warn",
	warnLargeReadLines: 400,
	warnUnboundedRead: true,
	warnBroadBash: true,
};

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "warning"): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

function applySettings(
	config: SemanticDisciplineConfig,
	semantic: SemanticDisciplineSettings | undefined,
): SemanticDisciplineConfig {
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
	for (const section of readPiEnhancedSettings(cwd)) {
		config = applySettings(config, (section as { semanticDiscipline?: SemanticDisciplineSettings }).semanticDiscipline);
	}
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

function isDefaultPath(path: string | undefined): boolean {
	const normalized = path?.trim();
	return !normalized || normalized === "." || normalized === "./" || normalized === "$PWD" || normalized === "@.";
}

function isBroadGlobPattern(pattern: string): boolean {
	const normalized = pattern.trim();
	return (
		normalized === "*" ||
		normalized === "**" ||
		normalized === "**/*" ||
		normalized === "./**" ||
		normalized === "./**/*"
	);
}

function inspectGlobTool(pattern: string, path: string | undefined): Finding | null {
	if (!isDefaultPath(path) || !isBroadGlobPattern(pattern)) return null;
	return {
		kind: "broad-tool",
		message: "Broad glob scan detected. Prefer code_overview for initial repository mapping or narrow the glob/path.",
		reason: "Use code_overview before broad glob scans, or scope glob with path/pattern.",
	};
}

function inspectGrepTool(path: string | undefined, glob: string | undefined): Finding | null {
	if (!isDefaultPath(path) || typeof glob === "string") return null;
	return {
		kind: "broad-tool",
		message: "Broad grep detected. For code symbols, prefer LSP/AST tools; otherwise scope grep with a path or glob.",
		reason: "Use semantic tools for code symbols, or scope grep with path/glob.",
	};
}

function inspectLsTool(path: string | undefined, recursive: boolean): Finding | null {
	if (!recursive && !isDefaultPath(path)) return null;
	if (!recursive && isDefaultPath(path)) {
		return {
			kind: "broad-tool",
			message: "Top-level workspace ls detected. Prefer code_overview for initial repository mapping.",
			reason: "Use code_overview before broad workspace listing.",
		};
	}
	return {
		kind: "broad-tool",
		message: "Recursive ls detected. Prefer code_overview for repository mapping or scope ls to a smaller path.",
		reason: "Use code_overview before recursive ls scans, or scope ls to a smaller path.",
	};
}

function fingerprint(toolName: string, finding: Finding, detail: string): string {
	return `${toolName}:${finding.kind}:${finding.reason}:${detail.slice(0, 160)}`;
}

export default function semanticDisciplineExtension(pi: ExtensionAPI) {
	const notified = new Set<string>();

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

		if (event.toolName === "glob" && config.warnBroadBash) {
			const input = event.input as Record<string, unknown>;
			const pattern = typeof input.pattern === "string" ? input.pattern : "";
			const path = typeof input.path === "string" ? input.path : undefined;
			detail = `${path ?? "."}:${pattern}`;
			finding = inspectGlobTool(pattern, path);
		}

		if (event.toolName === "grep" && config.warnBroadBash) {
			const input = event.input as Record<string, unknown>;
			const path = typeof input.path === "string" ? input.path : undefined;
			const glob = typeof input.glob === "string" ? input.glob : undefined;
			detail = `${path ?? "."}:${glob ?? "<no-glob>"}`;
			finding = inspectGrepTool(path, glob);
		}

		if (event.toolName === "ls" && config.warnBroadBash) {
			const input = event.input as Record<string, unknown>;
			const path = typeof input.path === "string" ? input.path : undefined;
			const recursive = input.recursive === true;
			detail = `${path ?? "."}:${recursive ? "recursive" : "flat"}`;
			finding = inspectLsTool(path, recursive);
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
