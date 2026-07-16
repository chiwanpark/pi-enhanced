import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { withHomeTilde } from "./internal/common";
import {
	loadUsage,
	normalizeProvider,
	PROVIDER_META,
	type SupportedProvider,
	type UsageInfo,
} from "./internal/usage-status";

type ProviderRuntimeState = {
	loading: boolean;
	data?: UsageInfo | undefined;
	error?: string | undefined;
	updatedAt?: number | undefined;
};

const POLL_INTERVAL_MS = 2 * 60 * 1000;

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

	async function refreshUsage(force = false): Promise<void> {
		const provider = activeProvider;
		if (!provider) return;

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

					const segments = [
						`${theme.fg("dim", `(${lastProviderLabel})`)} ${theme.bold(lastModelId)} ${theme.fg("accent", lastThinking)}`,
					];

					const usageSegment = activeProvider
						? formatUsageSegment(theme, providerState?.data, providerState?.error)
						: null;
					if (usageSegment) segments.push(usageSegment);

					segments.push(theme.fg("dim", cwd));
					if (branch) segments.push(theme.fg("dim", branch));

					const contextSegment = formatContextSegment(
						theme,
						contextUsage?.percent,
						contextUsage?.tokens,
						contextWindow,
					);
					if (contextSegment) segments.push(contextSegment);

					const line = segments.join(theme.fg("dim", " · "));
					return [truncateToWidth(line, width, theme.fg("dim", "…")), ""];
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

		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(() => {
			void queueRefresh(false);
		}, POLL_INTERVAL_MS);
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
