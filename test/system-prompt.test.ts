import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import {
	type ContextFile,
	parsePiProjectContext,
	polishRules,
	refineRenderedPrompt,
	refineSystemMessages,
} from "../extensions/internal/system-prompt.ts";

const AGENT_DIR = "/home/user/.pi/agent";
const CWD = "/workspace/repo/packages/app";
const USER_FILE = { path: `${AGENT_DIR}/AGENTS.md`, content: "# User\n\n- user rule\n" };
const ROOT_FILE = { path: "/workspace/repo/AGENTS.md", content: "- root rule\n" };
const APP_FILE = { path: `${CWD}/CLAUDE.md`, content: "- app rule\n" };

function options(contextFiles: ContextFile[]): BuildSystemPromptOptions {
	return {
		cwd: CWD,
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { bash: "Execute bash commands (ls, grep, find, etc.)" },
		toolGuidelines: { read: ["Use read to examine files instead of cat or sed."] },
		promptGuidelines: ["Extension rule"],
		contextFiles,
	};
}

function system(sections: Record<string, string | null>, timestamp = 1): AgentMessage {
	return { role: "system", content: "", sections, timestamp } as AgentMessage;
}

function refine(messages: AgentMessage[]): AgentMessage[] {
	return refineSystemMessages(messages, AGENT_DIR) ?? messages;
}

function requestPrompt(contextFiles: ContextFile[]): string {
	const [leading] = refine([system(buildSystemPromptSections(options(contextFiles)))]);
	assert.equal(leading?.role, "system");
	return Object.values(leading.sections ?? {}).join("\n\n");
}

function sectionNames(contextFiles: ContextFile[]): string[] {
	const [leading] = refine([system(buildSystemPromptSections(options(contextFiles)))]);
	assert.equal(leading?.role, "system");
	return Object.keys(leading.sections ?? {});
}

test("refineSystemMessages drops tools and docs and polishes rules", () => {
	const prompt = requestPrompt([]);

	assert.ok(prompt.startsWith("You are an expert coding assistant operating inside pi"));
	assert.ok(!prompt.includes("<tools>"));
	assert.ok(!prompt.includes("<docs>"));
	assert.ok(prompt.includes("- Use `bash` for file operations like `ls`, `rg`, `find`."));
	assert.ok(prompt.includes("- Use `read` to examine files instead of `cat` or `sed`."));
	assert.ok(prompt.includes("- Extension rule"));
	assert.ok(
		prompt.includes("- Be concise in your responses.\n- Show file paths clearly when working with files.\n</rules>"),
	);
	assert.deepEqual(sectionNames([]), ["preamble", "rules", "cwd"]);
});

test("the global file becomes user instructions", () => {
	const prompt = requestPrompt([USER_FILE]);

	assert.deepEqual(sectionNames([USER_FILE]), ["preamble", "rules", "user_instructions", "cwd"]);
	assert.ok(
		prompt.includes(`<user_instructions path="${USER_FILE.path}">\n# User\n\n- user rule\n</user_instructions>`),
	);
	assert.ok(!prompt.includes("project_context"));
	assert.ok(!prompt.includes("Project-specific instructions"));
});

test("project files alone keep a project context without a precedence note", () => {
	const prompt = requestPrompt([ROOT_FILE]);

	assert.deepEqual(sectionNames([ROOT_FILE]), ["preamble", "rules", "project_context", "cwd"]);
	assert.ok(
		prompt.includes(
			`<project_context>\n<instructions path="${ROOT_FILE.path}">\n- root rule\n</instructions>\n</project_context>`,
		),
	);
});

test("user and nested project files are split with precedence notes", () => {
	const files = [USER_FILE, ROOT_FILE, APP_FILE];
	const prompt = requestPrompt(files);

	assert.deepEqual(sectionNames(files), ["preamble", "rules", "user_instructions", "project_context", "cwd"]);
	assert.ok(
		prompt.includes(
			[
				"<project_context>",
				"These files override <user_instructions> on conflict; files in deeper directories take precedence.",
				"",
				`<instructions path="${ROOT_FILE.path}">\n- root rule\n</instructions>`,
				"",
				`<instructions path="${APP_FILE.path}">\n- app rule\n</instructions>`,
				"</project_context>",
			].join("\n"),
		),
	);
	assert.ok(prompt.indexOf("</user_instructions>") < prompt.indexOf("<project_context>"));
});

