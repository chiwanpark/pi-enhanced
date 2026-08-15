import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { drawBox, getPackageVersion, withHomeTilde } from "./internal/common";
import { loadAccountSummary } from "./internal/provider-account";
import { buildUsageRows, formatUsageRowText, renderUsageRowValue, type UsageRow } from "./internal/usage-report";
import { loadUsageResult, normalizeProvider, PROVIDER_META, type UsageInfo } from "./internal/usage-status";

const CUSTOM_TYPE = "status-report";

type StatusReport = {
	version: string;
	modelSummary: string;
	directory: string;
	agentsSummary: string;
	accountSummary: string;
	sessionId: string;
	usage?: UsageInfo | undefined;
	usageError?: string | undefined;
};

function discoverAgentsFiles(cwd: string): string[] {
	const files: string[] = [];
	const globalAgents = path.join(os.homedir(), ".pi", "agent", "AGENTS.md");
	if (existsSync(globalAgents)) {
		files.push(globalAgents);
	}

	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, "AGENTS.md");
		if (existsSync(candidate)) {
			files.push(candidate);
		}

		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return files;
}

function summarizeAgentsFiles(cwd: string): string {
	const files = discoverAgentsFiles(cwd).map(withHomeTilde);
	if (files.length === 0) return "<none>";
	if (files.length === 1) return files[0] ?? "<none>";
	return `${files[0]} (+${files.length - 1} more)`;
}

function formatModelSummary(pi: ExtensionAPI, model: { id: string; reasoning: boolean } | undefined): string {
	if (!model) return "no-model";
	const reasoning = model.reasoning ? pi.getThinkingLevel() : "off";
	return `${model.id} (reasoning ${reasoning})`;
}

/** Limit rows of the currently selected provider, labelled for the status box. */
function statusUsageRows(report: StatusReport): UsageRow[] {
	const usage = report.usage;
	const usageMeta = usage ? PROVIDER_META[usage.provider] : undefined;
	const rows = buildUsageRows(usage);
	if (rows.length > 0) return rows;

	// Keep the labelled placeholder rows when the lookup failed entirely.
	return [
		{ label: usageMeta?.primaryLabel ?? "Primary", kind: "limit", usedPercent: null },
		{ label: usageMeta?.secondaryLabel ?? "Secondary", kind: "limit", usedPercent: null },
	];
}

function buildStatusBox(theme: Theme, report: StatusReport): string[] {
	const usage = report.usage;
	const rows: Array<{ label: string; value: string }> = [
		{
			label: "Model:",
			value: report.modelSummary,
		},
		{
			label: "Directory:",
			value: report.directory,
		},
		{
			label: "AGENTS.md:",
			value: report.agentsSummary,
		},
		{
			label: "Account:",
			value: report.accountSummary,
		},
		{
			label: "Session:",
			value: report.sessionId,
		},
		{ label: "", value: "" },
		...statusUsageRows(report).map((row) => ({
			label: `${row.label}${row.kind === "limit" ? " limit" : ""}:`,
			value: usage ? renderUsageRowValue(theme, row) : theme.fg("warning", report.usageError ?? "unavailable"),
		})),
	];

	const labelWidth = Math.max(...rows.map((row) => row.label.length), 12) + 2;
	const contentLines = [
		`${theme.fg("dim", ">_")} ${theme.bold("Pi Enhanced")} ${theme.fg("dim", `(v${report.version})`)}`,
		"",
		...rows.map((row) => {
			if (!row.label) return "";
			return `${theme.fg("dim", row.label.padEnd(labelWidth))}${row.value}`;
		}),
	];

	return drawBox(theme, contentLines, {
		indent: " ",
		paddingX: 1,
	});
}

/**
 * Plain-text fallback shown by clients that cannot run the TUI renderer
 * (Paseo and other ACP/RPC front-ends render the message content verbatim).
 */
function formatStatusText(report: StatusReport): string {
	const lines = [
		`Pi Enhanced v${report.version}`,
		"",
		`- Model: ${report.modelSummary}`,
		`- Directory: ${report.directory}`,
		`- AGENTS.md: ${report.agentsSummary}`,
		`- Account: ${report.accountSummary}`,
		`- Session: ${report.sessionId}`,
	];

	for (const row of statusUsageRows(report)) {
		const label = `${row.label}${row.kind === "limit" ? " limit" : ""}`;
		lines.push(`- ${label}: ${report.usage ? formatUsageRowText(row) : (report.usageError ?? "unavailable")}`);
	}

	return lines.join("\n");
}

async function buildStatusReport(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<StatusReport> {
	const provider = normalizeProvider(ctx.model?.provider);
	const usageResult = provider ? await loadUsageResult(provider) : undefined;

	return {
		version: getPackageVersion(),
		modelSummary: formatModelSummary(pi, ctx.model ? { id: ctx.model.id, reasoning: ctx.model.reasoning } : undefined),
		directory: withHomeTilde(ctx.cwd),
		agentsSummary: summarizeAgentsFiles(ctx.cwd),
		accountSummary: await loadAccountSummary(provider),
		sessionId: ctx.sessionManager.getSessionId(),
		usage: usageResult?.usage,
		usageError: usageResult?.error,
	};
}

export default function statusCommandExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer<StatusReport>(CUSTOM_TYPE, (message, { outputPad }, theme) => {
		const report = message.details;
		if (!report) {
			return new Text(theme.fg("warning", "Status unavailable"), outputPad, 0);
		}
		return new Text(buildStatusBox(theme, report).join("\n"), outputPad, 0);
	});

	// The report is for the user only; keep it out of the model context.
	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== CUSTOM_TYPE),
	}));

	pi.registerCommand("status", {
		description: "Show current agent status",
		handler: async (_args, ctx) => {
			const report = await buildStatusReport(ctx, pi).catch(() => null);

			if (!report) {
				ctx.ui.notify("Could not load status", "warning");
				return;
			}

			// Custom messages emit RPC message events, unlike custom entries. Waiting
			// avoids turning this display-only response into a steering message.
			await ctx.waitForIdle();
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				// Non-TUI clients render `content` verbatim, so it carries the full report.
				content: formatStatusText(report),
				display: true,
				details: report,
			});
		},
	});
}
