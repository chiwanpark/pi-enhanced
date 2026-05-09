import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getGlobalPiSettingsPath, getProjectPiSettingsPath } from "./internal/common";

const DEFAULT_COMPACT_THRESHOLD_TOKENS = 100_000;

type PiSettingsFile = {
	compaction?: {
		enabled?: unknown;
	};
	piEnhanced?: {
		compactThresholdTokens?: unknown;
	};
};

type SettingsLoadResult = {
	found: boolean;
	settings: PiSettingsFile;
	warning?: string;
};

type ThresholdSettingResult = {
	found: boolean;
	thresholdTokens: number | null;
	warning?: string;
};

type BooleanSettingResult = {
	found: boolean;
	enabled: boolean;
	warning?: string;
};

type PendingCompaction = {
	currentTokens: number;
	thresholdTokens: number;
};

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

export default function compactThresholdExtension(pi: ExtensionAPI) {
	let previousTokens: number | null | undefined;
	let previousThresholdTokens: number | null = null;
	let pendingCompaction: PendingCompaction | null = null;
	let compactionInFlight = false;
	let lastSettingsWarning: string | null = null;

	const warnSettings = (ctx: ExtensionContext, message: string) => {
		if (lastSettingsWarning === message) return;
		lastSettingsWarning = message;
		notify(ctx, message, "warning");
	};

	const clearSettingsWarning = () => {
		lastSettingsWarning = null;
	};

	const loadSettingsFromPath = (settingsPath: string): SettingsLoadResult => {
		if (!existsSync(settingsPath)) {
			return { found: false, settings: {} };
		}

		try {
			const rawSettings = readFileSync(settingsPath, "utf8");
			const settings = JSON.parse(rawSettings) as unknown;
			if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
				return {
					found: false,
					settings: {},
					warning: `Invalid settings in ${settingsPath}; using compaction defaults`,
				};
			}
			return { found: true, settings: settings as PiSettingsFile };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				found: false,
				settings: {},
				warning: `Could not read ${settingsPath}: ${message}. Using compaction defaults`,
			};
		}
	};

	const readCompactThresholdSetting = (settings: PiSettingsFile, settingsPath: string): ThresholdSettingResult => {
		const configuredThreshold = settings.piEnhanced?.compactThresholdTokens;

		if (configuredThreshold == null) {
			return { found: false, thresholdTokens: DEFAULT_COMPACT_THRESHOLD_TOKENS };
		}

		if (configuredThreshold === false) {
			return { found: true, thresholdTokens: null };
		}

		if (typeof configuredThreshold === "number" && Number.isFinite(configuredThreshold) && configuredThreshold > 0) {
			return { found: true, thresholdTokens: configuredThreshold };
		}

		return {
			found: true,
			thresholdTokens: DEFAULT_COMPACT_THRESHOLD_TOKENS,
			warning: `Invalid piEnhanced.compactThresholdTokens in ${settingsPath}; using ${DEFAULT_COMPACT_THRESHOLD_TOKENS.toLocaleString()}`,
		};
	};

	const readCompactionEnabledSetting = (settings: PiSettingsFile, settingsPath: string): BooleanSettingResult => {
		const configuredEnabled = settings.compaction?.enabled;

		if (configuredEnabled == null) {
			return { found: false, enabled: true };
		}

		if (typeof configuredEnabled === "boolean") {
			return { found: true, enabled: configuredEnabled };
		}

		return {
			found: true,
			enabled: true,
			warning: `Invalid compaction.enabled in ${settingsPath}; using true`,
		};
	};

	const loadCompactThresholdTokens = (ctx: ExtensionContext): number | null => {
		const warnings: string[] = [];
		const globalSettingsPath = getGlobalPiSettingsPath();
		const projectSettingsPath = getProjectPiSettingsPath(ctx.cwd);
		const globalSettings = loadSettingsFromPath(globalSettingsPath);
		const projectSettings = loadSettingsFromPath(projectSettingsPath);

		if (globalSettings.warning) warnings.push(globalSettings.warning);
		if (projectSettings.warning) warnings.push(projectSettings.warning);

		let compactionEnabled = true;
		const globalEnabled = readCompactionEnabledSetting(globalSettings.settings, globalSettingsPath);
		if (globalEnabled.warning) warnings.push(globalEnabled.warning);
		if (globalEnabled.found) compactionEnabled = globalEnabled.enabled;

		const projectEnabled = readCompactionEnabledSetting(projectSettings.settings, projectSettingsPath);
		if (projectEnabled.warning) warnings.push(projectEnabled.warning);
		if (projectEnabled.found) compactionEnabled = projectEnabled.enabled;

		let thresholdTokens: number | null = DEFAULT_COMPACT_THRESHOLD_TOKENS;
		const globalThreshold = readCompactThresholdSetting(globalSettings.settings, globalSettingsPath);
		if (globalThreshold.warning) warnings.push(globalThreshold.warning);
		if (globalThreshold.found) thresholdTokens = globalThreshold.thresholdTokens;

		const projectThreshold = readCompactThresholdSetting(projectSettings.settings, projectSettingsPath);
		if (projectThreshold.warning) warnings.push(projectThreshold.warning);
		if (projectThreshold.found) thresholdTokens = projectThreshold.thresholdTokens;

		const warning = warnings.join("; ");
		if (warning) warnSettings(ctx, warning);
		else clearSettingsWarning();

		if (!compactionEnabled) return null;
		return thresholdTokens;
	};

	const triggerCompaction = (ctx: ExtensionContext, currentTokens: number, thresholdTokens: number) => {
		if (compactionInFlight) return;
		compactionInFlight = true;

		notify(
			ctx,
			`Context reached ${currentTokens.toLocaleString()} tokens, compacting history at ${thresholdTokens.toLocaleString()}+`,
		);

		ctx.compact({
			onComplete: () => {
				compactionInFlight = false;
				previousTokens = thresholdTokens;
				notify(ctx, "Compaction completed", "info");
			},
			onError: (error) => {
				compactionInFlight = false;
				previousTokens = currentTokens;
				notify(ctx, `Compaction failed: ${error.message}`, "error");
			},
		});
	};

	pi.on("session_compact", async () => {
		compactionInFlight = false;
		pendingCompaction = null;
		previousTokens = previousThresholdTokens;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (compactionInFlight || pendingCompaction === null) return;

		const { currentTokens } = pendingCompaction;
		pendingCompaction = null;

		const thresholdTokens = loadCompactThresholdTokens(ctx);
		if (thresholdTokens === null || currentTokens < thresholdTokens) return;

		triggerCompaction(ctx, currentTokens, thresholdTokens);
	});

	pi.on("turn_end", async (_event, ctx) => {
		const currentTokens = ctx.getContextUsage()?.tokens ?? null;
		if (currentTokens === null) {
			previousTokens = currentTokens;
			return;
		}

		const thresholdTokens = loadCompactThresholdTokens(ctx);
		const thresholdChanged = thresholdTokens !== previousThresholdTokens;
		previousThresholdTokens = thresholdTokens;
		if (thresholdTokens === null) {
			pendingCompaction = null;
			previousTokens = currentTokens;
			return;
		}

		const crossedThreshold = thresholdChanged
			? currentTokens >= thresholdTokens
			: previousTokens == null
				? currentTokens >= thresholdTokens
				: previousTokens < thresholdTokens && currentTokens >= thresholdTokens;

		previousTokens = currentTokens;
		if (!crossedThreshold) return;

		if (!ctx.isIdle()) {
			pendingCompaction = { currentTokens, thresholdTokens };
			return;
		}

		triggerCompaction(ctx, currentTokens, thresholdTokens);
	});
}
