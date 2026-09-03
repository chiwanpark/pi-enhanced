const AVAILABLE_TOOLS_HEADER = "\n\nAvailable tools:\n";
const GUIDELINES_HEADER = "\n\nGuidelines:\n";
const PI_DOCUMENTATION_HEADER_PREFIX = "\n\nPi documentation (";
const PROJECT_CONTEXT_OPEN = "<project_context>";
const PROJECT_CONTEXT_CLOSE = "</project_context>";
const PROJECT_CONTEXT_INTRO = "Project-specific instructions and guidelines:";
const PROJECT_INSTRUCTIONS_OPEN = "<project_instructions ";
const PROJECT_INSTRUCTIONS_CLOSE = "</project_instructions>";
const PROJECT_INSTRUCTION_OPEN = "<project_instruction ";
const PROJECT_INSTRUCTION_CLOSE = "</project_instruction>";
const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";
const CONCISE_IDENTITY =
	"You are a coding assistant operating inside pi. Use the available tools to inspect and modify code.";
const CUSTOM_TOOLS_NOTE =
	"In addition to the tools above, you may have access to other custom tools depending on the project.";

export const HOUSE_GUIDELINES = [
	"Start with narrow, targeted inspection and reuse prior findings. Avoid broad scans and generated directories unless needed.",
	"Read files in bounded slices (for example `sed -n '1,120p' file`) instead of whole-file dumps, and scope `rg` and `find` with a path or glob.",
	"After editing a file, re-read the changed region to confirm the edit landed as intended.",
	"Write terminal-friendly responses: avoid Markdown headings; use **Title Case** section labels, short paragraphs, and flat bullets.",
];

export function removeDefaultAvailableToolsBlock(systemPrompt: string): string {
	const start = systemPrompt.indexOf(AVAILABLE_TOOLS_HEADER);
	if (start < 0) return systemPrompt;

	const end = systemPrompt.indexOf(GUIDELINES_HEADER, start + AVAILABLE_TOOLS_HEADER.length);
	if (end < 0) return systemPrompt;

	const block = systemPrompt.slice(start + AVAILABLE_TOOLS_HEADER.length, end);
	if (!block.includes(CUSTOM_TOOLS_NOTE)) return systemPrompt;

	return systemPrompt.slice(0, start) + systemPrompt.slice(end);
}

export function replaceDefaultIdentity(systemPrompt: string): string {
	const defaultIntroductionEnd = systemPrompt.indexOf(AVAILABLE_TOOLS_HEADER);
	if (defaultIntroductionEnd < 0) return systemPrompt;
	return CONCISE_IDENTITY + systemPrompt.slice(defaultIntroductionEnd);
}

export function removeDefaultPiDocumentationBlock(systemPrompt: string): string {
	const start = systemPrompt.indexOf(PI_DOCUMENTATION_HEADER_PREFIX);
	if (start < 0) return systemPrompt;

	const headerEnd = systemPrompt.indexOf("\n", start + PI_DOCUMENTATION_HEADER_PREFIX.length);
	if (headerEnd < 0) return systemPrompt;

	let lineStart = headerEnd + 1;
	if (!systemPrompt.startsWith("- ", lineStart)) return systemPrompt;

	let end = headerEnd;
	while (systemPrompt.startsWith("- ", lineStart)) {
		const lineEnd = systemPrompt.indexOf("\n", lineStart);
		if (lineEnd < 0) {
			end = systemPrompt.length;
			break;
		}
		end = lineEnd;
		lineStart = lineEnd + 1;
	}

	return systemPrompt.slice(0, start) + systemPrompt.slice(end);
}

export function insertGuidelines(systemPrompt: string, guidelines: readonly string[]): string {
	const start = systemPrompt.indexOf(GUIDELINES_HEADER);
	if (start < 0) return systemPrompt;

	const insertAt = start + GUIDELINES_HEADER.length;
	const bullets = guidelines
		.filter((guideline) => !systemPrompt.includes(`- ${guideline}`))
		.map((guideline) => `- ${guideline}\n`)
		.join("");
	return bullets ? systemPrompt.slice(0, insertAt) + bullets + systemPrompt.slice(insertAt) : systemPrompt;
}

