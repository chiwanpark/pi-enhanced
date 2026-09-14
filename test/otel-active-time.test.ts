import assert from "node:assert/strict";
import { test } from "node:test";
import { ActiveTimeTracker } from "../extensions/internal/otel/active-time.ts";

test("the first interaction has no measurable span", () => {
	const tracker = new ActiveTimeTracker();
	assert.equal(tracker.noteUserActivity(1_000), 0);
});

test("short gaps between keystrokes count as user active time", () => {
	const tracker = new ActiveTimeTracker();
	tracker.noteUserActivity(0);
	assert.equal(tracker.noteUserActivity(2_500), 2.5);
	assert.equal(tracker.noteUserActivity(3_000), 0.5);
});

test("gaps at or beyond the five second timeout are dropped like claude code", () => {
	const tracker = new ActiveTimeTracker();
	tracker.noteUserActivity(0);
	assert.equal(tracker.noteUserActivity(5_000), 0);
	assert.equal(tracker.noteUserActivity(9_999), 4.999);
	assert.equal(tracker.noteUserActivity(30_000), 0);
});

test("the timeout is configurable", () => {
	const tracker = new ActiveTimeTracker({ userActivityTimeoutMs: 60_000 });
	tracker.noteUserActivity(0);
	assert.equal(tracker.noteUserActivity(20_000), 20);
});

test("cli spans measure start to end", () => {
	const tracker = new ActiveTimeTracker();
	tracker.startCli(1_000);
	assert.equal(tracker.endCli(4_000), 3);
});

test("nested cli spans only report the outermost span", () => {
	const tracker = new ActiveTimeTracker();
	tracker.startCli(0);
	tracker.startCli(500);
	assert.equal(tracker.endCli(1_000), 0);
	assert.equal(tracker.endCli(2_000), 2);
});

test("ending a cli span without a start reports nothing", () => {
	const tracker = new ActiveTimeTracker();
	assert.equal(tracker.endCli(1_000), 0);
});

test("typing while the cli works is not credited as user time", () => {
	const tracker = new ActiveTimeTracker();
	tracker.noteUserActivity(0);
	tracker.startCli(1_000);
	assert.equal(tracker.noteUserActivity(2_000), 0);
	assert.equal(tracker.endCli(30_000), 29);
	assert.equal(tracker.noteUserActivity(31_000), 0);
	assert.equal(tracker.noteUserActivity(32_000), 1);
});

test("flush closes an open cli span", () => {
	const tracker = new ActiveTimeTracker();
	tracker.startCli(0);
	tracker.startCli(100);
	assert.equal(tracker.flushCli(5_000), 5);
	assert.equal(tracker.flushCli(6_000), 0);
});
