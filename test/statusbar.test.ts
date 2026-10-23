import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadStatusbarConfig } from "../extensions/statusbar.ts";

async function withProjectSettings(settings: unknown, run: (dir: string) => void): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "statusbar-"));
	try {
		await mkdir(join(dir, ".pi"), { recursive: true });
		await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify(settings), "utf-8");
		run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function intervalSettings(value: unknown): unknown {
	return { piEnhanced: { statusbar: { usageRefreshIntervalMs: value } } };
}

test("project settings set the usage refresh interval", async () => {
	await withProjectSettings(intervalSettings(300_000), (dir) => {
		assert.equal(loadStatusbarConfig(dir).usageRefreshIntervalMs, 300_000);
	});
});

test("zero usage refresh interval disables periodic refresh", async () => {
	await withProjectSettings(intervalSettings(0), (dir) => {
		assert.equal(loadStatusbarConfig(dir).usageRefreshIntervalMs, 0);
	});
});

test("fractional usage refresh intervals are floored", async () => {
	await withProjectSettings(intervalSettings(1500.7), (dir) => {
		assert.equal(loadStatusbarConfig(dir).usageRefreshIntervalMs, 1500);
	});
});

test("invalid usage refresh intervals are ignored", async () => {
	for (const value of [-1, "60000", null, true]) {
		await withProjectSettings(intervalSettings(value), (dir) => {
			const fallback = loadStatusbarConfig(join(dir, "missing")).usageRefreshIntervalMs;
			assert.equal(loadStatusbarConfig(dir).usageRefreshIntervalMs, fallback);
		});
	}
});
