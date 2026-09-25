import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

type Sections = Record<string, string | null>;

export interface ContextFile {
	path: string;
	content: string;
}

const RULES_SECTION = "rules";
const PROJECT_SECTION = "project_context";
const USER_SECTION = "user_instructions";
const REMOVED_SECTIONS: readonly string[] = ["tools", "docs"];

const PI_PROJECT_OPEN = "<project_context>\nProject-specific instructions and guidelines:\n\n";
const PI_PROJECT_CLOSE = "\n</project_context>";
const PI_FILE_OPEN = '<project_instructions path="';
const PI_FILE_OPEN_END = '">\n';
const PI_FILE_CLOSE = "\n</project_instructions>";

const GUIDELINE_REWRITES: readonly { readonly match: RegExp; readonly replace: string }[] = [
	{
		match: /^Use bash for file operations like ls, rg, find\.?$/,
		replace: "Use `bash` for file operations like `ls`, `rg`, `find`.",
	},
	{
		match: /^Use read to examine files instead of cat or sed\.?$/,
		replace: "Use `read` to examine files instead of `cat` or `sed`.",
	},
	{
		match: /^Use write only for new files or complete rewrites\.?$/,
		replace: "Use `write` only for new files or complete rewrites.",
	},
	{
		match: /^(You can inspect|Inspect) PI_\* environment variables for current model and session details\.?$/,
		replace: "$1 `PI_*` environment variables for current model and session details.",
	},
	{ match: /^Be concise in your responses$/, replace: "Be concise in your responses." },
	{
		match: /^Show file paths clearly when working with files$/,
		replace: "Show file paths clearly when working with files.",
	},
];

export function rewriteGuideline(guideline: string): string {
	for (const rule of GUIDELINE_REWRITES) {
		if (rule.match.test(guideline)) return guideline.replace(rule.match, rule.replace);
	}
	return guideline;
}

export function polishRules(rules: string): string {
	return rules
		.split("\n")
		.map((line) => (line.startsWith("- ") ? `- ${rewriteGuideline(line.slice(2))}` : line))
		.join("\n");
}

export function parsePiProjectContext(section: string): ContextFile[] | undefined {
	if (!section.startsWith(PI_PROJECT_OPEN) || !section.endsWith(PI_PROJECT_CLOSE)) return undefined;
	const body = section.slice(PI_PROJECT_OPEN.length, section.length - PI_PROJECT_CLOSE.length);

	const files: ContextFile[] = [];
	let cursor = 0;
	while (cursor < body.length) {
		if (!body.startsWith(PI_FILE_OPEN, cursor)) return undefined;
		const pathStart = cursor + PI_FILE_OPEN.length;
		const pathEnd = body.indexOf(PI_FILE_OPEN_END, pathStart);
		if (pathEnd < 0) return undefined;

		const contentStart = pathEnd + PI_FILE_OPEN_END.length;
		let close = body.indexOf(PI_FILE_CLOSE, contentStart);
		for (;;) {
			if (close < 0) return undefined;
			const next = close + PI_FILE_CLOSE.length;
			if (next === body.length || body.startsWith(`\n\n${PI_FILE_OPEN}`, next)) break;
			close = body.indexOf(PI_FILE_CLOSE, close + 1);
		}

		files.push({ path: body.slice(pathStart, pathEnd), content: body.slice(contentStart, close) });
		cursor = close + PI_FILE_CLOSE.length;
		if (cursor < body.length) cursor += 2;
	}
	return files.length > 0 ? files : undefined;
}

function renderInstructions(tag: string, file: ContextFile): string {
	return `<${tag} path="${file.path}">\n${file.content.trim()}\n</${tag}>`;
}

function renderUserInstructions(files: readonly ContextFile[]): string {
	if (files.length === 1) return renderInstructions(USER_SECTION, files[0]!);
	const body = files.map((file) => renderInstructions("instructions", file)).join("\n\n");
	return `<${USER_SECTION}>\n${body}\n</${USER_SECTION}>`;
}

function precedenceNote(hasUserFiles: boolean, projectFileCount: number): string | undefined {
	const deeper = projectFileCount > 1;
	if (hasUserFiles && deeper) {
		return `These files override <${USER_SECTION}> on conflict; files in deeper directories take precedence.`;
	}
	if (hasUserFiles) return `These files override <${USER_SECTION}> on conflict.`;
	if (deeper) return "Files in deeper directories take precedence on conflict.";
	return undefined;
}

function renderProjectContext(files: readonly ContextFile[], hasUserFiles: boolean): string {
	const note = precedenceNote(hasUserFiles, files.length);
	const body = [...(note ? [note] : []), ...files.map((file) => renderInstructions("instructions", file))].join("\n\n");
	return `<${PROJECT_SECTION}>\n${body}\n</${PROJECT_SECTION}>`;
}

export interface ContextSections {
	user: string | undefined;
	project: string | undefined;
}

