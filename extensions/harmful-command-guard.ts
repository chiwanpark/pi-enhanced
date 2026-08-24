import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readPiEnhancedSettings, withHomeTilde } from "./internal/common";
import {
	HarmfulCommandAnalyzer,
	type CommandSafetyResult,
	type HarmfulCommandAnalyzerOptions,
} from "./internal/harmful-command-analyzer";

const STATE_ENTRY_TYPE = "harmful-mode";

type HarmfulCommandGuardSettings = {
	allowPaths?: unknown;
	denyPaths?: unknown;
};

function toPathList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

/**
 * Collect `piEnhanced.harmfulCommandGuard.allowPaths` and `.denyPaths`. Global and project settings
 * are unioned, so a project can extend but never drop a global entry.
 */
function loadPathOptions(cwd: string): Required<HarmfulCommandAnalyzerOptions> {
	const allowPaths: string[] = [];
	const denyPaths: string[] = [];
	for (const section of readPiEnhancedSettings(cwd)) {
		const guard = (section as { harmfulCommandGuard?: HarmfulCommandGuardSettings }).harmfulCommandGuard;
		if (!guard) continue;
		allowPaths.push(...toPathList(guard.allowPaths));
		denyPaths.push(...toPathList(guard.denyPaths));
	}
	return { allowPaths: [...new Set(allowPaths)], denyPaths: [...new Set(denyPaths)] };
}

function formatPathList(paths: readonly string[]): string {
	return paths.length === 0 ? "none" : paths.map((entry) => withHomeTilde(entry)).join(", ");
}

export default function harmfulCommandGuardExtension(pi: ExtensionAPI) {
	function isHarmfulModeActive(ctx: ExtensionContext): boolean {
		let active = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
			const data = entry.data as { active?: unknown };
			if (typeof data.active === "boolean") active = data.active;
		}
		return active;
	}

	pi.registerCommand("harmful", {
		description:
			"Toggle harmful mode, which bypasses command and file-operation safety checks. Use /harmful paths to list configured path exceptions.",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			let active: boolean;
			if (requested === "paths") {
				const { allowPaths, denyPaths } = loadPathOptions(ctx.cwd);
				ctx.ui.notify(
					`Allowed paths: ${formatPathList(allowPaths)}\nDenied paths: ${formatPathList(denyPaths)}`,
					"info",
				);
				return;
			}
			if (!requested) active = !isHarmfulModeActive(ctx);
			else if (["on", "allow", "enable"].includes(requested)) active = true;
			else if (["off", "block", "disable"].includes(requested)) active = false;
			else {
				ctx.ui.notify("Usage: /harmful [on|off|paths]", "warning");
				return;
			}

			pi.appendEntry(STATE_ENTRY_TYPE, { active });
			ctx.ui.notify(
				active
					? "Harmful mode is ON. Command and file-operation safety checks are disabled."
					: "Harmful mode is OFF. Command and file-operation safety checks are enabled.",
				active ? "warning" : "info",
			);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isHarmfulModeActive(ctx)) return undefined;
		const analyzer = new HarmfulCommandAnalyzer(ctx.cwd, loadPathOptions(ctx.cwd));
		let result: CommandSafetyResult;
		let subject: string;

		if (event.toolName === "bash") {
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (!command) return undefined;
			result = analyzer.analyze(command);
			subject = "Command";
		} else if (event.toolName === "write" || event.toolName === "edit") {
			const inputPath = typeof event.input.path === "string" ? event.input.path : "";
			if (!inputPath) return undefined;
			result = analyzer.validatePath(inputPath);
			subject = "File operation";
		} else {
			return undefined;
		}

		if (!result.blocked) return undefined;
		const reason = result.reason ?? "The operation was identified as harmful.";
		if (ctx.hasUI) ctx.ui.notify(`${subject} blocked: ${reason}`, "error");
		return {
			block: true,
			reason: `${subject} blocked: ${reason}\nWorking directory: ${ctx.cwd}\nRun /harmful to bypass this guard.`,
		};
	});
}
