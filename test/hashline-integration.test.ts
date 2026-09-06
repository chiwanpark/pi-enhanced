import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import hashlineExtension from "../extensions/hashline.ts";

type ToolResultHandler = (
	event: Record<string, unknown>,
	ctx: { cwd: string },
) => Promise<{ content?: { type: string; text?: string }[] } | undefined>;

type ContextHandler = (event: { messages: unknown[] }) => Promise<{ messages: unknown[] } | undefined>;

interface Harness {
	dir: string;
	file: string;
	tool: ToolDefinition;
	onToolResult: ToolResultHandler;
	onContext: ContextHandler;
	ctx: ExtensionContext;
	read: (args?: { offset?: number; limit?: number }) => Promise<string>;
	edit: (input: Record<string, unknown>) => Promise<string>;
	current: () => Promise<string>;
}

function piReadOutput(content: string, offset = 1, limit?: number): string {
	const all = content.split("\n");
	const start = Math.max(0, offset - 1);
	const end = limit === undefined ? all.length : Math.min(start + limit, all.length);
	return all.slice(start, end).join("\n");
}

async function createHarness(source: string): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "hashline-"));
	const file = join(dir, "sample.ts");
	await writeFile(file, source, "utf-8");

	let tool: ToolDefinition | undefined;
	let onToolResult: ToolResultHandler | undefined;
	let onContext: ContextHandler | undefined;
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		on: (event: string, handler: unknown) => {
			if (event === "tool_result") onToolResult = handler as ToolResultHandler;
			if (event === "context") onContext = handler as ContextHandler;
		},
	} as unknown as ExtensionAPI;

	hashlineExtension(pi);
	assert.ok(tool, "edit tool registered");
	assert.ok(onToolResult, "tool_result handler registered");
	assert.ok(onContext, "context handler registered");

	const ctx = { cwd: dir } as unknown as ExtensionContext;
	const handler = onToolResult;
	const contextHandler = onContext;
	const definition = tool;
	let nextCallId = 0;

	return {
		dir,
		file,
		tool: definition,
		onToolResult: handler,
		onContext: contextHandler,
		ctx,
		async read(args) {
			const content = await readFile(file, "utf-8");
			const rawText = piReadOutput(content, args?.offset ?? 1, args?.limit);
			const toolCallId = `read-${nextCallId++}`;
			const hooked = await handler(
				{
					toolName: "read",
					toolCallId,
					isError: false,
					input: { path: "sample.ts", ...args },
					content: [{ type: "text", text: rawText }],
					details: undefined,
				},
				{ cwd: dir },
			);
			assert.equal(hooked, undefined, "stored read content stays untouched");

			const message = {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: rawText }],
			};
			const transformed = await contextHandler({ messages: [message] });
			assert.ok(transformed, "context transform annotated the read");
			const part = (transformed.messages[0] as { content: { type: string; text?: string }[] }).content[0];
			assert.ok(part && typeof part.text === "string", "read output was annotated");
			return part.text;
		},
		async edit(input) {
			const prepared = definition.prepareArguments ? definition.prepareArguments(input) : input;
			const result = await definition.execute("call-1", prepared, undefined, undefined, ctx);
			const part = result.content[0];
			return part && part.type === "text" ? (part.text ?? "") : "";
		},
		current: () => readFile(file, "utf-8"),
	};
}

function tagOf(readOutput: string): string {
	const match = /^\[[^\]]+#([0-9A-F]{4})\]/.exec(readOutput);
	assert.ok(match, `expected a hashline header, got: ${readOutput.slice(0, 60)}`);
	return match[1] as string;
}

const SOURCE = ["export function greet(name: string) {", '\treturn "hi " + name;', "}", ""].join("\n");

