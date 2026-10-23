import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readPiEnhancedSettings, withHomeTilde } from "./internal/common.ts";
import {
	loadUsage,
	normalizeProvider,
	PROVIDER_META,
	type SupportedProvider,
	type UsageInfo,
} from "./internal/usage-status.ts";

type ProviderRuntimeState = {
	loading: boolean;
	data?: UsageInfo | undefined;
	error?: string | undefined;
	updatedAt?: number | undefined;
};

const DEFAULT_USAGE_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_COMPACT_WIDTH = 80;

export const STATUSBAR_SEGMENTS = ["model", "usage", "cwd", "branch", "context"] as const;

export type StatusbarSegment = (typeof STATUSBAR_SEGMENTS)[number];

export type StatusbarConfig = {
	usageRefreshIntervalMs: number;
	lines: StatusbarSegment[][];
	compactLines?: StatusbarSegment[][] | undefined;
	compactWidth: number;
};

type StatusbarSettings = {
	usageRefreshIntervalMs?: unknown;
	lines?: unknown;
	compactLines?: unknown;
	compactWidth?: unknown;
};

function readNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function isStatusbarSegment(value: unknown): value is StatusbarSegment {
	return typeof value === "string" && (STATUSBAR_SEGMENTS as readonly string[]).includes(value);
}

function parseLines(value: unknown): StatusbarSegment[][] | undefined {
	if (!Array.isArray(value) || !value.every((line) => Array.isArray(line))) return undefined;
	const lines = (value as unknown[][]).map((line) => line.filter(isStatusbarSegment)).filter((line) => line.length > 0);
	if (lines.length === 0 && value.length > 0) return undefined;
	return lines;
}

export function loadStatusbarConfig(cwd: string): StatusbarConfig {
	const config: StatusbarConfig = {
		usageRefreshIntervalMs: DEFAULT_USAGE_REFRESH_INTERVAL_MS,
		lines: [[...STATUSBAR_SEGMENTS]],
		compactWidth: DEFAULT_COMPACT_WIDTH,
	};
	for (const section of readPiEnhancedSettings(cwd)) {
		const statusbar = (section as { statusbar?: StatusbarSettings }).statusbar;
		const interval = readNonNegativeInteger(statusbar?.usageRefreshIntervalMs);
		if (interval != null) config.usageRefreshIntervalMs = interval;
		const lines = parseLines(statusbar?.lines);
		if (lines) config.lines = lines;
		const compactLines = parseLines(statusbar?.compactLines);
		if (compactLines) config.compactLines = compactLines;
		const compactWidth = readNonNegativeInteger(statusbar?.compactWidth);
		if (compactWidth != null) config.compactWidth = compactWidth;
	}
	return config;
}

export function selectStatusbarLines(config: StatusbarConfig, width: number): StatusbarSegment[][] {
	return config.compactLines && width < config.compactWidth ? config.compactLines : config.lines;
}

export function layoutStatusbarLines(
	lines: readonly (readonly StatusbarSegment[])[],
	segments: Partial<Record<StatusbarSegment, string | null | undefined>>,
	separator: string,
): string[] {
	return lines
		.map((line) => line.map((segment) => segments[segment]).filter((text): text is string => Boolean(text)))
		.filter((texts) => texts.length > 0)
		.map((texts) => texts.join(separator));
}

function configIncludes(config: StatusbarConfig, segment: StatusbarSegment): boolean {
	return [...config.lines, ...(config.compactLines ?? [])].some((line) => line.includes(segment));
}

function clampPercent(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.max(0, Math.min(100, value));
}

function roundPercent(value: number | null | undefined): number | null {
	const clamped = clampPercent(value);
	return clamped == null ? null : Math.round(clamped);
}

function percentText(value: number | null | undefined): string | null {
	const rounded = roundPercent(value);
	return rounded == null ? null : `${rounded}%`;
}

function colorForPercent(value: number | null | undefined): "success" | "warning" | "error" | "dim" {
	const rounded = roundPercent(value);
	if (rounded == null) return "dim";
	if (rounded >= 90) return "error";
	if (rounded >= 70) return "warning";
	return "success";
}

