import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { drawBox, getPackageVersion, withHomeTilde } from "./internal/common";
import {
	loadUsageResult,
	normalizeProvider,
	PROVIDER_META,
	readUsageAuth,
	refreshUsageAuthIfNeeded,
	type SupportedProvider,
	type UsageInfo,
} from "./internal/usage-status";

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

type OpenAICodexTokenPayload = {
	"https://api.openai.com/auth"?: {
		chatgpt_plan_type?: string;
		chatgpt_account_id?: string;
	};
	"https://api.openai.com/profile"?: {
		email?: string;
	};
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

function decodeJwtPayload<T>(token: string): T | null {
	const parts = token.split(".");
	if (parts.length < 2) return null;

	try {
		const payload = parts[1] ?? "";
		const normalized = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
		const json = Buffer.from(normalized, "base64url").toString("utf8");
		return JSON.parse(json) as T;
	} catch {
		return null;
	}
}

function formatOpenAIPlan(plan: string | undefined): string {
	switch (plan) {
		case "team":
		case "business":
			return "Business";
		case "enterprise":
			return "Enterprise";
		case "pro":
			return "Pro";
		case "plus":
			return "Plus";
		case "free":
			return "Free";
		default:
			return "Unknown";
	}
}

function formatCopilotPlan(plan: string | undefined): string {
	switch (plan) {
		case "individual":
			return "Individual";
		case "business":
			return "Business";
		case "enterprise":
			return "Enterprise";
		default:
			return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "Unknown";
	}
}

async function loadAccountSummary(provider: SupportedProvider | null): Promise<string> {
	if (!provider) return "<unsupported provider>";

	const auth = readUsageAuth();
	if (!auth) return "<not logged in>";

	if (provider === "openai-codex") {
		const refreshed = await refreshUsageAuthIfNeeded(auth, provider).catch(() => auth);
		const token = refreshed[provider]?.access ?? auth[provider]?.access;
		if (!token) return "<not logged in>";
		const payload = decodeJwtPayload<OpenAICodexTokenPayload>(token);
		const email = payload?.["https://api.openai.com/profile"]?.email;
		const plan = formatOpenAIPlan(payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type);
		const identity = email ?? payload?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? "OpenAI account";
		return `${identity} (${plan})`;
	}

	if (provider === "google-gemini-cli") {
		const entry = auth[provider] as ({ email?: string } & Record<string, unknown>) | undefined;
		const email = typeof entry?.email === "string" ? entry.email : undefined;
		return email ? `${email} (Google)` : "Google account";
	}

	if (provider === "anthropic") {
		const entry = auth[provider] as ({ email?: string; plan?: string } & Record<string, unknown>) | undefined;
		const email = typeof entry?.email === "string" ? entry.email : undefined;
		const plan = typeof entry?.plan === "string" ? entry.plan : undefined;
		if (email && plan) return `${email} (${plan})`;
		if (email) return `${email} (Claude)`;
		return "Claude account";
	}

	const githubToken = auth[provider]?.refresh;
	if (!githubToken) return "<not logged in>";

	try {
		const response = await fetch("https://api.github.com/copilot_internal/user", {
			headers: {
				Authorization: `token ${githubToken}`,
				Accept: "application/json",
				"Editor-Version": "vscode/1.96.2",
				"Editor-Plugin-Version": "copilot-chat/0.26.7",
				"User-Agent": "GitHubCopilotChat/0.26.7",
				"X-Github-Api-Version": "2025-04-01",
			},
		});
		if (!response.ok) return "GitHub Copilot account";
		const data = (await response.json()) as {
			login?: string;
			copilot_plan?: string;
		};
		return `${data.login ?? "GitHub user"} (${formatCopilotPlan(data.copilot_plan)})`;
	} catch {
		return "GitHub Copilot account";
	}
}

function formatModelSummary(pi: ExtensionAPI, model: { id: string; reasoning: boolean } | undefined): string {
	if (!model) return "no-model";
	const reasoning = model.reasoning ? pi.getThinkingLevel() : "off";
	return `${model.id} (reasoning ${reasoning})`;
}

function formatResetAt(resetAt: string | undefined): string {
	if (!resetAt) return "";
	const date = new Date(resetAt);
	if (Number.isNaN(date.getTime())) return "";

	const time = new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date);
	const day = new Intl.DateTimeFormat("en-GB", {
		day: "2-digit",
		month: "short",
	}).format(date);
	return ` (resets ${time} on ${day})`;
}

