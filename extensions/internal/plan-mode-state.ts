export const PLAN_MODE_STATE_EVENT = "pi-enhanced:plan-mode-state";

export type PlanModeState = {
	active: boolean;
};

export const PLAN_MODE_PROMPT_GUIDELINES = [
	"Plan Mode is active: explore the project, understand the requirements, and formulate a detailed step-by-step plan.",
	"In Plan Mode, do not use `edit` or `write`, or run system-modifying `bash` commands.",
	"In Plan Mode, use `read`, search, and LSP tools to gather context.",
	"Finish the plan with `write_todos`, then ask the user in plain text to review it and run `/plan` to exit Plan Mode before implementation.",
];

export function isPlanModeState(value: unknown): value is PlanModeState {
	return typeof value === "object" && value !== null && typeof (value as { active?: unknown }).active === "boolean";
}
