import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { isPlanModeState, PLAN_MODE_PROMPT_GUIDELINES, PLAN_MODE_STATE_EVENT } from "./internal/plan-mode-state";

const READ_GUIDELINES = [
	"Start with narrow, targeted inspection and reuse prior findings. Avoid broad scans and generated directories unless needed.",
	"For unfamiliar repositories, prefer `code_overview` when available. Prefer LSP/AST tools for code symbols and structure; use scoped text search for literals, docs, configs, routes, styles, tests, or unsupported languages.",
	"Read only relevant file slices with `read`; do not use `cat` or `sed`.",
	"Write terminal-friendly responses: avoid Markdown headings; use **Title Case** section labels, short paragraphs, and flat bullets.",
];

const EDIT_GUIDELINES = [
	"Use `edit` for precise replacements. Each `edits[].oldText` must uniquely match the original file; combine non-overlapping changes to one file in a single call.",
];

const WRITE_GUIDELINES = ["Use `write` only for new files or complete rewrites."];

export default function conciseBuiltinsExtension(pi: ExtensionAPI) {
	let cwd: string | undefined;
	let planModeActive = false;

	function registerReadTool(): void {
		if (!cwd) return;
		pi.registerTool({
			...createReadToolDefinition(cwd),
			promptGuidelines: planModeActive ? [...READ_GUIDELINES, ...PLAN_MODE_PROMPT_GUIDELINES] : READ_GUIDELINES,
		});
	}

	pi.events.on(PLAN_MODE_STATE_EVENT, (value) => {
		if (!isPlanModeState(value)) return;
		planModeActive = value.active;
		registerReadTool();
	});

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		registerReadTool();
		pi.registerTool({
			...createEditToolDefinition(ctx.cwd),
			promptGuidelines: EDIT_GUIDELINES,
		});
		pi.registerTool({
			...createWriteToolDefinition(ctx.cwd),
			promptGuidelines: WRITE_GUIDELINES,
		});
	});
}
