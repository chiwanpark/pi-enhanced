import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getGlobalPiSettingsPath, getProjectPiSettingsPath } from "./internal/common";

const PLAN_MODE_GUIDELINES = [
	"Plan Mode Guidelines:",
	"- The user is currently in Plan Mode.",
	"- Your objective is to explore the project, understand the requirements, and formulate a detailed step-by-step plan.",
	"- Do NOT write or edit code, and do NOT execute system-modifying bash commands.",
	"- Use code reading, searching, and LSP tools to gather context.",
	"- Once the plan is ready, register the final step-by-step TODOs using the `write_todos` tool.",
	"- After writing the TODOs, explicitly ask the user to review and confirm the plan.",
].join("\n");

const DEFAULT_BLOCKED_TOOLS = ["bash", "edit", "write"];

type PiSettingsFile = {
	piEnhanced?: {
		planMode?: {
			blockedTools?: unknown;
		};
	};
};

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

function loadBlockedTools(cwd: string): Set<string> {
	let blocked = [...DEFAULT_BLOCKED_TOOLS];

	const apply = (settings: PiSettingsFile) => {
		const tools = settings.piEnhanced?.planMode?.blockedTools;
		if (Array.isArray(tools)) {
			blocked = tools.filter((t) => typeof t === "string");
		}
	};

	apply(readSettingsFile(getGlobalPiSettingsPath()));
	apply(readSettingsFile(getProjectPiSettingsPath(cwd)));

	return new Set(blocked);
}

export default function planModeExtension(pi: ExtensionAPI) {
	pi.registerFlag("plan", {
		description: "Start the session in Plan Mode (read-only, generates a TODO plan).",
		type: "boolean",
		default: false,
	});

	function getActiveState(ctx: ExtensionContext): boolean {
		let active = pi.getFlag("plan") as boolean;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "plan-mode") {
				active = (entry.data as { active: boolean }).active;
			}
		}
		return active;
	}

	pi.registerCommand("plan", {
		description: "Toggle Plan Mode on or off.",
		handler: async (_args, ctx) => {
			const currentState = getActiveState(ctx);
			const nextState = !currentState;
			pi.appendEntry("plan-mode", { active: nextState });

			const status = nextState ? "ON (read-only, planning)" : "OFF (write enabled)";
			ctx.ui.notify(`Plan Mode is now ${status}.`, "info");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (getActiveState(ctx)) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_GUIDELINES}`,
			};
		}
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const blockedTools = loadBlockedTools(ctx.cwd);
		if (getActiveState(ctx) && blockedTools.has(event.toolName)) {
			return {
				block: true,
				reason: `Tool '${event.toolName}' is blocked in Plan Mode. Your objective is to analyze and write a plan using 'write_todos'.`,
			};
		}
		return undefined;
	});
}