test("read is annotated with a tag and line numbers", async (t) => {
	const harness = await createHarness(SOURCE);
	t.after(() => rm(harness.dir, { recursive: true, force: true }));

	const output = await harness.read();

	assert.match(output, /^\[sample\.ts#[0-9A-F]{4}\]\n/);
	assert.ok(output.includes("1:export function greet(name: string) {"));
	assert.ok(output.includes("3:}"));
});

test("edit applies against the tag and returns a fresh one", async (t) => {
	const harness = await createHarness(SOURCE);
	t.after(() => rm(harness.dir, { recursive: true, force: true }));

	const tag = tagOf(await harness.read());
	const result = await harness.edit({
		path: "sample.ts",
		tag,
		edits: [{ op: "replace", from: 2, lines: ["\treturn `hi ${name}`;"] }],
	});

	assert.equal(await harness.current(), "export function greet(name: string) {\n\treturn `hi ${name}`;\n}\n");
	assert.match(result, /Applied 1 edit \(\+1 -1 lines\)/);
	const newTag = tagOf(result.slice(result.indexOf("[")));
	assert.notEqual(newTag, tag);
	assert.ok(result.includes("2:\treturn `hi ${name}`;"));
});

test("consecutive edits work from the tag returned by the previous edit", async (t) => {
	const harness = await createHarness(SOURCE);
	t.after(() => rm(harness.dir, { recursive: true, force: true }));

	const first = await harness.edit({
		path: "sample.ts",
		tag: tagOf(await harness.read()),
		edits: [{ op: "insert_after", from: 1, lines: ["\t// greeting"] }],
	});
	const second = await harness.edit({
		path: "sample.ts",
		tag: tagOf(first.slice(first.indexOf("["))),
		edits: [{ op: "replace", from: 1, lines: ["export function greet(name: string): string {"] }],
	});

	assert.ok(second.includes("Applied 1 edit"));
	assert.equal(
		await harness.current(),
		'export function greet(name: string): string {\n\t// greeting\n\treturn "hi " + name;\n}\n',
	);
});

test("a stale tag is rejected without touching the file", async (t) => {
	const harness = await createHarness(SOURCE);
	t.after(() => rm(harness.dir, { recursive: true, force: true }));

	const tag = tagOf(await harness.read());
	await harness.edit({ path: "sample.ts", tag, edits: [{ op: "replace", from: 3, lines: ["};"] }] });
	const after = await harness.current();

	await assert.rejects(
		() => harness.edit({ path: "sample.ts", tag, edits: [{ op: "replace", from: 1, lines: ["x"] }] }),
		/E_STALE_TAG/,
	);
	assert.equal(await harness.current(), after);
});

test("a stale tag reports the current lines so the retry needs no re-read", async (t) => {
	const harness = await createHarness(SOURCE);
	t.after(() => rm(harness.dir, { recursive: true, force: true }));

	const tag = tagOf(await harness.read());
	await harness.edit({
		path: "sample.ts",
		tag,
		edits: [{ op: "replace", from: 1, lines: ["export function greet(name: string): string {"] }],
	});

	const error = await harness.edit({ path: "sample.ts", tag, edits: [{ op: "replace", from: 3, lines: ["};"] }] }).then(
		() => undefined,
		(reason: Error) => reason,
	);

	assert.ok(error);
	assert.match(error.message, /E_STALE_TAG/);
	assert.match(error.message, /3:}/);

	const retried = await harness.edit({
		path: "sample.ts",
		tag: tagOf(error.message.slice(error.message.indexOf("[sample.ts#"))),
		edits: [{ op: "replace", from: 3, lines: ["};"] }],
	});

	assert.ok(retried.includes("Applied 1 edit"));
	assert.equal(await harness.current(), 'export function greet(name: string): string {\n\treturn "hi " + name;\n};\n');
});

test("an external change since the read is rejected", async (t) => {
	const harness = await createHarness(SOURCE);
	t.after(() => rm(harness.dir, { recursive: true, force: true }));

	const tag = tagOf(await harness.read());
	await writeFile(harness.file, `// touched\n${SOURCE}`, "utf-8");

	await assert.rejects(
		() => harness.edit({ path: "sample.ts", tag, edits: [{ op: "replace", from: 1, lines: ["x"] }] }),
		/E_STALE_FILE/,
	);
	assert.equal(await harness.current(), `// touched\n${SOURCE}`);
});

test("editing a file that was never read is rejected", async (t) => {
	const harness = await createHarness(SOURCE);
	t.after(() => rm(harness.dir, { recursive: true, force: true }));

	await assert.rejects(
		() => harness.edit({ path: "sample.ts", tag: "A1B2", edits: [{ op: "replace", from: 1, lines: ["x"] }] }),
		/E_NO_SNAPSHOT/,
	);
});

test("lines outside the read window cannot be edited", async (t) => {
	const source = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
	const harness = await createHarness(source);
	t.after(() => rm(harness.dir, { recursive: true, force: true }));

	const tag = tagOf(await harness.read({ limit: 5 }));

	await assert.rejects(
		() => harness.edit({ path: "sample.ts", tag, edits: [{ op: "replace", from: 12, lines: ["x"] }] }),
		/E_UNSEEN/,
	);
	const result = await harness.edit({
		path: "sample.ts",
		tag,
		edits: [{ op: "replace", from: 3, lines: ["LINE 3"] }],
	});
	assert.ok(result.includes("3:LINE 3"));
});

test("write records a snapshot so the file can be edited without a read", async (t) => {
	const harness = await createHarness(SOURCE);
	t.after(() => rm(harness.dir, { recursive: true, force: true }));

	const created = join(harness.dir, "fresh.ts");
	await writeFile(created, "const a = 1;\nconst b = 2;\n", "utf-8");
	const hooked = await harness.onToolResult(
		{
			toolName: "write",
			toolCallId: "write-1",
			isError: false,
			input: { path: "fresh.ts" },
			content: [{ type: "text", text: "Successfully wrote 26 bytes to fresh.ts" }],
			details: undefined,
		},
		{ cwd: harness.dir },
	);
	assert.equal(hooked, undefined, "stored write content stays untouched");

	const message = {
		role: "toolResult",
		toolCallId: "write-1",
		toolName: "write",
		isError: false,
		content: [{ type: "text", text: "Successfully wrote 26 bytes to fresh.ts" }],
	};
	const transformed = await harness.onContext({ messages: [message] });
	assert.ok(transformed, "context transform appended the tag");
	const appended = (transformed.messages[0] as { content: { text?: string }[] }).content[1]?.text ?? "";

	const result = await harness.edit({
		path: "fresh.ts",
		tag: tagOf(appended.trim()),
		edits: [{ op: "replace", from: 2, lines: ["const b = 3;"] }],
	});

	assert.ok(result.includes("Applied 1 edit"));
	assert.equal(await readFile(created, "utf-8"), "const a = 1;\nconst b = 3;\n");
});

test("CRLF and BOM survive an edit", async (t) => {
	const harness = await createHarness("\uFEFFone\r\ntwo\r\nthree\r\n");
	t.after(() => rm(harness.dir, { recursive: true, force: true }));

	const tag = tagOf(await harness.read());
	await harness.edit({ path: "sample.ts", tag, edits: [{ op: "replace", from: 2, lines: ["TWO"] }] });

	assert.equal(await harness.current(), "\uFEFFone\r\nTWO\r\nthree\r\n");
});
