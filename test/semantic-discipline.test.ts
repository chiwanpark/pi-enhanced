import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import semanticDisciplineExtension from "../extensions/semantic-discipline.ts";

type ToolCallHandler = (
	event: { toolName: string; toolCallId: string; input: Record<string, unknown> },
	ctx: { cwd: string; hasUI: boolean },
) => Promise<{ block?: boolean; reason?: string } | undefined>;

type ToolResultHandler = (event: {
	toolCallId: string;
	content: { type: string; text?: string }[];
}) => Promise<{ content: { type: string; text?: string }[] } | undefined>;

interface Harness {
	dir: string;
	onToolCall: ToolCallHandler;
	onToolResult: ToolResultHandler;
	ctx: ExtensionContext;
}

async function createHarness(): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "semantic-discipline-"));
	await mkdir(join(dir, ".pi"), { recursive: true });
	await writeFile(
		join(dir, ".pi", "settings.json"),
		JSON.stringify({ piEnhanced: { semanticDiscipline: { mode: "warn", warnUnboundedRead: true } } }),
		"utf-8",
	);

	let onToolCall: ToolCallHandler | undefined;
	let onToolResult: ToolResultHandler | undefined;
	const pi = {
		on: (event: string, handler: unknown) => {
			if (event === "tool_call") onToolCall = handler as ToolCallHandler;
			if (event === "tool_result") onToolResult = handler as ToolResultHandler;
		},
	} as unknown as ExtensionAPI;

	semanticDisciplineExtension(pi);
	assert.ok(onToolCall, "tool_call handler registered");
	assert.ok(onToolResult, "tool_result handler registered");

	return {
		dir,
		onToolCall,
		onToolResult,
		ctx: { cwd: dir, hasUI: false } as unknown as ExtensionContext,
	};
}

test("unbounded read warning is delimited so file content stays unambiguous", async () => {
	const harness = await createHarness();
	try {
		const blocked = await harness.onToolCall(
			{ toolName: "read", toolCallId: "call-1", input: { path: "config.yaml" } },
			harness.ctx,
		);
		assert.equal(blocked, undefined);

		const result = await harness.onToolResult({
			toolCallId: "call-1",
			content: [{ type: "text", text: "name: pi\nversion: 1" }],
		});
		assert.ok(result);
		assert.equal(result.content.length, 2);
		assert.equal(result.content[0]?.text, "name: pi\nversion: 1");
		assert.equal(
			result.content[1]?.text,
			"\n<semantic-discipline-warning>\nUnbounded read of config.yaml. Pass offset and limit to read a bounded slice.\n</semantic-discipline-warning>",
		);
	} finally {
		await rm(harness.dir, { recursive: true, force: true });
	}
});

test("bounded read produces no warning content", async () => {
	const harness = await createHarness();
	try {
		await harness.onToolCall(
			{ toolName: "read", toolCallId: "call-2", input: { path: "config.yaml", limit: 40 } },
			harness.ctx,
		);
		const result = await harness.onToolResult({
			toolCallId: "call-2",
			content: [{ type: "text", text: "name: pi" }],
		});
		assert.equal(result, undefined);
	} finally {
		await rm(harness.dir, { recursive: true, force: true });
	}
});