function middleEllipsis(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	if (maxLength <= 1) return "…";
	const left = Math.ceil((maxLength - 1) / 2);
	const right = Math.floor((maxLength - 1) / 2);
	return `${text.slice(0, left)}…${text.slice(text.length - right)}`;
}

function formatCompactTokens(value: number): string {
	if (!Number.isFinite(value)) return "?";

	if (value % (1024 * 1024) === 0 && value >= 1024 * 1024) {
		return `${Math.round(value / (1024 * 1024))}M`;
	}
	if (value % 1024 === 0 && value >= 1024) {
		return `${Math.round(value / 1024)}K`;
	}
	if (value >= 1_000_000) {
		const millions = value / 1_000_000;
		return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (value >= 10_000) {
		return `${Math.round(value / 1_000)}K`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
	}
	return `${Math.round(value)}`;
}

function formatLimitPart(
	theme: Pick<Theme, "fg">,
	label: string | undefined,
	percent: number | null | undefined,
	textOverride: string | undefined,
	detail: string | undefined,
): string | null {
	const value = textOverride ?? percentText(percent);
	if (!value) return null;
	const labelPart = label ? `${theme.fg("dim", label)} ` : "";
	const detailPart = detail ? ` ${theme.fg("dim", detail)}` : "";
	return `${labelPart}${theme.fg(colorForPercent(percent), value)}${detailPart}`;
}

function formatUsageSegment(
	theme: Pick<Theme, "fg">,
	usage: UsageInfo | undefined,
	error: string | undefined,
): string | null {
	if (usage) {
		const parts: string[] = [];

		const primaryPart = formatLimitPart(
			theme,
			usage.primaryLabel,
			usage.primaryPercent,
			usage.primaryText,
			usage.primaryCompactDetail ?? usage.primaryDetail,
		);
		if (primaryPart) parts.push(primaryPart);

		if (!usage.hideSecondary) {
			const secondaryPart = formatLimitPart(
				theme,
				usage.secondaryLabel,
				usage.secondaryPercent,
				usage.secondaryText,
				usage.secondaryCompactDetail ?? usage.secondaryDetail,
			);
			if (secondaryPart) parts.push(secondaryPart);
		}

		if (parts.length === 0) return null;
		return parts.join(theme.fg("dim", " · "));
	}

	if (error) {
		return theme.fg("warning", "limits unavailable");
	}

	return theme.fg("dim", "limits …");
}

function formatContextSegment(
	theme: Pick<Theme, "fg">,
	percent: number | null | undefined,
	tokens: number | null | undefined,
	contextWindow: number | undefined,
): string | null {
	const hasPercent = typeof percent === "number" && Number.isFinite(percent);
	const hasTokens = typeof tokens === "number" && Number.isFinite(tokens);
	const hasWindow = typeof contextWindow === "number" && Number.isFinite(contextWindow);

	// If every component is unavailable, render nothing.
	if (!hasPercent && !hasTokens && !hasWindow) return null;

	const parts: string[] = [];
	if (hasPercent) {
		parts.push(theme.fg(colorForPercent(percent), `${Math.round(percent as number)}%`));
		parts.push(theme.fg("dim", "used"));
	}

	if (hasTokens && hasWindow) {
		parts.push(
			theme.fg("dim", `(${formatCompactTokens(tokens as number)} / ${formatCompactTokens(contextWindow as number)})`),
		);
	} else if (hasTokens) {
		parts.push(theme.fg("dim", `(${formatCompactTokens(tokens as number)})`));
	} else if (hasWindow) {
		// Only the context window is known. Without a percent or token count, reporting a bare
		// window size is noisy, so omit the segment entirely.
		if (!hasPercent) return null;
		parts.push(theme.fg("dim", `(? / ${formatCompactTokens(contextWindow as number)})`));
	}

	return parts.join(" ");
}

export default function statusbarExtension(pi: ExtensionAPI) {
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let pollInFlight: Promise<void> | undefined;
	let pollQueued = false;
	let requestRender: (() => void) | undefined;
	let activeProvider: SupportedProvider | null = null;
	const usageState = new Map<SupportedProvider, ProviderRuntimeState>();
	let config: StatusbarConfig = {
		usageRefreshIntervalMs: DEFAULT_USAGE_REFRESH_INTERVAL_MS,
		lines: [],
		compactWidth: DEFAULT_COMPACT_WIDTH,
	};

	async function refreshUsage(force = false): Promise<void> {
		const provider = activeProvider;
		if (!provider || !configIncludes(config, "usage")) return;

		const previous = usageState.get(provider);
		if (!force && previous?.loading) return;

		usageState.set(provider, {
			...previous,
			loading: true,
		});
		requestRender?.();

		try {
			const data = await loadUsage(provider);
			usageState.set(provider, {
				loading: false,
				data,
				updatedAt: Date.now(),
			});
		} catch (error) {
			usageState.set(provider, {
				loading: false,
				data: previous?.data,
				error: error instanceof Error ? error.message : String(error),
				updatedAt: previous?.updatedAt,
			});
		}

		requestRender?.();
	}

	async function queueRefresh(force = false): Promise<void> {
		if (pollInFlight) {
			pollQueued = pollQueued || force;
			await pollInFlight;
			return;
		}

		let nextForce = force;
		do {
			const currentForce = nextForce || pollQueued;
			pollQueued = false;
			pollInFlight = refreshUsage(currentForce).finally(() => {
				pollInFlight = undefined;
			});
			await pollInFlight;
			nextForce = false;
		} while (pollQueued);
	}

	function updateActiveProvider(provider: string | undefined): boolean {
		const next = normalizeProvider(provider);
		const changed = next !== activeProvider;
		activeProvider = next;
		return changed;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		updateActiveProvider(ctx.model?.provider);
		config = loadStatusbarConfig(ctx.cwd);

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

			let lastProviderLabel = activeProvider ? PROVIDER_META[activeProvider].providerLabel : "unknown";
			let lastModelId = ctx.model?.id ?? "no-model";
			let lastThinking = pi.getThinkingLevel();

			return {
				render(width: number): string[] {
					try {
						const providerFromModel = normalizeProvider(ctx.model?.provider);
						if (providerFromModel) {
							lastProviderLabel = PROVIDER_META[providerFromModel].providerLabel;
						} else if (ctx.model?.provider) {
							lastProviderLabel = ctx.model.provider;
						}
						lastModelId = ctx.model?.id ?? "no-model";
						lastThinking = pi.getThinkingLevel();
					} catch {
						// Keep last good values during teardown.
					}

					const providerState = activeProvider ? usageState.get(activeProvider) : undefined;
					const cwd = middleEllipsis(withHomeTilde(ctx.sessionManager.getCwd()), 36);
					const branch = footerData.getGitBranch();
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow;

					const usageSegment = activeProvider
						? formatUsageSegment(theme, providerState?.data, providerState?.error)
						: null;
					const contextSegment = formatContextSegment(
						theme,
						contextUsage?.percent,
						contextUsage?.tokens,
						contextWindow,
					);

					const lines = layoutStatusbarLines(
						selectStatusbarLines(config, width),
						{
							model: `${theme.fg("dim", `(${lastProviderLabel})`)} ${theme.bold(lastModelId)} ${theme.fg("accent", lastThinking)}`,
							usage: usageSegment,
							cwd: theme.fg("dim", cwd),
							branch: branch ? theme.fg("dim", branch) : null,
							context: contextSegment,
						},
						theme.fg("dim", " · "),
					);
					if (lines.length === 0) return [];
					return [...lines.map((line) => truncateToWidth(line, width, theme.fg("dim", "…"))), ""];
				},
				invalidate() {},
				dispose() {
					unsubscribeBranch();
					if (requestRender) {
						requestRender = undefined;
					}
				},
			};
		});

		await queueRefresh(true);

		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		if (config.usageRefreshIntervalMs <= 0 || !configIncludes(config, "usage")) return;
		pollTimer = setInterval(() => {
			void queueRefresh(false);
		}, config.usageRefreshIntervalMs);
	});

	pi.on("model_select", async (event, ctx) => {
		if (ctx.mode !== "tui") return;

		const changed = updateActiveProvider(event.model?.provider);
		requestRender?.();
		if (changed) {
			await queueRefresh(true);
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		requestRender?.();
		await queueRefresh(true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		requestRender = undefined;
		if (ctx.mode === "tui") {
			ctx.ui.setFooter(undefined);
		}
	});
}
