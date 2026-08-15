import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SupportedProvider, UsageInfo } from "./usage-status";

/** A single limit/credit line, shared by the plain-text and TUI renderings. */
export type UsageRow = {
	label: string;
	/** "limit" rows report a rolling window, "credits" rows report a balance. */
	kind: "limit" | "credits";
	usedPercent: number | null | undefined;
	resetAt?: string | undefined;
	/** Replaces the computed percentage, e.g. "∞" for unlimited quotas. */
	text?: string | undefined;
	/** Extra context such as "$12.34 / $100.00". */
	detail?: string | undefined;
};

export type ProviderUsageReport = {
	provider: SupportedProvider;
	providerLabel: string;
	/** Account line, e.g. "user@example.com (Pro)". */
	account?: string | undefined;
	/** True for the provider backing the currently selected model. */
	current?: boolean | undefined;
	rows: UsageRow[];
	error?: string | undefined;
};

export type UsageReport = {
	providers: ProviderUsageReport[];
	/** Explains an empty report, e.g. when no provider is logged in. */
	notice?: string | undefined;
};

const UNLIMITED_TEXTS = new Set(["∞", "unlimited"]);

export function formatResetTimestamp(resetAt: string | undefined): string | null {
	if (!resetAt) return null;
	const date = new Date(resetAt);
	if (Number.isNaN(date.getTime())) return null;

	const time = new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date);
	const day = new Intl.DateTimeFormat("en-GB", {
		day: "2-digit",
		month: "short",
	}).format(date);
	return `${time} on ${day}`;
}

/** " (resets 14:00 on 05 Jun)", or "" when the reset time is unknown. */
export function formatResetSuffix(resetAt: string | undefined): string {
	const timestamp = formatResetTimestamp(resetAt);
	return timestamp ? ` (resets ${timestamp})` : "";
}

export function colorForRemaining(value: number | null | undefined): "success" | "warning" | "error" | "dim" {
	if (value == null || !Number.isFinite(value)) return "dim";
	if (value <= 10) return "error";
	if (value <= 30) return "warning";
	return "success";
}

function remainingPercent(usedPercent: number | null | undefined): number | null {
	if (usedPercent == null || !Number.isFinite(usedPercent)) return null;
	return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function renderRemainingBar(theme: Theme, remaining: number | null | undefined, width = 20): string {
	if (remaining == null || !Number.isFinite(remaining)) {
		return theme.fg("dim", `[${"░".repeat(width)}]`);
	}

	const clamped = Math.max(0, Math.min(100, remaining));
	const filled = Math.round((clamped / 100) * width);
	const color = colorForRemaining(clamped);
	return (
		theme.fg("dim", "[") +
		theme.fg(color, "█".repeat(filled)) +
		theme.fg("dim", "░".repeat(Math.max(0, width - filled))) +
		theme.fg("dim", "]")
	);
}

/** Themed value column for a single row: bar, remaining share, reset time and detail. */
export function renderUsageRowValue(theme: Theme, row: UsageRow, barWidth = 20): string {
	const detailSuffix = row.detail ? ` ${theme.fg("dim", `(${row.detail})`)}` : "";

	if (row.text && UNLIMITED_TEXTS.has(row.text)) {
		return `${renderRemainingBar(theme, 100, barWidth)} ${theme.fg("success", "∞ left")}${detailSuffix}`;
	}

	const remaining = remainingPercent(row.usedPercent);
	if (remaining == null) {
		if (row.kind === "credits" && row.detail) {
			return theme.fg("text", row.detail);
		}
		return `${theme.fg("warning", row.text ?? "unavailable")}${detailSuffix}`;
	}

	const bar = renderRemainingBar(theme, remaining, barWidth);
	const share = theme.fg(colorForRemaining(remaining), `${Math.round(remaining)}% left`);
	const resetSuffix = theme.fg("dim", formatResetSuffix(row.resetAt));
	return `${bar} ${share}${detailSuffix}${resetSuffix}`;
}

/** Plain-text value column, used for clients that cannot render TUI components. */
export function formatUsageRowText(row: UsageRow): string {
	const parts: string[] = [];

	if (row.text && UNLIMITED_TEXTS.has(row.text)) {
		parts.push("unlimited");
	} else {
		const remaining = remainingPercent(row.usedPercent);
		if (remaining == null) {
			if (!(row.kind === "credits" && row.detail)) parts.push(row.text ?? "unavailable");
		} else {
			parts.push(`${Math.round(remaining)}% left`);
		}
	}

	if (row.detail) {
		parts.push(parts.length > 0 ? `(${row.detail})` : row.detail);
	}

	const reset = formatResetTimestamp(row.resetAt);
	const value = parts.join(" ");
	return reset ? `${value} · resets ${reset}` : value;
}

/** Flattens a provider's usage payload into the rows both renderers consume. */
export function buildUsageRows(usage: UsageInfo | undefined): UsageRow[] {
	if (!usage) return [];

	const rows: UsageRow[] = [
		{
			label: usage.primaryLabel || "primary",
			kind: usage.primaryKind ?? "limit",
			usedPercent: usage.primaryPercent,
			resetAt: usage.primaryResetAt,
			text: usage.primaryText,
			detail: usage.primaryDetail,
		},
	];

	if (!usage.hideSecondary) {
		rows.push({
			label: usage.secondaryLabel || "secondary",
			kind: "limit",
			usedPercent: usage.secondaryPercent,
			resetAt: usage.secondaryResetAt,
			text: usage.secondaryText,
			detail: usage.secondaryDetail,
		});
	}

	for (const limit of usage.extra ?? []) {
		rows.push({
			label: limit.label,
			kind: "limit",
			usedPercent: limit.usedPercent,
			resetAt: limit.resetAt,
			detail: limit.detail,
		});
	}

	if (usage.credits) {
		rows.push({
			label: usage.credits.label,
			kind: "credits",
			usedPercent: usage.credits.usedPercent,
			resetAt: usage.credits.resetAt,
			detail: usage.credits.detail,
		});
	}

	return rows;
}

function formatProviderHeaderText(provider: ProviderUsageReport): string {
	const parts = [provider.providerLabel];
	if (provider.account) parts.push(provider.account);
	if (provider.current) parts.push("current model");
	return parts.join(" · ");
}

/**
 * Markdown/plain-text rendering of the whole report.
 *
 * This is the payload non-TUI clients (Paseo and other ACP/RPC front-ends) display,
 * so it must stay self-contained and readable without any custom renderer.
 */
export function formatUsageReportText(report: UsageReport): string {
	const providerCount = report.providers.length;
	const header = `Usage limits · ${providerCount} ${providerCount === 1 ? "provider" : "providers"}`;
	const blocks: string[] = [];

	for (const provider of report.providers) {
		const lines = [formatProviderHeaderText(provider)];
		if (provider.rows.length > 0) {
			lines.push(...provider.rows.map((row) => `- ${row.label}: ${formatUsageRowText(row)}`));
		} else {
			lines.push(`- unavailable: ${provider.error ?? "no usage data"}`);
		}
		blocks.push(lines.join("\n"));
	}

	if (report.notice) blocks.push(report.notice);
	if (blocks.length === 0) blocks.push("No usage information available.");

	return [header, ...blocks].join("\n\n");
}
