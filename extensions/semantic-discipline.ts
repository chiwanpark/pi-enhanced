import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readPiEnhancedSettings } from "./internal/common";

export type SemanticDisciplineMode = "off" | "warn" | "block";

type SemanticDisciplineConfig = {
	mode: SemanticDisciplineMode;
	warnBroadBash: boolean;
};

type SemanticDisciplineSettings = {
	mode?: unknown;
	warnBroadBash?: unknown;
};

type Finding = {
	kind: "broad-bash";
	message: string;
	reason: string;
};

const DEFAULT_CONFIG: SemanticDisciplineConfig = {
	mode: "warn",
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
			message: "Broad directory scan detected. Scope the listing to a smaller path.",
			reason: "Scope ls -R/tree-style scans to a smaller path.",
		};
	}

	if (first === "find" && (words[1] === "." || words[1] === "./" || words[1] == null)) {
		return {
			kind: "broad-bash",
			message: "Repo-wide find detected. Scope the search to a path or name pattern.",
			reason: "Scope find to a path or name pattern.",
		};
	}

	if ((first === "rg" || first === "grep") && !hasScopedPath(words) && !hasFileGlob(words)) {
		return {
			kind: "broad-bash",
			message: "Broad textual search detected. Scope rg/grep to a path or glob.",
			reason: "Scope textual search to a path or glob.",
		};
	}

	if (/\bgrep\b[^\n;|&]*\s-R\b/.test(normalized) && !hasScopedPath(words)) {
		return {
			kind: "broad-bash",
			message: "Recursive grep detected. Scope the search to a path or glob.",
			reason: "Avoid unscoped recursive grep.",
		};
	}

	return null;
}

function fingerprint(toolName: string, finding: Finding, detail: string): string {
	return `${toolName}:${finding.kind}:${finding.reason}:${detail.slice(0, 160)}`;
}

export default function semanticDisciplineExtension(pi: ExtensionAPI) {
	const notified = new Set<string>();
	const pendingWarnings = new Map<string, string>();

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

		if (!finding) return undefined;

		const key = fingerprint(event.toolName, finding, detail);
		if (!notified.has(key)) {
			notified.add(key);
			notify(ctx, finding.message, config.mode === "block" ? "error" : "warning");
		}

		if (config.mode === "block") {
			return { block: true, reason: finding.reason };
		}

		pendingWarnings.set(event.toolCallId, finding.message);
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		const warning = pendingWarnings.get(event.toolCallId);
		if (!warning) return undefined;

		pendingWarnings.delete(event.toolCallId);
		return {
			content: [...event.content, { type: "text", text: `Semantic discipline warning: ${warning}` }],
		};
	});

	pi.on("tool_execution_end", async (event) => {
		pendingWarnings.delete(event.toolCallId);
	});
}
