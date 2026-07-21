import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AVAILABLE_TOOLS_HEADER = "\n\nAvailable tools:\n";
const GUIDELINES_HEADER = "\n\nGuidelines:\n";
const PI_DOCUMENTATION_HEADER_PREFIX = "\n\nPi documentation (";
const CONCISE_IDENTITY =
	"You are a coding assistant operating inside pi. Use the available tools to inspect and modify code.";
const CUSTOM_TOOLS_NOTE =
	"In addition to the tools above, you may have access to other custom tools depending on the project.";

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

export function moveCurrentWorkingDirectoryToEnd(systemPrompt: string, cwd: string): string {
	const currentDirectory = `Current working directory: ${cwd.replace(/\\/g, "/")}`;
	const start = systemPrompt.lastIndexOf(currentDirectory);
	if (start < 0) return systemPrompt;
	if (start > 0 && systemPrompt[start - 1] !== "\n") return systemPrompt;

	const end = start + currentDirectory.length;
	if (end < systemPrompt.length && systemPrompt[end] !== "\n") return systemPrompt;

	const removeStart = start > 0 ? start - 1 : start;
	const withoutCurrentDirectory = `${systemPrompt.slice(0, removeStart)}${systemPrompt.slice(end)}`.trimEnd();
	return withoutCurrentDirectory ? `${withoutCurrentDirectory}\n\n${currentDirectory}` : currentDirectory;
}

export default function systemPromptCleanupExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		let systemPrompt = event.systemPrompt;

		// A custom prompt replaces Pi's default template and therefore has no
		// generated default sections to remove.
		if (!event.systemPromptOptions.customPrompt) {
			systemPrompt = replaceDefaultIdentity(systemPrompt);
			systemPrompt = removeDefaultAvailableToolsBlock(systemPrompt);
			systemPrompt = removeDefaultPiDocumentationBlock(systemPrompt);
		}

		systemPrompt = moveCurrentWorkingDirectoryToEnd(systemPrompt, event.systemPromptOptions.cwd);
		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});
}
