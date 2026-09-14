import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_DIFFED_FILE_BYTES, readTextForDiff } from "../extensions/internal/otel/observe.ts";

async function sandbox(): Promise<string> {
	return mkdtemp(join(tmpdir(), "otel-observe-"));
}

test("diff snapshots treat a missing file as empty and skip unreadable content", async () => {
	const dir = await sandbox();
	try {
		assert.equal(await readTextForDiff(join(dir, "new.ts")), "");

		const text = join(dir, "text.ts");
		await writeFile(text, "line\n", "utf8");
		assert.equal(await readTextForDiff(text), "line\n");

		const binary = join(dir, "image.bin");
		await writeFile(binary, Buffer.from([0x89, 0x50, 0x00, 0x01]));
		assert.equal(await readTextForDiff(binary), undefined);

		assert.equal(await readTextForDiff(dir), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the diff size cap keeps large files out of the lines metric", async () => {
	const dir = await sandbox();
	try {
		const big = join(dir, "big.txt");
		await writeFile(big, "x".repeat(MAX_DIFFED_FILE_BYTES + 1), "utf8");
		assert.equal(await readTextForDiff(big), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
