import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	layoutStatusbarLines,
	loadStatusbarConfig,
	selectStatusbarLines,
	type StatusbarConfig,
} from "../extensions/statusbar.ts";

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

function linesSettings(value: unknown): unknown {
	return { piEnhanced: { statusbar: { lines: value } } };
}

test("project settings set the status bar lines", async () => {
	const layout = [
		["model", "usage"],
		["cwd", "branch", "context"],
	];
	await withProjectSettings(linesSettings(layout), (dir) => {
		assert.deepEqual(loadStatusbarConfig(dir).lines, layout);
	});
});

test("unknown segments and empty lines are dropped", async () => {
	await withProjectSettings(linesSettings([["model", "bogus", 3], [], ["nope"], ["context"]]), (dir) => {
		assert.deepEqual(loadStatusbarConfig(dir).lines, [["model"], ["context"]]);
	});
});

test("an empty lines array hides the status bar", async () => {
	await withProjectSettings(linesSettings([]), (dir) => {
		assert.deepEqual(loadStatusbarConfig(dir).lines, []);
	});
});

test("invalid lines settings are ignored", async () => {
	for (const value of ["model", ["model", "usage"], [["bogus"]], { model: true }]) {
		await withProjectSettings(linesSettings(value), (dir) => {
			const fallback = loadStatusbarConfig(join(dir, "missing")).lines;
			assert.deepEqual(loadStatusbarConfig(dir).lines, fallback);
		});
	}
});

test("layout joins segments per line and skips empty ones", () => {
	const lines = layoutStatusbarLines(
		[["model", "usage"], ["branch"], ["cwd", "branch", "context"]],
		{ model: "M", usage: null, cwd: "C", branch: undefined, context: "X" },
		" | ",
	);
	assert.deepEqual(lines, ["M", "C | X"]);
});

test("project settings set the compact layout and width", async () => {
	await withProjectSettings(
		{ piEnhanced: { statusbar: { compactLines: [["model"], ["context"]], compactWidth: 60.5 } } },
		(dir) => {
			const config = loadStatusbarConfig(dir);
			assert.deepEqual(config.compactLines, [["model"], ["context"]]);
			assert.equal(config.compactWidth, 60);
		},
	);
});

test("invalid compact width is ignored", async () => {
	for (const value of [-1, "60", null]) {
		await withProjectSettings({ piEnhanced: { statusbar: { compactWidth: value } } }, (dir) => {
			const fallback = loadStatusbarConfig(join(dir, "missing")).compactWidth;
			assert.equal(loadStatusbarConfig(dir).compactWidth, fallback);
		});
	}
});

test("compact layout is used only below the compact width", () => {
	const config: StatusbarConfig = {
		usageRefreshIntervalMs: 0,
		lines: [["model", "usage", "cwd"]],
		compactLines: [["model"], ["usage"]],
		compactWidth: 80,
	};
	assert.deepEqual(selectStatusbarLines(config, 79), [["model"], ["usage"]]);
	assert.deepEqual(selectStatusbarLines(config, 80), [["model", "usage", "cwd"]]);
	assert.deepEqual(selectStatusbarLines({ ...config, compactLines: undefined }, 40), [["model", "usage", "cwd"]]);
});