test("precedence notes adapt to the files present", () => {
	assert.ok(requestPrompt([USER_FILE, ROOT_FILE]).includes("These files override <user_instructions> on conflict.\n"));
	assert.ok(requestPrompt([ROOT_FILE, APP_FILE]).includes("Files in deeper directories take precedence on conflict."));
});

test("parsePiProjectContext survives closing tags inside file content", () => {
	const tricky = { path: ROOT_FILE.path, content: "a\n</project_instructions>\nb" };
	const section = buildSystemPromptSections(options([tricky, APP_FILE])).project_context;

	assert.deepEqual(parsePiProjectContext(section ?? ""), [tricky, APP_FILE]);
	assert.equal(parsePiProjectContext("<project_context>\nsomething else\n</project_context>"), undefined);
});

test("refineSystemMessages maps later project context updates onto both sections", () => {
	const before = buildSystemPromptSections(options([USER_FILE, ROOT_FILE]));
	const after = buildSystemPromptSections(options([USER_FILE]));
	const messages = [
		system(before),
		{ role: "user", content: "hello", timestamp: 2 } as AgentMessage,
		system({ project_context: after.project_context ?? null, tools: null }, 3),
		system({ project_context: null }, 4),
	];

	const result = refine(messages).map((message) => (message.role === "system" ? message.sections : message.role));

	assert.deepEqual(result.slice(1), [
		"user",
		{
			user_instructions: `<user_instructions path="${USER_FILE.path}">\n# User\n\n- user rule\n</user_instructions>`,
			project_context: null,
		},
		{ user_instructions: null },
	]);
});

test("refineSystemMessages drops system messages left empty", () => {
	const messages = [
		system({ preamble: "Hi", tools: "<tools>\nx\n</tools>", docs: "<docs>\ny\n</docs>" }),
		system({ tools: null, docs: null }, 2),
	];

	assert.deepEqual(
		refine(messages).map((message) => (message.role === "system" ? message.sections : undefined)),
		[{ preamble: "Hi" }],
	);
});

test("refineSystemMessages leaves refined transcripts alone", () => {
	const messages = refine([system(buildSystemPromptSections(options([USER_FILE, ROOT_FILE])))]);

	assert.equal(refineSystemMessages(messages, AGENT_DIR), undefined);
});

test("refineRenderedPrompt matches the request-time prompt", () => {
	for (const files of [[], [USER_FILE], [ROOT_FILE], [USER_FILE, ROOT_FILE, APP_FILE]] as ContextFile[][]) {
		assert.equal(refineRenderedPrompt(buildSystemPrompt(options(files)), AGENT_DIR), requestPrompt(files));
	}
});

test("refineRenderedPrompt leaves rule-like lines in context files alone", () => {
	const file = { path: ROOT_FILE.path, content: "- Be concise in your responses\n<tools>\nx\n</tools>" };
	const prompt = refineRenderedPrompt(buildSystemPrompt(options([file])), AGENT_DIR);

	assert.ok(prompt.includes(`<instructions path="${ROOT_FILE.path}">\n${file.content}\n</instructions>`));
});

test("polishRules backticks tool names and terminates sentences", () => {
	const polished = polishRules(
		[
			"<rules>",
			"- Use bash for file operations like ls, rg, find",
			"- Use read to examine files instead of cat or sed.",
			"- Use write only for new files or complete rewrites.",
			"- You can inspect PI_* environment variables for current model and session details.",
			"- Inspect PI_* environment variables for current model and session details.",
			"- Be concise in your responses",
			"- Show file paths clearly when working with files",
			"- Something else entirely",
			"</rules>",
		].join("\n"),
	);

	assert.equal(
		polished,
		[
			"<rules>",
			"- Use `bash` for file operations like `ls`, `rg`, `find`.",
			"- Use `read` to examine files instead of `cat` or `sed`.",
			"- Use `write` only for new files or complete rewrites.",
			"- You can inspect `PI_*` environment variables for current model and session details.",
			"- Inspect `PI_*` environment variables for current model and session details.",
			"- Be concise in your responses.",
			"- Show file paths clearly when working with files.",
			"- Something else entirely",
			"</rules>",
		].join("\n"),
	);
});