function colorForRemaining(themeValue: number | null | undefined): "success" | "warning" | "error" | "dim" {
	if (themeValue == null || !Number.isFinite(themeValue)) return "dim";
	if (themeValue <= 10) return "error";
	if (themeValue <= 30) return "warning";
	return "success";
}

function renderRemainingBar(theme: Theme, remaining: number | null | undefined, width = 20): string {
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

function formatUsageLine(
	theme: Theme,
	usedPercent: number | null | undefined,
	resetAt: string | undefined,
	textOverride?: string | undefined,
	detail?: string | undefined,
): string {
	const detailSuffix = detail ? ` ${theme.fg("dim", `(${detail})`)}` : "";

	if (textOverride === "∞") {
		return `${renderRemainingBar(theme, 100)} ${theme.fg("success", "∞ left")}${detailSuffix}`;
	}

	if (usedPercent == null || !Number.isFinite(usedPercent)) {
		return `${theme.fg("warning", "unavailable")}${detailSuffix}`;
	}

	const remaining = Math.max(0, Math.min(100, 100 - usedPercent));
	const remainingText = `${Math.round(remaining)}% left`;
	return [
		renderRemainingBar(theme, remaining),
		theme.fg(colorForRemaining(remaining), remainingText),
		theme.fg("dim", formatResetAt(resetAt)),
	]
		.join(" ")
		.trimEnd()
		.concat(detailSuffix);
}

function buildStatusBox(theme: Theme, report: StatusReport): string[] {
	const usage = report.usage;
	const usageMeta = usage ? PROVIDER_META[usage.provider] : undefined;
	// Prefer the runtime labels on UsageInfo when present so plan-specific cases
	// (e.g. Anthropic Enterprise extra usage) can override the static metadata.
	const primaryLabelText = usage?.primaryLabel || usageMeta?.primaryLabel || "Primary";
	const secondaryLabelText = usage?.secondaryLabel || usageMeta?.secondaryLabel || "Secondary";
	const primaryLabel = `${primaryLabelText} limit:`;
	const secondaryLabel = `${secondaryLabelText} limit:`;
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
		{
			label: primaryLabel,
			value: usage
				? formatUsageLine(theme, usage.primaryPercent, usage.primaryResetAt, usage.primaryText, usage.primaryDetail)
				: theme.fg("warning", report.usageError ?? "unavailable"),
		},
	];
	if (!usage?.hideSecondary) {
		rows.push({
			label: secondaryLabel,
			value: usage
				? formatUsageLine(
						theme,
						usage.secondaryPercent,
						usage.secondaryResetAt,
						usage.secondaryText,
						usage.secondaryDetail,
					)
				: theme.fg("warning", report.usageError ?? "unavailable"),
		});
	}

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
	pi.registerMessageRenderer<StatusReport>("status-report", (message, { outputPad }, theme) => {
		const report = message.details;
		if (!report) {
			return new Text(theme.fg("warning", "Status unavailable"), outputPad, 0);
		}
		return new Text(buildStatusBox(theme, report).join("\n"), outputPad, 0);
	});

	pi.registerCommand("status", {
		description: "Show current agent status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("status requires interactive UI", "error");
				return;
			}

			const report = await buildStatusReport(ctx, pi).catch(() => null);

			if (!report) {
				ctx.ui.notify("Could not load status", "warning");
				return;
			}

			pi.sendMessage({
				customType: "status-report",
				content: "status",
				display: true,
				details: report,
			});
		},
	});
}