export function renderContextSections(files: readonly ContextFile[], agentDir: string): ContextSections {
	const resolvedAgentDir = path.resolve(agentDir);
	const userFiles = files.filter((file) => path.dirname(path.resolve(file.path)) === resolvedAgentDir);
	const projectFiles = files.filter((file) => !userFiles.includes(file));
	return {
		user: userFiles.length > 0 ? renderUserInstructions(userFiles) : undefined,
		project: projectFiles.length > 0 ? renderProjectContext(projectFiles, userFiles.length > 0) : undefined,
	};
}

interface ContextState {
	user: boolean;
	project: boolean;
}

function splitProjectContext(value: string | null, agentDir: string, state: ContextState): Sections | undefined {
	if (value === null) {
		const removed: Sections = {};
		if (state.user) removed[USER_SECTION] = null;
		if (state.project) removed[PROJECT_SECTION] = null;
		state.user = false;
		state.project = false;
		return removed;
	}

	const files = parsePiProjectContext(value);
	if (!files) return undefined;

	const rendered = renderContextSections(files, agentDir);
	const result: Sections = {};
	for (const [key, name, text] of [
		["user", USER_SECTION, rendered.user],
		["project", PROJECT_SECTION, rendered.project],
	] as const) {
		if (text !== undefined) {
			result[name] = text;
			state[key] = true;
		} else if (state[key]) {
			result[name] = null;
			state[key] = false;
		}
	}
	return result;
}

function refineSections(sections: Sections, agentDir: string, state: ContextState): Sections | undefined {
	let changed = false;
	const refined: Sections = {};
	for (const [name, value] of Object.entries(sections)) {
		if (REMOVED_SECTIONS.includes(name)) {
			changed = true;
			continue;
		}
		if (name === RULES_SECTION && typeof value === "string") {
			const polished = polishRules(value);
			if (polished !== value) changed = true;
			refined[name] = polished;
			continue;
		}
		if (name === PROJECT_SECTION) {
			const split = splitProjectContext(value, agentDir, state);
			if (split) {
				changed = true;
				Object.assign(refined, split);
				continue;
			}
			state.project = value !== null;
		}
		if (name === USER_SECTION) state.user = value !== null;
		refined[name] = value;
	}
	return changed ? refined : undefined;
}

function isEmptySystemMessage(message: AgentMessage): boolean {
	if (message.role !== "system") return false;
	const content =
		typeof message.content === "string" ? message.content : message.content.map((part) => part.text).join("");
	return (
		content.length === 0 &&
		Object.keys(message.sections ?? {}).length === 0 &&
		!message.toolsAdded?.length &&
		!message.toolsRemoved?.length
	);
}

export function refineSystemMessages(messages: AgentMessage[], agentDir: string): AgentMessage[] | undefined {
	const state: ContextState = { user: false, project: false };
	let changed = false;
	const result: AgentMessage[] = [];
	for (const [index, message] of messages.entries()) {
		if (message.role !== "system" || !message.sections) {
			result.push(message);
			continue;
		}

		const sections = refineSections(message.sections, agentDir, state);
		if (!sections) {
			result.push(message);
			continue;
		}

		changed = true;
		const refined = { ...message, sections };
		if (index === 0 || !isEmptySystemMessage(refined)) result.push(refined);
	}
	return changed ? result : undefined;
}

function sectionPattern(name: string): RegExp {
	return new RegExp(`(^|\\n\\n)(<${name}>\\n[\\s\\S]*?\\n</${name}>)(?=\\n\\n|$)`);
}

function refineRenderedProjectContext(prompt: string, agentDir: string): string {
	const start = prompt.indexOf(`\n\n${PI_PROJECT_OPEN}`);
	if (start < 0) return prompt;
	const close = prompt.lastIndexOf(PI_PROJECT_CLOSE);
	if (close < start) return prompt;

	const end = close + PI_PROJECT_CLOSE.length;
	const files = parsePiProjectContext(prompt.slice(start + 2, end));
	if (!files) return prompt;

	const { user, project } = renderContextSections(files, agentDir);
	const replacement = [user, project].filter((text) => text !== undefined).join("\n\n");
	return `${prompt.slice(0, start)}\n\n${replacement}${prompt.slice(end)}`;
}

export function refineRenderedPrompt(systemPrompt: string, agentDir: string): string {
	const contextStart = systemPrompt.indexOf(`\n\n${PI_PROJECT_OPEN}`);
	const splitAt = contextStart < 0 ? systemPrompt.length : contextStart;
	let head = systemPrompt.slice(0, splitAt);
	for (const name of REMOVED_SECTIONS) head = head.replace(sectionPattern(name), "");
	head = head.replace(sectionPattern(RULES_SECTION), (_match, prefix: string, section: string) => {
		return prefix + polishRules(section);
	});
	return refineRenderedProjectContext(head + systemPrompt.slice(splitAt), agentDir);
}
