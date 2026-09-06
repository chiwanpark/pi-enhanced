import assert from "node:assert/strict";
import test from "node:test";
import {
	AnnotationRegistry,
	applyContextAnnotations,
	type ContextAnnotation,
} from "../extensions/internal/hashline/context.ts";

function registryWith(entries: Record<string, ContextAnnotation>): AnnotationRegistry {
	const registry = new AnnotationRegistry();
	for (const [id, annotation] of Object.entries(entries)) registry.set(id, annotation);
	return registry;
}

function toolResult(toolCallId: string, text: string, isError = false) {
	return { role: "toolResult", toolCallId, toolName: "read", isError, content: [{ type: "text", text }] };
}

test("read annotation adds the header and numbers only the shown lines", () => {
	const registry = registryWith({
		r1: { kind: "read", header: "[a.ts#AB12]", offset: 1, shownCount: 2 },
	});
	const message = toolResult("r1", "const a = 1;\nconst b = 2;\n[3 more lines in file. Use offset=3 to continue.]");

	assert.equal(applyContextAnnotations([message], registry), true);
	assert.equal(
		message.content[0]?.text,
		"[a.ts#AB12]\n1:const a = 1;\n2:const b = 2;\n[3 more lines in file. Use offset=3 to continue.]",
	);
});

test("read annotation respects the offset", () => {
	const registry = registryWith({
		r1: { kind: "read", header: "[a.ts#AB12]", offset: 10, shownCount: 2 },
	});
	const message = toolResult("r1", "ten\neleven");

	assert.equal(applyContextAnnotations([message], registry), true);
	assert.equal(message.content[0]?.text, "[a.ts#AB12]\n10:ten\n11:eleven");
});

test("read annotation strips BOM and CR so numbered lines match the snapshot", () => {
	const registry = registryWith({
		r1: { kind: "read", header: "[a.ts#AB12]", offset: 1, shownCount: 2 },
	});
	const message = toolResult("r1", "\uFEFFone\r\ntwo\r");

	assert.equal(applyContextAnnotations([message], registry), true);
	assert.equal(message.content[0]?.text, "[a.ts#AB12]\n1:one\n2:two");
});

test("annotation is not applied twice", () => {
	const registry = registryWith({
		r1: { kind: "read", header: "[a.ts#AB12]", offset: 1, shownCount: 1 },
	});
	const message = toolResult("r1", "[a.ts#AB12]\n1:const a = 1;");

	assert.equal(applyContextAnnotations([message], registry), false);
	assert.equal(message.content[0]?.text, "[a.ts#AB12]\n1:const a = 1;");
});

test("append annotation adds a trailing text part once", () => {
	const registry = registryWith({ w1: { kind: "append", text: "\n[a.ts#77AB] (edit by these line numbers)" } });
	const message = toolResult("w1", "Successfully wrote 26 bytes to a.ts");

	assert.equal(applyContextAnnotations([message], registry), true);
	assert.equal(message.content.length, 2);
	assert.equal(message.content[1]?.text, "\n[a.ts#77AB] (edit by these line numbers)");

	assert.equal(applyContextAnnotations([message], registry), false);
	assert.equal(message.content.length, 2);
});

test("unrelated and error messages are left untouched", () => {
	const registry = registryWith({
		r1: { kind: "read", header: "[a.ts#AB12]", offset: 1, shownCount: 1 },
	});
	const errored = toolResult("r1", "boom", true);
	const other = toolResult("r2", "const a = 1;");
	const user = { role: "user", content: [{ type: "text", text: "hello" }] };

	assert.equal(applyContextAnnotations([errored, other, user], registry), false);
	assert.equal(errored.content[0]?.text, "boom");
	assert.equal(other.content[0]?.text, "const a = 1;");
});

test("empty registry short-circuits", () => {
	const message = toolResult("r1", "const a = 1;");
	assert.equal(applyContextAnnotations([message], new AnnotationRegistry()), false);
});

test("registry evicts oldest entries beyond the cap", () => {
	const registry = new AnnotationRegistry();
	for (let index = 0; index < 8193; index++) {
		registry.set(`id-${index}`, { kind: "append", text: "x" });
	}
	assert.equal(registry.size, 8192);
	assert.equal(registry.get("id-0"), undefined);
	assert.ok(registry.get("id-8192"));
});
