import assert from "node:assert/strict";
import test from "node:test";
import { annotateReadOutput } from "../extensions/internal/hashline/annotate.ts";
import { prepareEditArguments } from "../extensions/internal/hashline/params.ts";
import { buildPreview } from "../extensions/internal/hashline/preview.ts";
import { mergeRanges, shiftRanges, SnapshotStore } from "../extensions/internal/hashline/store.ts";
import { computeTag, decodeText, encodeText } from "../extensions/internal/hashline/text.ts";

const FILE_LINES = ["alpha", "beta", "gamma", "delta", "epsilon"];

test("annotate adds the header and numbers a full read", () => {
	const result = annotateReadOutput({
		output: FILE_LINES.join("\n"),
		fileLines: FILE_LINES,
		displayPath: "src/a.ts",
		tag: "A1B2",
		offset: 1,
	});

	assert.ok(result);
	assert.equal(result.text, "[src/a.ts#A1B2]\n1:alpha\n2:beta\n3:gamma\n4:delta\n5:epsilon");
	assert.deepEqual(result.shown, { from: 1, to: 5 });
});

test("annotate numbers from the requested offset", () => {
	const result = annotateReadOutput({
		output: "gamma\ndelta\nepsilon",
		fileLines: FILE_LINES,
		displayPath: "src/a.ts",
		tag: "A1B2",
		offset: 3,
	});

	assert.ok(result);
	assert.equal(result.text, "[src/a.ts#A1B2]\n3:gamma\n4:delta\n5:epsilon");
	assert.deepEqual(result.shown, { from: 3, to: 5 });
});

test("annotate keeps a continuation note out of the numbering", () => {
	const output = "alpha\nbeta\n\n[3 more lines in file. Use offset=3 to continue.]";
	const result = annotateReadOutput({
		output,
		fileLines: FILE_LINES,
		displayPath: "src/a.ts",
		tag: "A1B2",
		offset: 1,
	});

	assert.ok(result);
	assert.equal(result.text, "[src/a.ts#A1B2]\n1:alpha\n2:beta\n\n[3 more lines in file. Use offset=3 to continue.]");
	assert.deepEqual(result.shown, { from: 1, to: 2 });
});

test("annotate uses the truncation report when pi truncated the output", () => {
	const output = "alpha\nbeta\ngamma\n\n[Showing lines 1-3 of 5. Use offset=4 to continue.]";
	const result = annotateReadOutput({
		output,
		fileLines: FILE_LINES,
		displayPath: "src/a.ts",
		tag: "A1B2",
		offset: 1,
		outputLines: 3,
	});

	assert.ok(result);
	assert.deepEqual(result.shown, { from: 1, to: 3 });
	assert.ok(result.text.includes("3:gamma"));
	assert.ok(result.text.includes("\n[Showing lines 1-3 of 5."));
});

test("annotate bails when the output does not match the file on disk", () => {
	const result = annotateReadOutput({
		output: "alpha\nCHANGED",
		fileLines: FILE_LINES,
		displayPath: "src/a.ts",
		tag: "A1B2",
		offset: 1,
	});

	assert.equal(result, undefined);
});

test("preview renders the changed region with context and fresh numbers", () => {
	const lines = ["1", "2", "3", "4", "5", "6", "7", "8"];
	const preview = buildPreview("src/a.ts", "C3D4", lines, [{ from: 4, to: 5 }]);

	assert.equal(preview.text, "[src/a.ts#C3D4]\n2:2\n3:3\n4:4\n5:5\n6:6\n7:7");
	assert.deepEqual(preview.shown, [{ from: 2, to: 7 }]);
	assert.equal(preview.truncated, false);
});

test("preview separates distant regions", () => {
	const lines = Array.from({ length: 40 }, (_, index) => `line${index + 1}`);
	const preview = buildPreview("src/a.ts", "C3D4", lines, [
		{ from: 2, to: 2 },
		{ from: 30, to: 30 },
	]);

	assert.ok(preview.text.includes("\n...\n"));
	assert.deepEqual(preview.shown, [
		{ from: 1, to: 4 },
		{ from: 28, to: 32 },
	]);
});

test("preview marks truncation when the budget is exhausted", () => {
	const lines = Array.from({ length: 40 }, (_, index) => `line${index + 1}`);
	const preview = buildPreview("src/a.ts", "C3D4", lines, [{ from: 1, to: 40 }], { maxLines: 5 });

	assert.equal(preview.truncated, true);
	assert.ok(preview.text.includes("[Preview truncated."));
});

test("store keeps seen ranges for an unchanged file and resets them when it changes", () => {
	const store = new SnapshotStore();
	store.record("/a", "one\ntwo\n", [{ from: 1, to: 1 }]);
	const same = store.record("/a", "one\ntwo\n", [{ from: 2, to: 2 }]);
	assert.deepEqual(same?.seen, [{ from: 1, to: 2 }]);

	const changed = store.record("/a", "one\nTWO\n", [{ from: 2, to: 2 }]);
	assert.deepEqual(changed?.seen, [{ from: 2, to: 2 }]);
});

test("store evicts the least recently used path", () => {
	const store = new SnapshotStore({ maxPaths: 2 });
	store.record("/a", "a\n", "all");
	store.record("/b", "b\n", "all");
	store.get("/a");
	store.record("/c", "c\n", "all");

	assert.equal(store.size, 2);
	assert.ok(store.get("/a"));
	assert.equal(store.get("/b"), undefined);
});

test("store refuses to snapshot oversized files", () => {
	const store = new SnapshotStore({ maxBytes: 8 });
	assert.equal(store.record("/a", "0123456789\n", "all"), undefined);
});

test("mergeRanges joins touching ranges", () => {
	assert.deepEqual(
		mergeRanges([
			{ from: 5, to: 6 },
			{ from: 1, to: 2 },
			{ from: 3, to: 4 },
			{ from: 9, to: 9 },
		]),
		[
			{ from: 1, to: 6 },
			{ from: 9, to: 9 },
		],
	);
});

test("shiftRanges moves lines after an insertion", () => {
	const shifted = shiftRanges([{ from: 1, to: 5 }], [{ start: 2, end: 2, delta: 3 }]);
	assert.deepEqual(shifted, [
		{ from: 1, to: 2 },
		{ from: 6, to: 8 },
	]);
});

test("tags are stable per content and differ across content", () => {
	assert.equal(computeTag("a\nb\n"), computeTag("a\nb\n"));
	assert.notEqual(computeTag("a\nb\n"), computeTag("a\nc\n"));
	assert.match(computeTag("a\nb\n"), /^[0-9A-F]{4}$/);
});

test("decode and encode round-trip CRLF files and BOMs", () => {
	const decoded = decodeText("\uFEFFone\r\ntwo\r\n");

	assert.equal(decoded.bom, "\uFEFF");
	assert.equal(decoded.eol, "\r\n");
	assert.deepEqual(decoded.lines, ["one", "two"]);
	assert.equal(encodeText(decoded.content, decoded), "\uFEFFone\r\ntwo\r\n");
});

test("prepareEditArguments repairs common model slips", () => {
	const prepared = prepareEditArguments({
		file_path: "src/a.ts",
		tag: "[a1b2]",
		edits: JSON.stringify([{ op: "REPLACE", from: "3", to: "4", lines: "x\ny" }]),
	}) as Record<string, unknown>;

	assert.equal(prepared.path, "src/a.ts");
	assert.equal(prepared.file_path, undefined);
	assert.equal(prepared.tag, "A1B2");
	assert.deepEqual(prepared.edits, [{ op: "replace", from: 3, to: 4, lines: ["x", "y"] }]);
});