export function removeProjectContextIntroduction(systemPrompt: string): string {
	const open = systemPrompt.indexOf(PROJECT_CONTEXT_OPEN);
	if (open < 0) return systemPrompt;

	const start = systemPrompt.indexOf(PROJECT_CONTEXT_INTRO, open + PROJECT_CONTEXT_OPEN.length);
	if (start < 1 || systemPrompt[start - 1] !== "\n") return systemPrompt;

	const close = systemPrompt.indexOf(PROJECT_CONTEXT_CLOSE, open);
	if (close >= 0 && start > close) return systemPrompt;

	let end = start + PROJECT_CONTEXT_INTRO.length;
	while (systemPrompt[end] === "\n") end += 1;

	return systemPrompt.slice(0, start) + systemPrompt.slice(end);
}

export function renameProjectInstructionElements(systemPrompt: string): string {
	return systemPrompt
		.split(PROJECT_INSTRUCTIONS_OPEN)
		.join(PROJECT_INSTRUCTION_OPEN)
		.split(PROJECT_INSTRUCTIONS_CLOSE)
		.join(PROJECT_INSTRUCTION_CLOSE);
}

export function wrapProjectInstructionsInCdata(systemPrompt: string): string {
	let result = "";
	let cursor = 0;

	for (;;) {
		const open = systemPrompt.indexOf(PROJECT_INSTRUCTION_OPEN, cursor);
		if (open < 0) break;

		const openEnd = systemPrompt.indexOf(">", open);
		if (openEnd < 0) break;

		const close = systemPrompt.indexOf(PROJECT_INSTRUCTION_CLOSE, openEnd);
		if (close < 0) break;

		const content = systemPrompt.slice(openEnd + 1, close);
		const escaped = content.trim().split(CDATA_CLOSE).join("]]]]><![CDATA[>");
		const wrapped = content.trimStart().startsWith(CDATA_OPEN)
			? content
			: `\n${CDATA_OPEN}\n\n${escaped}\n\n${CDATA_CLOSE}\n`;

		result += systemPrompt.slice(cursor, openEnd + 1) + wrapped;
		cursor = close;
	}

	return result + systemPrompt.slice(cursor);
}

function removeCurrentDirectoryLine(systemPrompt: string, cwd: string): string {
	const line = `Current working directory: ${cwd}`;
	const start = systemPrompt.lastIndexOf(line);
	if (start < 0) return systemPrompt;
	if (start > 0 && systemPrompt[start - 1] !== "\n") return systemPrompt;

	const end = start + line.length;
	if (end < systemPrompt.length && systemPrompt[end] !== "\n") return systemPrompt;

	const removeStart = start > 0 ? start - 1 : start;
	return `${systemPrompt.slice(0, removeStart)}${systemPrompt.slice(end)}`.trimEnd();
}

export function moveCurrentDirectoryToProjectContext(systemPrompt: string, cwd: string): string {
	const normalizedCwd = cwd.replace(/\\/g, "/");
	const element = `<current_directory>${normalizedCwd}</current_directory>`;
	const withoutLine = removeCurrentDirectoryLine(systemPrompt, normalizedCwd);
	if (withoutLine.includes(element)) return withoutLine;

	const close = withoutLine.lastIndexOf(PROJECT_CONTEXT_CLOSE);
	if (close < 0) return `${withoutLine.trimEnd()}\n\n<project_context>\n\n${element}\n\n${PROJECT_CONTEXT_CLOSE}`;

	return `${withoutLine.slice(0, close)}${element}\n\n${withoutLine.slice(close)}`;
}

export function cleanSystemPrompt(systemPrompt: string, cwd: string, hasCustomPrompt = false): string {
	let cleaned = systemPrompt;

	// A custom prompt replaces Pi's default template and therefore has no
	// generated default sections to remove.
	if (!hasCustomPrompt) {
		cleaned = replaceDefaultIdentity(cleaned);
		cleaned = removeDefaultAvailableToolsBlock(cleaned);
		cleaned = removeDefaultPiDocumentationBlock(cleaned);
	}

	cleaned = insertGuidelines(cleaned, HOUSE_GUIDELINES);
	cleaned = removeProjectContextIntroduction(cleaned);
	cleaned = renameProjectInstructionElements(cleaned);
	cleaned = wrapProjectInstructionsInCdata(cleaned);
	return moveCurrentDirectoryToProjectContext(cleaned, cwd);
}
