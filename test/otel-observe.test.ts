import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
	gitCommitsBetween,
	gitHead,
	MAX_DIFFED_FILE_BYTES,
	readTextForDiff,
} from "../extensions/internal/otel/observe.ts";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await run("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd });
	return stdout.trim();
}

async function sandbox(): Promise<string> {
	return mkdtemp(join(tmpdir(), "otel-observe-"));
}

test("head resolves inside a repository and stays undefined outside one", async () => {
	const dir = await sandbox();
	try {
		assert.equal(await gitHead(dir), undefined);
		await git(dir, ["init", "-q"]);
		// A repository without commits has no HEAD to report.
		assert.equal(await gitHead(dir), undefined);
		await git(dir, ["commit", "-q", "--allow-empty", "-m", "root"]);
		assert.match((await gitHead(dir)) ?? "", /^[0-9a-f]{40}$/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("commits between two revisions are listed oldest first", async () => {
	const dir = await sandbox();
	try {
		await git(dir, ["init", "-q"]);
		await git(dir, ["commit", "-q", "--allow-empty", "-m", "root"]);
		const before = await gitHead(dir);
		await git(dir, ["commit", "-q", "--allow-empty", "-m", "one"]);
		await git(dir, ["commit", "-q", "--allow-empty", "-m", "two"]);
		const after = await gitHead(dir);

		const created = await gitCommitsBetween(dir, before, after);
		assert.equal(created.length, 2);
		assert.equal(await git(dir, ["log", "-1", "--format=%s", created[0] ?? ""]), "one");
		assert.equal(await git(dir, ["log", "-1", "--format=%s", created[1] ?? ""]), "two");

		assert.deepEqual(await gitCommitsBetween(dir, after, after), []);
		assert.deepEqual(await gitCommitsBetween(dir, before, undefined), []);
		// A first commit in an empty repository counts as one commit.
		assert.deepEqual(await gitCommitsBetween(dir, undefined, after), [after]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

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
