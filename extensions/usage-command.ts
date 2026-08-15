import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { drawBox } from "./internal/common";
import { loadAccountSummary } from "./internal/provider-account";
import {
	buildUsageRows,
	formatUsageReportText,
	renderUsageRowValue,
	type ProviderUsageReport,
	type UsageReport,
} from "./internal/usage-report";
import {
	listAuthenticatedProviders,
	loadUsageResult,
	normalizeProvider,
	PROVIDER_META,
	readUsageAuth,
	type SupportedProvider,
} from "./internal/usage-status";

const CUSTOM_TYPE = "usage-report";
const NO_PROVIDERS_NOTICE = "No provider is logged in. Run /login <provider> to connect one.";
const BAR_WIDTH = 16;

async function buildProviderReport(provider: SupportedProvider, current: boolean): Promise<ProviderUsageReport> {
	const [usageResult, account] = await Promise.all([
		loadUsageResult(provider),
		loadAccountSummary(provider).catch(() => undefined),
	]);

	return {
		provider,
		providerLabel: PROVIDER_META[provider].providerLabel,
		account,
		current,
		rows: buildUsageRows(usageResult.usage),
		error: usageResult.error,
	};
}

async function buildUsageReport(activeProvider: SupportedProvider | null): Promise<UsageReport> {
	const providers = listAuthenticatedProviders(readUsageAuth());
	if (providers.length === 0) {
		return { providers: [], notice: NO_PROVIDERS_NOTICE };
	}

	// Requests run in parallel; token refreshes are serialized inside usage-status.
	const reports = await Promise.all(
		providers.map((provider) => buildProviderReport(provider, provider === activeProvider)),
	);
	return { providers: reports };
}

function renderProviderHeader(theme: Theme, provider: ProviderUsageReport): string {
	const parts = [theme.bold(provider.providerLabel)];
	if (provider.account) parts.push(theme.fg("muted", provider.account));
	if (provider.current) parts.push(theme.fg("accent", "current model"));
	return parts.join(theme.fg("dim", " · "));
}

function buildUsageBox(theme: Theme, report: UsageReport): string[] {
	const labels = report.providers.flatMap((provider) => provider.rows.map((row) => row.label.length));
	const labelWidth = Math.max(...labels, 8) + 2;
	const lines: string[] = [`${theme.fg("dim", ">_")} ${theme.bold("Usage limits")}`, ""];

	report.providers.forEach((provider, index) => {
		if (index > 0) lines.push("");
		lines.push(renderProviderHeader(theme, provider));

		if (provider.rows.length === 0) {
			lines.push(`  ${theme.fg("warning", provider.error ?? "no usage data")}`);
			return;
		}

		for (const row of provider.rows) {
			lines.push(`  ${theme.fg("dim", row.label.padEnd(labelWidth))}${renderUsageRowValue(theme, row, BAR_WIDTH)}`);
		}
	});

	if (report.notice) {
		if (report.providers.length > 0) lines.push("");
		lines.push(theme.fg("warning", report.notice));
	}

	return drawBox(theme, lines, { indent: " ", paddingX: 1 });
}

export default function usageCommandExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer<UsageReport>(CUSTOM_TYPE, (message, { outputPad }, theme) => {
		const report = message.details;
		if (!report) {
			return new Text(theme.fg("warning", "Usage unavailable"), outputPad, 0);
		}
		return new Text(buildUsageBox(theme, report).join("\n"), outputPad, 0);
	});

	// The report is for the user only; keep it out of the model context.
	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== CUSTOM_TYPE),
	}));

	pi.registerCommand("usage", {
		description: "Show API usage limits and credits for every logged-in provider",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("usage", "loading usage…");

			let report: UsageReport;
			try {
				report = await buildUsageReport(normalizeProvider(ctx.model?.provider));
			} catch (error) {
				ctx.ui.notify(`Could not load usage: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			} finally {
				ctx.ui.setStatus("usage", undefined);
			}

			// Custom messages emit RPC message events, unlike custom entries. Waiting
			// avoids turning this display-only response into a steering message.
			await ctx.waitForIdle();
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				// Non-TUI clients (Paseo and other ACP/RPC front-ends) render `content`
				// verbatim, so it carries the whole report as readable text.
				content: formatUsageReportText(report),
				display: true,
				details: report,
			});
		},
	});
}
