import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readPiEnhancedSettings } from "./internal/common";
import { analyzeReadOnlyShellCommand } from "./internal/harmful-command-analyzer";
import { PLAN_MODE_STATE_EVENT } from "./internal/plan-mode-state";

const DEFAULT_BLOCKED_TOOLS = ["edit", "write"];

type PlanModeSettings = {
	blockedTools?: unknown;
};

function loadBlockedTools(cwd: string): Set<string> {
	let blocked = [...DEFAULT_BLOCKED_TOOLS];

	for (const section of readPiEnhancedSettings(cwd)) {
		const tools = (section as { planMode?: PlanModeSettings }).planMode?.blockedTools;
		if (Array.isArray(tools)) {
			blocked = tools.filter((tool): tool is string => typeof tool === "string");
		}
	}

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

	function publishState(active: boolean): void {
		pi.events.emit(PLAN_MODE_STATE_EVENT, { active });
	}

	pi.on("session_start", async (_event, ctx) => publishState(getActiveState(ctx)));
	pi.on("session_tree", async (_event, ctx) => publishState(getActiveState(ctx)));

	pi.registerCommand("plan", {
		description: "Toggle Plan Mode on or off.",
		handler: async (_args, ctx) => {
			const currentState = getActiveState(ctx);
			const nextState = !currentState;
			pi.appendEntry("plan-mode", { active: nextState });
			publishState(nextState);

			const status = nextState ? "ON (read-only, planning)" : "OFF (write enabled)";
			ctx.ui.notify(`Plan Mode is now ${status}.`, "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!getActiveState(ctx)) return undefined;

		const blockedTools = loadBlockedTools(ctx.cwd);
		if (blockedTools.has(event.toolName)) {
			return {
				block: true,
				reason: `Tool \`${event.toolName}\` is blocked in Plan Mode. Analyze the task and write a plan using \`todo_write\`.`,
			};
		}
		if (event.toolName !== "bash") return undefined;

		const command = typeof event.input.command === "string" ? event.input.command : "";
		const result = analyzeReadOnlyShellCommand(command, ctx.cwd);
		return result.blocked
			? {
					block: true,
					reason: `${result.reason ?? "Writable bash command blocked in Plan Mode."} Use read-only inspection commands or run \`/plan\` to exit Plan Mode before implementation.`,
				}
			: undefined;
	});
}
