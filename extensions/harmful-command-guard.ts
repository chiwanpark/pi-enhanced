import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HarmfulCommandAnalyzer, type CommandSafetyResult } from "./internal/harmful-command-analyzer";

const STATE_ENTRY_TYPE = "harmful-mode";

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
		description: "Toggle harmful mode, which bypasses command and file-operation safety checks.",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			let active: boolean;
			if (!requested) active = !isHarmfulModeActive(ctx);
			else if (["on", "allow", "enable"].includes(requested)) active = true;
			else if (["off", "block", "disable"].includes(requested)) active = false;
			else {
				ctx.ui.notify("Usage: /harmful [on|off]", "warning");
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
		const analyzer = new HarmfulCommandAnalyzer(ctx.cwd);
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
