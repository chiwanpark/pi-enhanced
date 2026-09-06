import assert from "node:assert/strict";
import test from "node:test";
import { applyHashlineEdits, collectSeenAfterEdit, HashlineEditError } from "../extensions/internal/hashline/apply.ts";
import { SnapshotStore } from "../extensions/internal/hashline/store.ts";

const SOURCE = ["one", "two", "three", "four", "five"].join("\n") + "\n";

function snapshotOf(content = SOURCE, seen: "all" | { from: number; to: number }[] = "all") {
	const store = new SnapshotStore();
	const snapshot = store.record("/tmp/file.ts", content, seen);
	assert.ok(snapshot);
	return snapshot;
}

test("replace swaps an inclusive range", () => {
	const result = applyHashlineEdits(snapshotOf(), [{ op: "replace", from: 2, to: 3, lines: ["TWO"] }]);

	assert.equal(result.content, "one\nTWO\nfour\nfive\n");
	assert.deepEqual(result.regions, [{ from: 2, to: 2 }]);
	assert.equal(result.addedLines, 1);
	assert.equal(result.removedLines, 2);
});

test("replace defaults to a single line when to is omitted", () => {
	const result = applyHashlineEdits(snapshotOf(), [{ op: "replace", from: 1, lines: ["ONE"] }]);

	assert.equal(result.content, "ONE\ntwo\nthree\nfour\nfive\n");
});

test("delete removes the range without lines", () => {
	const result = applyHashlineEdits(snapshotOf(), [{ op: "delete", from: 2, to: 4 }]);

	assert.equal(result.content, "one\nfive\n");
	assert.deepEqual(result.regions, [{ from: 2, to: 1 }]);
});

test("insert_before and insert_after place lines around the anchor", () => {
	const before = applyHashlineEdits(snapshotOf(), [{ op: "insert_before", from: 1, lines: ["zero"] }]);
	const after = applyHashlineEdits(snapshotOf(), [{ op: "insert_after", from: 5, lines: ["six"] }]);

	assert.equal(before.content, "zero\none\ntwo\nthree\nfour\nfive\n");
	assert.equal(after.content, "one\ntwo\nthree\nfour\nfive\nsix\n");
});

test("insert_after 0 prepends to the file", () => {
	const result = applyHashlineEdits(snapshotOf(), [{ op: "insert_after", from: 0, lines: ["zero"] }]);

	assert.equal(result.content, "zero\none\ntwo\nthree\nfour\nfive\n");
});

test("multiple edits address the original numbering", () => {
	const result = applyHashlineEdits(snapshotOf(), [
		{ op: "replace", from: 1, lines: ["ONE"] },
		{ op: "insert_after", from: 2, lines: ["extra"] },
		{ op: "delete", from: 4, to: 4 },
	]);

	assert.equal(result.content, "ONE\ntwo\nextra\nthree\nfive\n");
	assert.equal(result.regions.length, 3);
});

test("edits are applied regardless of the order they are listed", () => {
	const forward = applyHashlineEdits(snapshotOf(), [
		{ op: "replace", from: 1, lines: ["A"] },
		{ op: "replace", from: 5, lines: ["E"] },
	]);
	const reversed = applyHashlineEdits(snapshotOf(), [
		{ op: "replace", from: 5, lines: ["E"] },
		{ op: "replace", from: 1, lines: ["A"] },
	]);

	assert.equal(forward.content, reversed.content);
	assert.equal(forward.content, "A\ntwo\nthree\nfour\nE\n");
});

test("a file without a trailing newline keeps its shape", () => {
	const result = applyHashlineEdits(snapshotOf("one\ntwo"), [{ op: "replace", from: 2, lines: ["TWO"] }]);

	assert.equal(result.content, "one\nTWO");
});

test("overlapping ranges are rejected", () => {
	assert.throws(
		() =>
			applyHashlineEdits(snapshotOf(), [
				{ op: "replace", from: 1, to: 3, lines: ["x"] },
				{ op: "replace", from: 3, to: 4, lines: ["y"] },
			]),
		(error: unknown) => error instanceof HashlineEditError && error.code === "E_OVERLAP",
	);
});

