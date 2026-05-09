import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ASK_USER_TOOL_NAME = "ask_user";

const AskUserMode = StringEnum(["input", "editor", "select", "confirm"] as const);

const AskUserParams = Type.Object({
	question: Type.String({ description: "The concise question to ask the user." }),
	context: Type.Optional(
		Type.String({
			description: "Optional extra context to show with the question. Keep it short and user-facing.",
		}),
	),
	mode: Type.Optional(
		AskUserMode,
		// TODO: Decide whether this should be required for predictability, or inferred from choices as below.
	),
	choices: Type.Optional(
		Type.Array(Type.String(), {
			description: "Choices to present when mode is select. Keep labels short and unambiguous.",
		}),
	),
});

type AskUserInput = Static<typeof AskUserParams>;
type AskUserModeValue = "input" | "editor" | "select" | "confirm";

type AskUserDetails = {
	question: string;
	context?: string;
	mode: AskUserModeValue;
	choices?: string[];
	answer?: string | boolean;
	cancelled: boolean;
};

function resolveMode(params: AskUserInput): AskUserModeValue {
	if (params.mode) return params.mode;
	if ((params.choices?.length ?? 0) > 0) return "select";
	return "input";
}

function resultText(details: AskUserDetails): string {
	if (details.cancelled) return "The user did not provide an answer.";
	if (details.mode === "confirm") return `User answered: ${details.answer === true ? "yes" : "no"}`;
	return `User answered: ${String(details.answer ?? "")}`;
}

export default function askUserExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: ASK_USER_TOOL_NAME,
		label: "Ask User",
		description: "Ask the user a focused question and return their answer to the agent.",
		promptSnippet: "Ask the user a focused question when progress is blocked by missing information.",
		promptGuidelines: [
			"Use ask_user only when the user's answer is required to continue and cannot be safely inferred.",
			"Before calling ask_user, explain the uncertainty in the question and offer clear choices when possible.",
			"Do not use ask_user for routine confirmations that can be handled by existing tool safety prompts.",
		],
		parameters: AskUserParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const mode = resolveMode(params);
			const detailsBase: Omit<AskUserDetails, "answer" | "cancelled"> = {
				question: params.question,
				...(params.context ? { context: params.context } : {}),
				mode,
				...(params.choices ? { choices: [...params.choices] } : {}),
			};

			if (signal?.aborted) {
				return {
					content: [{ type: "text" as const, text: "The ask_user request was cancelled before prompting the user." }],
					details: { ...detailsBase, cancelled: true },
				};
			}

			if (!ctx.hasUI) {
				// TODO: Add a non-interactive fallback for print/RPC mode, e.g. terminate and surface a follow-up prompt.
				return {
					content: [{ type: "text" as const, text: "Cannot ask the user because no interactive UI is available." }],
					details: { ...detailsBase, cancelled: true },
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: "Waiting for the user to answer..." }],
				details: { ...detailsBase, cancelled: false },
			});

			// TODO: Consider adding timeout and AbortSignal plumbing once ctx.ui dialog cancellation semantics are finalized.
			// TODO: Consider recording unanswered questions in session state if the same prompt is asked repeatedly.
			let answer: string | boolean | undefined;
			if (mode === "confirm") {
				answer = await ctx.ui.confirm(params.question, params.context ?? "");
			} else if (mode === "select") {
				const choices = params.choices ?? [];
				if (choices.length === 0) {
					throw new Error("ask_user mode 'select' requires at least one choice.");
				}
				answer = await ctx.ui.select(params.question, choices);
			} else if (mode === "editor") {
				answer = await ctx.ui.editor(params.question, params.context ?? "");
			} else {
				answer = await ctx.ui.input(params.question, params.context ?? "");
			}

			const details: AskUserDetails = {
				...detailsBase,
				...(answer === undefined ? {} : { answer }),
				cancelled: answer === undefined,
			};

			return {
				content: [{ type: "text", text: resultText(details) }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			const mode = resolveMode(args);
			const text = `${theme.fg("toolTitle", theme.bold(ASK_USER_TOOL_NAME))} ${theme.fg("muted", mode)} ${theme.fg("text", args.question)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const firstContent = result.content[0];
				return new Text(firstContent?.type === "text" ? firstContent.text : "", 0, 0);
			}

			if (details.cancelled) {
				return new Text(theme.fg("warning", "No answer provided"), 0, 0);
			}

			return new Text(`${theme.fg("success", "Answer:")} ${theme.fg("text", String(details.answer ?? ""))}`, 0, 0);
		},
	});
}
