import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchClaudeUsage, fetchCodexUsage } from "../extensions/internal/usage-status.ts";

const CODEX_AUTH = { "openai-codex": { type: "oauth" as const, access: "test-token" } };
const CLAUDE_AUTH = { anthropic: { type: "oauth" as const, access: "test-token" } };

function withStubbedFetch<T>(payload: unknown, run: () => Promise<T>): Promise<T> {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
	return run().finally(() => {
		globalThis.fetch = original;
	});
}

// Shape observed on a Business workspace: no rolling windows, credits in spend_control.
const BUSINESS_PAYLOAD = {
	plan_type: "business",
	rate_limit: null,
	credits: { has_credits: true, unlimited: false, balance: null },
	spend_control: {
		reached: false,
		individual_limit: {
			source: "group_based_spend_controls",
			limit: "4750",
			used: "360.87400114536285",
			remaining: "4389.125998854637",
			used_percent: 8,
			remaining_percent: 92,
			reset_after_seconds: 1458326,
			reset_at: 1788220800,
		},
	},
};

const PLAN_PAYLOAD = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 42, reset_after_seconds: 3600 },
		secondary_window: { used_percent: 71, reset_after_seconds: 86400 },
	},
	credits: { has_credits: true, unlimited: false, balance: 1234.5 },
};

test("codex credit-metered plans report the credit allowance as the only row", async () => {
	const usage = await withStubbedFetch(BUSINESS_PAYLOAD, () => fetchCodexUsage(CODEX_AUTH));

	assert.equal(usage.primaryLabel, "credits");
	assert.equal(usage.primaryKind, "credits");
	assert.equal(usage.hideSecondary, true);
	assert.equal(Math.round(usage.primaryPercent ?? -1), 8);
	assert.equal(usage.primaryDetail, "361 / 4,750 used");
	assert.equal(usage.primaryCompactDetail, "361/4.8k");
	assert.equal(usage.primaryResetAt, new Date(1788220800 * 1000).toISOString());
});

test("codex window-metered plans keep 5h/weekly and expose credits separately", async () => {
	const usage = await withStubbedFetch(PLAN_PAYLOAD, () => fetchCodexUsage(CODEX_AUTH));

	assert.equal(usage.primaryLabel, "5h");
	assert.equal(usage.primaryPercent, 42);
	assert.equal(usage.secondaryPercent, 71);
	assert.equal(usage.hideSecondary, undefined);
	assert.deepEqual(usage.credits, {
		label: "credits",
		detail: "1,235 left",
		compactDetail: "1.2k",
		usedPercent: null,
	});
});

test("codex usage without credits keeps the plain window rows", async () => {
	const usage = await withStubbedFetch({ plan_type: "pro", rate_limit: null }, () => fetchCodexUsage(CODEX_AUTH));

	assert.equal(usage.primaryLabel, "5h");
	assert.equal(usage.primaryPercent, null);
	assert.equal(usage.credits, undefined);
});

// Shape observed on a Claude subscription: model-scoped weekly limits only exist in `limits[]`.
const CLAUDE_PAYLOAD = {
	five_hour: { utilization: 8, resets_at: "2026-08-15T06:59:59.769265+00:00" },
	seven_day: { utilization: 29, resets_at: "2026-08-16T12:59:59.769290+00:00" },
	seven_day_opus: null,
	seven_day_sonnet: null,
	extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
	limits: [
		{ kind: "session", group: "session", percent: 8, resets_at: "2026-08-15T06:59:59.769265+00:00", scope: null },
		{ kind: "weekly_all", group: "weekly", percent: 29, resets_at: "2026-08-16T12:59:59.769290+00:00", scope: null },
		{
			kind: "weekly_scoped",
			group: "weekly",
			percent: 12,
			resets_at: "2026-08-16T12:59:59.769566+00:00",
			scope: { model: { id: null, display_name: "Fable" }, surface: null },
		},
	],
};

test("anthropic model-scoped weekly limits become extra rows", async () => {
	const usage = await withStubbedFetch(CLAUDE_PAYLOAD, () => fetchClaudeUsage(CLAUDE_AUTH));

	assert.equal(usage.primaryPercent, 8);
	assert.equal(usage.secondaryPercent, 29);
	assert.deepEqual(usage.extra, [
		{ label: "weekly (Fable)", usedPercent: 12, resetAt: "2026-08-16T12:59:59.769566+00:00" },
	]);
});

test("anthropic headline windows fall back to limits[] when the legacy fields are gone", async () => {
	const usage = await withStubbedFetch({ ...CLAUDE_PAYLOAD, five_hour: null, seven_day: null }, () =>
		fetchClaudeUsage(CLAUDE_AUTH),
	);

	assert.equal(usage.primaryPercent, 8);
	assert.equal(usage.primaryResetAt, "2026-08-15T06:59:59.769265+00:00");
	assert.equal(usage.secondaryPercent, 29);
	assert.equal(usage.hideSecondary, undefined);
	assert.equal(usage.extra?.length, 1);
});

test("anthropic falls back to legacy per-model buckets without limits[]", async () => {
	const usage = await withStubbedFetch(
		{
			five_hour: { utilization: 8, resets_at: "2026-08-15T06:59:59Z" },
			seven_day: { utilization: 29, resets_at: "2026-08-16T12:59:59Z" },
			seven_day_opus: { utilization: 40, resets_at: "2026-08-16T12:59:59Z" },
		},
		() => fetchClaudeUsage(CLAUDE_AUTH),
	);

	assert.deepEqual(usage.extra, [{ label: "weekly (Opus)", usedPercent: 40, resetAt: "2026-08-16T12:59:59Z" }]);
});