test("two inserts at the same gap are rejected", () => {
	assert.throws(
		() =>
			applyHashlineEdits(snapshotOf(), [
				{ op: "insert_after", from: 2, lines: ["a"] },
				{ op: "insert_after", from: 2, lines: ["b"] },
			]),
		(error: unknown) => error instanceof HashlineEditError && error.code === "E_OVERLAP",
	);
});

test("an insert at the boundary of a replaced range is allowed", () => {
	const result = applyHashlineEdits(snapshotOf(), [
		{ op: "insert_after", from: 2, lines: ["extra"] },
		{ op: "replace", from: 3, to: 3, lines: ["THREE"] },
	]);

	assert.equal(result.content, "one\ntwo\nextra\nTHREE\nfour\nfive\n");
});

test("out of bounds ranges are rejected", () => {
	assert.throws(
		() => applyHashlineEdits(snapshotOf(), [{ op: "replace", from: 5, to: 9, lines: ["x"] }]),
		(error: unknown) => error instanceof HashlineEditError && error.code === "E_BAD_RANGE",
	);
	assert.throws(
		() => applyHashlineEdits(snapshotOf(), [{ op: "insert_after", from: 6, lines: ["x"] }]),
		(error: unknown) => error instanceof HashlineEditError && error.code === "E_BAD_RANGE",
	);
});

test("reversed ranges are rejected", () => {
	assert.throws(
		() => applyHashlineEdits(snapshotOf(), [{ op: "replace", from: 4, to: 2, lines: ["x"] }]),
		(error: unknown) => error instanceof HashlineEditError && error.code === "E_BAD_RANGE",
	);
});

test("delete carrying lines is rejected", () => {
	assert.throws(
		() => applyHashlineEdits(snapshotOf(), [{ op: "delete", from: 1, lines: ["x"] }]),
		(error: unknown) => error instanceof HashlineEditError && error.code === "E_BAD_OP",
	);
});

test("inserts without lines are rejected", () => {
	assert.throws(
		() => applyHashlineEdits(snapshotOf(), [{ op: "insert_after", from: 1, lines: [] }]),
		(error: unknown) => error instanceof HashlineEditError && error.code === "E_BAD_OP",
	);
});

test("identical content is rejected", () => {
	assert.throws(
		() => applyHashlineEdits(snapshotOf(), [{ op: "replace", from: 2, lines: ["two"] }]),
		(error: unknown) => error instanceof HashlineEditError && error.code === "E_NO_CHANGE",
	);
});

test("emptying a file is rejected", () => {
	assert.throws(
		() => applyHashlineEdits(snapshotOf(), [{ op: "delete", from: 1, to: 5 }]),
		(error: unknown) => error instanceof HashlineEditError && error.code === "E_WOULD_EMPTY",
	);
});

test("edits into never displayed lines are rejected", () => {
	const snapshot = snapshotOf(SOURCE, [{ from: 1, to: 2 }]);

	assert.throws(
		() => applyHashlineEdits(snapshot, [{ op: "replace", from: 4, lines: ["x"] }]),
		(error: unknown) => error instanceof HashlineEditError && error.code === "E_UNSEEN",
	);
	assert.doesNotThrow(() => applyHashlineEdits(snapshot, [{ op: "replace", from: 2, lines: ["x"] }]));
});

test("no edits are rejected", () => {
	assert.throws(
		() => applyHashlineEdits(snapshotOf(), []),
		(error: unknown) => error instanceof HashlineEditError && error.code === "E_NO_EDITS",
	);
});

test("seen ranges are carried across an edit that shifts lines", () => {
	const snapshot = snapshotOf();
	const result = applyHashlineEdits(snapshot, [{ op: "insert_after", from: 1, lines: ["a", "b"] }]);

	assert.deepEqual(collectSeenAfterEdit(snapshot, result.spans), [
		{ from: 1, to: 1 },
		{ from: 4, to: 7 },
	]);
});

test("seen ranges drop the replaced lines", () => {
	const snapshot = snapshotOf();
	const result = applyHashlineEdits(snapshot, [{ op: "replace", from: 2, to: 3, lines: ["X"] }]);

	assert.deepEqual(collectSeenAfterEdit(snapshot, result.spans), [
		{ from: 1, to: 1 },
		{ from: 3, to: 4 },
	]);
});
