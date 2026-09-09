import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import commentGuardExtension from "../extensions/comment-guard.ts";

type ToolCallHandler = (
	event: { toolName: string; toolCallId: string; input: Record<string, unknown> },
	ctx: ExtensionContext,
) => Promise<{ block?: boolean; reason?: string } | undefined>;

type ToolResultHandler = (event: {
	toolCallId: string;
	content: { type: string; text?: string }[];
}) => Promise<{ content: { type: string; text?: string }[] } | undefined>;

type BeforeAgentStartHandler = (
	event: { systemPrompt: string; systemPromptOptions: { cwd?: string } },
	ctx: ExtensionContext,
) => Promise<{ systemPrompt?: string } | undefined>;

type BranchEntry = { type: string; customType: string; data: Record<string, unknown> };

interface Harness {
	dir: string;
	entries: BranchEntry[];
	onToolCall: ToolCallHandler;
	onToolResult: ToolResultHandler;
	onBeforeAgentStart: BeforeAgentStartHandler;
	ctx: ExtensionContext;
}

async function createHarness(settings: Record<string, unknown> = {}): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "comment-guard-"));
	await mkdir(join(dir, ".pi"), { recursive: true });
	await writeFile(
		join(dir, ".pi", "settings.json"),
		JSON.stringify({ piEnhanced: { commentGuard: settings } }),
		"utf-8",
	);

	const entries: BranchEntry[] = [];
	let onToolCall: ToolCallHandler | undefined;
	let onToolResult: ToolResultHandler | undefined;
	let onBeforeAgentStart: BeforeAgentStartHandler | undefined;
	const pi = {
		on: (event: string, handler: unknown) => {
			if (event === "tool_call") onToolCall = handler as ToolCallHandler;
			if (event === "tool_result") onToolResult = handler as ToolResultHandler;
			if (event === "before_agent_start") onBeforeAgentStart = handler as BeforeAgentStartHandler;
		},
		registerCommand: () => {},
		appendEntry: (customType: string, data: Record<string, unknown>) => {
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;

	commentGuardExtension(pi);
	assert.ok(onToolCall, "tool_call handler registered");
	assert.ok(onToolResult, "tool_result handler registered");
	assert.ok(onBeforeAgentStart, "before_agent_start handler registered");

	return {
		dir,
		entries,
		onToolCall,
		onToolResult,
		onBeforeAgentStart,
		ctx: { cwd: dir, hasUI: false, sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext,
	};
}

async function withHarness(settings: Record<string, unknown>, run: (harness: Harness) => Promise<void>): Promise<void> {
	const harness = await createHarness(settings);
	try {
		await run(harness);
	} finally {
		await rm(harness.dir, { recursive: true, force: true });
	}
}

test("write with a new comment is blocked", async () => {
	await withHarness({}, async (harness) => {
		const result = await harness.onToolCall(
			{
				toolName: "write",
				toolCallId: "call-1",
				input: { path: "src/app.ts", content: "// compute the total\nexport const total = 1;\n" },
			},
			harness.ctx,
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /1 comment in src\/app\.ts/);
		assert.match(result?.reason ?? "", /line 1: \/\/ compute the total/);
	});
});

test("write without comments passes", async () => {
	await withHarness({}, async (harness) => {
		const result = await harness.onToolCall(
			{
				toolName: "write",
				toolCallId: "call-2",
				input: { path: "src/app.ts", content: 'export const url = "https://example.com";\n' },
			},
			harness.ctx,
		);

		assert.equal(result, undefined);
	});
});

test("edit is checked per inserted chunk and allows untouched comments", async () => {
	await withHarness({}, async (harness) => {
		await mkdir(join(harness.dir, "src"), { recursive: true });
		await writeFile(join(harness.dir, "src", "app.ts"), "// existing note\nexport const a = 1;\n", "utf-8");

		const blocked = await harness.onToolCall(
			{
				toolName: "edit",
				toolCallId: "call-3",
				input: {
					path: "src/app.ts",
					tag: "abcd",
					edits: [{ op: "replace", from: 2, lines: ["export const a = 2; // now two"] }],
				},
			},
			harness.ctx,
		);
		assert.equal(blocked?.block, true);

		const allowed = await harness.onToolCall(
			{
				toolName: "edit",
				toolCallId: "call-4",
				input: {
					path: "src/app.ts",
					tag: "abcd",
					edits: [{ op: "replace", from: 1, to: 2, lines: ["// existing note", "export const a = 2;"] }],
				},
			},
			harness.ctx,
		);
		assert.equal(allowed, undefined);
	});
});

test("alternative argument shapes are still inspected", async () => {
	await withHarness({}, async (harness) => {
		const stringified = await harness.onToolCall(
			{
				toolName: "edit",
				toolCallId: "call-13",
				input: {
					file_path: "src/app.ts",
					edits: JSON.stringify([{ op: "insert_after", from: 1, lines: "// added" }]),
				},
			},
			harness.ctx,
		);
		assert.equal(stringified?.block, true);

		const oldNewText = await harness.onToolCall(
			{
				toolName: "edit",
				toolCallId: "call-14",
				input: {
					path: "src/app.ts",
					edits: [{ oldText: "const a = 1;", newText: "const a = 2; // bumped" }],
				},
			},
			harness.ctx,
		);
		assert.equal(oldNewText?.block, true);
	});
});

test("warn mode appends a delimited warning instead of blocking", async () => {
	await withHarness({ mode: "warn" }, async (harness) => {
		const call = await harness.onToolCall(
			{ toolName: "write", toolCallId: "call-5", input: { path: "app.py", content: "# note\nvalue = 1\n" } },
			harness.ctx,
		);
		assert.equal(call, undefined);

		const result = await harness.onToolResult({
			toolCallId: "call-5",
			content: [{ type: "text", text: "wrote app.py" }],
		});
		assert.ok(result);
		assert.equal(result.content.length, 2);
		assert.match(result.content[1]?.text ?? "", /^\n<comment-guard-warning>\n/);
		assert.match(result.content[1]?.text ?? "", /1 comment in app\.py/);
	});
});

test("off mode, ignored paths, and unknown file types are skipped", async () => {
	await withHarness({ mode: "off" }, async (harness) => {
		const result = await harness.onToolCall(
			{ toolName: "write", toolCallId: "call-6", input: { path: "src/app.ts", content: "// note\n" } },
			harness.ctx,
		);
		assert.equal(result, undefined);
	});

	await withHarness({ ignorePaths: ["docs"] }, async (harness) => {
		const ignored = await harness.onToolCall(
			{ toolName: "write", toolCallId: "call-7", input: { path: "docs/page.html", content: "<!-- note -->\n" } },
			harness.ctx,
		);
		assert.equal(ignored, undefined);

		const unknownType = await harness.onToolCall(
			{ toolName: "write", toolCallId: "call-8", input: { path: "notes.txt", content: "// not code\n" } },
			harness.ctx,
		);
		assert.equal(unknownType, undefined);
	});
});

test("allowPatterns and allowDirectives control the exceptions", async () => {
	await withHarness({}, async (harness) => {
		const directive = await harness.onToolCall(
			{
				toolName: "write",
				toolCallId: "call-9",
				input: { path: "src/app.ts", content: "// eslint-disable-next-line no-console\nconsole.log(1);\n" },
			},
			harness.ctx,
		);
		assert.equal(directive, undefined);
	});

	await withHarness({ allowDirectives: false }, async (harness) => {
		const directive = await harness.onToolCall(
			{
				toolName: "write",
				toolCallId: "call-10",
				input: { path: "src/app.ts", content: "// eslint-disable-next-line no-console\nconsole.log(1);\n" },
			},
			harness.ctx,
		);
		assert.equal(directive?.block, true);
	});

	await withHarness({ allowPatterns: ["^// SAFETY:"] }, async (harness) => {
		const allowed = await harness.onToolCall(
			{ toolName: "write", toolCallId: "call-11", input: { path: "src/app.ts", content: "// SAFETY: checked\n" } },
			harness.ctx,
		);
		assert.equal(allowed, undefined);
	});
});

test("session override from /comments disables the guard", async () => {
	await withHarness({}, async (harness) => {
		harness.entries.push({ type: "custom", customType: "comment-guard-mode", data: { allowed: true } });

		const result = await harness.onToolCall(
			{ toolName: "write", toolCallId: "call-12", input: { path: "src/app.ts", content: "// note\n" } },
			harness.ctx,
		);
		assert.equal(result, undefined);
	});
});

test("the active guard adds a system prompt guideline", async () => {
	const prompt = "You are a coding assistant.\n\nGuidelines:\n- Be concise in your responses.\n";

	await withHarness({}, async (harness) => {
		const result = await harness.onBeforeAgentStart(
			{ systemPrompt: prompt, systemPromptOptions: { cwd: harness.dir } },
			harness.ctx,
		);
		assert.match(result?.systemPrompt ?? "", /- Do not add comments to code; `edit` and `write` reject them/);
	});

	await withHarness({ mode: "off" }, async (harness) => {
		const result = await harness.onBeforeAgentStart(
			{ systemPrompt: prompt, systemPromptOptions: { cwd: harness.dir } },
			harness.ctx,
		);
		assert.equal(result, undefined);
	});
});
