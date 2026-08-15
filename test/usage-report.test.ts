import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildUsageRows,
	formatUsageReportText,
	formatUsageRowText,
	type UsageReport,
} from "../extensions/internal/usage-report.ts";
import type { UsageInfo } from "../extensions/internal/usage-status.ts";

const RESET_AT = "2025-06-05T14:00:00.000Z";

function anthropicUsage(): UsageInfo {
	return {
		provider: "anthropic",
		primaryLabel: "5h",
		primaryPercent: 42,
		primaryResetAt: RESET_AT,
		secondaryLabel: "weekly",
		secondaryPercent: 71,
		secondaryResetAt: RESET_AT,
		credits: {
			label: "extra usage",
			detail: "$12.34 / $100.00",
			usedPercent: 12.34,
			resetAt: RESET_AT,
		},
	};
}

test("buildUsageRows exposes primary, secondary and credit rows", () => {
	const rows = buildUsageRows(anthropicUsage());
	assert.deepEqual(
		rows.map((row) => [row.label, row.kind]),
		[
			["5h", "limit"],
			["weekly", "limit"],
			["extra usage", "credits"],
		],
	);
});

test("buildUsageRows honours hideSecondary and missing usage", () => {
	assert.equal(buildUsageRows(undefined).length, 0);

	const rows = buildUsageRows({
		provider: "anthropic",
		primaryLabel: "extra usage",
		primaryPercent: 5,
		secondaryLabel: "",
		secondaryPercent: null,
		hideSecondary: true,
	});
	assert.deepEqual(
		rows.map((row) => row.label),
		["extra usage"],
	);
});

test("formatUsageRowText reports remaining share, details and reset time", () => {
	const row = buildUsageRows(anthropicUsage())[0];
	assert.ok(row);
	assert.match(formatUsageRowText(row), /^58% left · resets \d{2}:\d{2} on \d{2} \w{3}$/);
});

test("formatUsageRowText renders credits with their balance", () => {
	const credits = buildUsageRows(anthropicUsage())[2];
	assert.ok(credits);
	assert.match(formatUsageRowText(credits), /^88% left \(\$12\.34 \/ \$100\.00\)/);

	assert.equal(
		formatUsageRowText({ label: "credits", kind: "credits", usedPercent: null, detail: "1,234 left" }),
		"1,234 left",
	);
});

test("formatUsageRowText marks unlimited and unavailable quotas", () => {
	assert.equal(formatUsageRowText({ label: "chat", kind: "limit", usedPercent: null, text: "∞" }), "unlimited");
	assert.equal(formatUsageRowText({ label: "weekly", kind: "limit", usedPercent: null }), "unavailable");
});

test("formatUsageReportText renders a self-contained report for non-TUI clients", () => {
	const report: UsageReport = {
		providers: [
			{
				provider: "anthropic",
				providerLabel: "anthropic",
				account: "user@example.com (Max)",
				current: true,
				rows: buildUsageRows(anthropicUsage()),
			},
			{
				provider: "github-copilot",
				providerLabel: "github",
				account: "octocat (Individual)",
				rows: [],
				error: "HTTP 401",
			},
		],
	};

	const text = formatUsageReportText(report);
	const [header, anthropicBlock, copilotBlock] = text.split("\n\n");

	assert.equal(header, "Usage limits · 2 providers");
	assert.ok(anthropicBlock);
	assert.equal(anthropicBlock.split("\n")[0], "anthropic · user@example.com (Max) · current model");
	assert.equal(anthropicBlock.split("\n").length, 4);
	assert.match(anthropicBlock, /\n- 5h: 58% left/);
	assert.match(anthropicBlock, /\n- extra usage: 88% left \(\$12\.34 \/ \$100\.00\)/);
	assert.equal(copilotBlock, "github · octocat (Individual)\n- unavailable: HTTP 401");
});

test("formatUsageReportText explains an empty report", () => {
	const text = formatUsageReportText({ providers: [], notice: "No provider is logged in." });
	assert.equal(text, "Usage limits · 0 providers\n\nNo provider is logged in.");
});
