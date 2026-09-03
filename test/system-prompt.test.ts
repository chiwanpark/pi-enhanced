import assert from "node:assert/strict";
import test from "node:test";
import { cleanSystemPrompt, HOUSE_GUIDELINES } from "../extensions/internal/system-prompt.ts";

const CWD = "/workspace/project";

const BASE_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- bash: Execute bash commands (ls, grep, find, etc.)

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Use bash for file operations like ls, rg, find
- Be concise in your responses

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /pi/README.md
- Examples: /pi/examples (extensions, custom tools, SDK)

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/workspace/project/AGENTS.md">
rules
</project_instructions>

</project_context>

Current working directory: ${CWD}`;

test("cleanSystemPrompt strips the default sections and adds the house guidelines", () => {
	const cleaned = cleanSystemPrompt(BASE_PROMPT, CWD);

	assert.ok(cleaned.startsWith("You are a coding assistant operating inside pi."));
	assert.ok(!cleaned.includes("Available tools:"));
	assert.ok(!cleaned.includes("Pi documentation ("));
	for (const guideline of HOUSE_GUIDELINES) {
		assert.ok(cleaned.includes(`- ${guideline}`));
	}
});

test("cleanSystemPrompt moves the current directory into the project context", () => {
	const cleaned = cleanSystemPrompt(BASE_PROMPT, CWD);

	assert.ok(!cleaned.includes("Current working directory:"));
	assert.ok(!cleaned.includes("Project-specific instructions and guidelines:"));
	assert.ok(cleaned.includes("<project_context>\n\n<project_instruction "));
	assert.ok(!cleaned.includes("project_instructions"));
	assert.ok(cleaned.includes(`<current_directory>${CWD}</current_directory>`));
	assert.ok(cleaned.indexOf("<current_directory>") < cleaned.indexOf("</project_context>"));
	assert.ok(cleaned.indexOf("</project_instruction>") < cleaned.indexOf("<current_directory>"));
	assert.ok(cleaned.endsWith("</project_context>"));
});

test("cleanSystemPrompt wraps context file contents in CDATA", () => {
	const cleaned = cleanSystemPrompt(BASE_PROMPT, CWD);

	assert.ok(
		cleaned.includes(
			'<project_instruction path="/workspace/project/AGENTS.md">\n<![CDATA[\n\nrules\n\n]]>\n</project_instruction>',
		),
	);
});

test("cleanSystemPrompt splits CDATA terminators inside context files", () => {
	const prompt = BASE_PROMPT.replace("rules", "before ]]> after");
	const cleaned = cleanSystemPrompt(prompt, CWD);

	assert.ok(cleaned.includes("<![CDATA[\n\nbefore ]]]]><![CDATA[> after\n\n]]>"));
});

test("cleanSystemPrompt is idempotent", () => {
	const once = cleanSystemPrompt(BASE_PROMPT, CWD);
	assert.equal(cleanSystemPrompt(once, CWD), once);
});

test("cleanSystemPrompt keeps custom prompts intact", () => {
	const customPrompt = `My own prompt.\n\nGuidelines:\n- Stay sharp\n\nCurrent working directory: ${CWD}`;
	const cleaned = cleanSystemPrompt(customPrompt, CWD, true);

	assert.ok(cleaned.startsWith("My own prompt."));
	assert.ok(cleaned.includes(`- ${HOUSE_GUIDELINES[0]}`));
	assert.ok(
		cleaned.endsWith(`<project_context>\n\n<current_directory>${CWD}</current_directory>\n\n</project_context>`),
	);
});
