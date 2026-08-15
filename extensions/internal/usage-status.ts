import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type SupportedProvider = "openai-codex" | "anthropic" | "google-gemini-cli" | "github-copilot";

export type AuthEntry = {
	type?: "oauth";
	access?: string;
	refresh?: string;
	expires?: number;
	projectId?: string;
	enterpriseUrl?: string;
};

export type AuthData = Partial<Record<SupportedProvider, AuthEntry>> & Record<string, AuthEntry | undefined>;

/**
 * Credit-style balance reported next to the rolling limits (Anthropic extra usage,
 * Codex credit balance, Copilot premium request allowance, ...).
 */
export type UsageCredits = {
	/** Row label, e.g. "credits" or "extra usage". */
	label: string;
	/** Human readable amount, e.g. "$12.34 / $100.00" or "1,234 left". */
	detail: string;
	/** Compact variant for tight spaces. */
	compactDetail?: string | undefined;
	/** Used percent (0-100) when a limit is known, null when the balance has no cap. */
	usedPercent?: number | null | undefined;
	resetAt?: string | undefined;
};

/**
 * Additional limit rows beyond the two headline windows, e.g. Anthropic's
 * model-scoped weekly limits (`weekly (Fable)`).
 */
export type UsageExtraLimit = {
	label: string;
	usedPercent: number | null;
	resetAt?: string | undefined;
	detail?: string | undefined;
	compactDetail?: string | undefined;
};

export type UsageInfo = {
	provider: SupportedProvider;
	primaryLabel: string;
	/** "credits" when the primary row reports a balance instead of a rolling window. */
	primaryKind?: "limit" | "credits" | undefined;
	primaryPercent: number | null;
	secondaryLabel: string;
	secondaryPercent: number | null;
	primaryResetAt?: string | undefined;
	secondaryResetAt?: string | undefined;
	primaryText?: string | undefined;
	secondaryText?: string | undefined;
	/** Short extra text rendered alongside the primary bar (e.g. "$228.69 / $1000.00"). */
	primaryDetail?: string | undefined;
	/** Short extra text rendered alongside the secondary bar. */
	secondaryDetail?: string | undefined;
	/** Very compact variant used by the statusbar when space is tight. */
	primaryCompactDetail?: string | undefined;
	secondaryCompactDetail?: string | undefined;
	/** Hide the secondary row entirely (e.g. Anthropic Enterprise extra usage has no matching counterpart). */
	hideSecondary?: boolean | undefined;
	/** Credit balance, when the provider exposes one. */
	credits?: UsageCredits | undefined;
	/** Extra limit rows shown after the headline windows. */
	extra?: UsageExtraLimit[] | undefined;
	error?: string | undefined;
};

export type UsageResult = {
	provider: SupportedProvider;
	usage?: UsageInfo | undefined;
	error?: string | undefined;
};

export type UsageLoadOptions = {
	authFile?: string;
	forceRefresh?: boolean;
};

type JsonResponse = {
	ok: boolean;
	status: number;
	data?: any;
	error?: string;
};

export const USAGE_AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");
export const SUPPORTED_PROVIDERS: readonly SupportedProvider[] = [
	"openai-codex",
	"anthropic",
	"google-gemini-cli",
	"github-copilot",
];
export const PROVIDER_META: Record<
	SupportedProvider,
	{ providerLabel: string; primaryLabel: string; secondaryLabel: string }
> = {
	"openai-codex": {
		providerLabel: "openai",
		primaryLabel: "5h",
		secondaryLabel: "weekly",
	},
	anthropic: {
		providerLabel: "anthropic",
		primaryLabel: "5h",
		secondaryLabel: "weekly",
	},
	"google-gemini-cli": {
		providerLabel: "google",
		primaryLabel: "pro",
		secondaryLabel: "flash",
	},
	"github-copilot": {
		providerLabel: "github",
		primaryLabel: "premium",
		secondaryLabel: "chat",
	},
};

const GOOGLE_QUOTA_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const GOOGLE_LOAD_CODE_ASSIST_ENDPOINTS = [
	"https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
	"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
] as const;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
const COPILOT_HEADERS = {
	Accept: "application/json",
	"Editor-Version": "vscode/1.96.2",
	"Editor-Plugin-Version": "copilot-chat/0.26.7",
	"User-Agent": "GitHubCopilotChat/0.26.7",
	"X-Github-Api-Version": "2025-04-01",
} as const;

export function normalizeProvider(provider: string | undefined): SupportedProvider | null {
	if (provider === "openai-codex") return "openai-codex";
	if (provider === "anthropic") return "anthropic";
	if (provider === "google-gemini-cli") return "google-gemini-cli";
	if (provider === "github-copilot") return "github-copilot";
	return null;
}

export function readUsageAuth(authFile = USAGE_AUTH_FILE): AuthData | null {
	try {
		return JSON.parse(readFileSync(authFile, "utf8")) as AuthData;
	} catch {
		return null;
	}
}

/** Providers with usable credentials in auth.json, in a stable order. */
export function listAuthenticatedProviders(auth: AuthData | null): SupportedProvider[] {
	if (!auth) return [];
	return SUPPORTED_PROVIDERS.filter((provider) => {
		const entry = auth[provider];
		return Boolean(entry?.access || entry?.refresh);
	});
}

/**
 * Serializes token refreshes so concurrent provider lookups cannot clobber each
 * other's rotated refresh tokens when they write auth.json.
 */
let authWriteChain: Promise<unknown> = Promise.resolve();

function withAuthWriteLock<T>(task: () => Promise<T>): Promise<T> {
	const run = authWriteChain.then(task, task);
	authWriteChain = run.catch(() => undefined);
	return run;
}

function writeUsageAuth(auth: AuthData, authFile = USAGE_AUTH_FILE): void {
	const dir = path.dirname(authFile);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const tmpFile = `${authFile}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmpFile, JSON.stringify(auth, null, 2));
	renameSync(tmpFile, authFile);
}

function readPercent(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (value >= 0 && value <= 1) {
		if (Number.isInteger(value)) return value;
		return value * 100;
	}
	if (value >= 0 && value <= 100) return value;
	return null;
}

function usedPercentFromRemainingFraction(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const remaining = Math.max(0, Math.min(1, value));
	return 100 - remaining * 100;
}

function pickMostUsedBucket(buckets: any[]): any | null {
	let selected: any | null = null;
	let mostUsed = -1;

	for (const bucket of buckets) {
		const used = usedPercentFromRemainingFraction(bucket?.remainingFraction);
		if (used == null) continue;
		if (used > mostUsed) {
			mostUsed = used;
			selected = bucket;
		}
	}

	return selected;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<JsonResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		const text = await response.text();
		let data: any;

		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				if (response.ok) {
					return {
						ok: false,
						status: response.status,
						error: "invalid JSON response",
					};
				}
			}
		}

		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				data,
				error: `HTTP ${response.status}`,
			};
		}

		return { ok: true, status: response.status, data };
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return { ok: false, status: 0, error: "request timeout" };
		}
		return {
			ok: false,
			status: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

function googleMetadata(projectId?: string): Record<string, string> {
	return {
		ideType: "IDE_UNSPECIFIED",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI",
		...(projectId ? { duetProject: projectId } : {}),
	};
}

function googleHeaders(token: string, projectId?: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"X-Goog-Api-Client": "gl-node/22.17.0",
		"Client-Metadata": JSON.stringify(googleMetadata(projectId)),
	};
}

async function getProviderOAuth(provider: SupportedProvider, authFile?: string): Promise<OAuthAuth | undefined> {
	const runtime = await ModelRuntime.create({
		authPath: authFile ?? USAGE_AUTH_FILE,
		modelsPath: null,
		allowModelNetwork: false,
	});
	return runtime.getProvider(provider)?.auth.oauth;
}

function isTokenExpired(entry: AuthEntry): boolean {
	return typeof entry.expires === "number" && Date.now() + TOKEN_REFRESH_SKEW_MS >= entry.expires;
}

function needsRefresh(entry: AuthEntry | undefined, force = false): boolean {
	if (!entry?.refresh) return false;
	if (force) return true;
	return !entry.access || isTokenExpired(entry);
}

export async function refreshUsageAuthIfNeeded(
	auth: AuthData,
	provider: SupportedProvider,
	options: { force?: boolean; authFile?: string } = {},
): Promise<AuthData> {
	const current = auth[provider];
	const currentRefresh = current?.refresh;
	if (!current || !currentRefresh || !needsRefresh(current, options.force)) return auth;

	return withAuthWriteLock(async () => {
		// Re-read inside the lock: a concurrent lookup may have rotated the token already,
		// and reusing our stale snapshot would invalidate the newer refresh token.
		const latest = readUsageAuth(options.authFile) ?? auth;
		const latestEntry = latest[provider] ?? current;
		const refreshedByOther =
			Boolean(latestEntry.access) && latestEntry.expires !== current.expires && !isTokenExpired(latestEntry);
		if (refreshedByOther || !needsRefresh(latestEntry, options.force)) {
			return { ...auth, ...latest };
		}

		try {
			const oauth = await getProviderOAuth(provider, options.authFile);
			if (!oauth) throw new Error(`OAuth refresh is not available for ${provider}`);

			const credentials: OAuthCredential = {
				...latestEntry,
				type: "oauth",
				access: latestEntry.access ?? "",
				refresh: latestEntry.refresh ?? currentRefresh,
				expires: latestEntry.expires ?? 0,
			};
			const refreshed = await oauth.refresh(credentials, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
			const next: AuthData = {
				...latest,
				[provider]: {
					...latestEntry,
					...refreshed,
				},
			};

			writeUsageAuth(next, options.authFile);
			return next;
		} catch {
			if (latestEntry.access) {
				return { ...auth, ...latest };
			}
			throw new Error(`missing access token for ${provider}`);
		}
	});
}

export async function discoverGeminiProjectId(token: string): Promise<string | undefined> {
	const envProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	if (envProjectId) return envProjectId;

	for (const endpoint of GOOGLE_LOAD_CODE_ASSIST_ENDPOINTS) {
		const result = await fetchJson(endpoint, {
			method: "POST",
			headers: googleHeaders(token),
			body: JSON.stringify({ metadata: googleMetadata() }),
		});

		if (!result.ok) continue;

		const project = result.data?.cloudaicompanionProject;
		if (typeof project === "string" && project) return project;
		if (project && typeof project === "object" && typeof project.id === "string" && project.id) {
			return project.id;
		}
	}

	return undefined;
}

function formatCount(value: number): string {
	const digits = Math.abs(value) >= 100 ? 0 : 2;
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

function formatCountCompact(value: number): string {
	if (Math.abs(value) >= 1000) {
		return `${(Math.round(value / 100) / 10).toString().replace(/\.0$/, "")}k`;
	}
	return formatCount(value);
}

/** The API returns spend-control amounts as decimal strings. */
function readNumeric(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/**
 * Business / Enterprise workspaces meter Codex with a credit allowance instead of
 * rolling windows: `rate_limit` is null and the balance lives in `spend_control`.
 */
function readCodexSpendControl(data: any): UsageCredits | undefined {
	const spendControl = data?.spend_control;
	if (!spendControl || typeof spendControl !== "object") return undefined;

	const candidates = [spendControl.individual_limit, spendControl.group_limit, spendControl.limit].filter(
		(candidate) => candidate && typeof candidate === "object",
	);

	for (const candidate of candidates) {
		const limit = readNumeric(candidate.limit);
		const used = readNumeric(candidate.used);
		const remaining = readNumeric(candidate.remaining);
		if (limit == null || limit <= 0 || (used == null && remaining == null)) continue;

		const usedAmount = used ?? Math.max(0, limit - (remaining as number));
		const resetAt = readNumeric(candidate.reset_at);
		const resetAfterSeconds = readNumeric(candidate.reset_after_seconds);

		return {
			label: "credits",
			detail: `${formatCount(usedAmount)} / ${formatCount(limit)} used`,
			compactDetail: `${formatCountCompact(usedAmount)}/${formatCountCompact(limit)}`,
			usedPercent: Math.max(0, Math.min(100, (usedAmount / limit) * 100)),
			...(resetAt != null
				? { resetAt: new Date(resetAt * 1000).toISOString() }
				: resetAfterSeconds != null
					? { resetAt: new Date(Date.now() + resetAfterSeconds * 1000).toISOString() }
					: {}),
		};
	}

	return undefined;
}

/** Pay-as-you-go credit balance reported for individual Codex accounts. */
function readCodexCreditBalance(data: any): UsageCredits | undefined {
	const credits = data?.credits;
	if (!credits || typeof credits !== "object") return undefined;
	if (credits.unlimited === true) {
		return { label: "credits", detail: "unlimited", usedPercent: null };
	}

	const balance = readNumeric(credits.balance);
	if (balance == null) return undefined;

	const granted = readNumeric(credits.total_granted);
	if (granted != null && granted > 0) {
		const used = Math.max(0, granted - balance);
		return {
			label: "credits",
			detail: `${formatCount(used)} / ${formatCount(granted)} used`,
			compactDetail: `${formatCountCompact(used)}/${formatCountCompact(granted)}`,
			usedPercent: Math.max(0, Math.min(100, (used / granted) * 100)),
		};
	}

	return {
		label: "credits",
		detail: `${formatCount(balance)} left`,
		compactDetail: formatCountCompact(balance),
		usedPercent: null,
	};
}

export async function fetchCodexUsage(auth: AuthData): Promise<UsageInfo> {
	const token = auth["openai-codex"]?.access;
	if (!token) throw new Error("missing OpenAI Codex access token");

	const result = await fetchJson("https://chatgpt.com/backend-api/wham/usage", {
		headers: {
			Authorization: `Bearer ${token}`,
		},
	});

	if (!result.ok) {
		throw new Error(result.error ?? "failed to fetch OpenAI Codex usage");
	}

	const primaryResetSeconds = result.data?.rate_limit?.primary_window?.reset_after_seconds;
	const secondaryResetSeconds = result.data?.rate_limit?.secondary_window?.reset_after_seconds;
	const now = Date.now();
	const primaryPercent = readPercent(result.data?.rate_limit?.primary_window?.used_percent);
	const secondaryPercent = readPercent(result.data?.rate_limit?.secondary_window?.used_percent);
	const credits = readCodexSpendControl(result.data) ?? readCodexCreditBalance(result.data);

	// Credit-metered plans report `rate_limit: null`; showing two "unavailable"
	// windows there is noise, so the credit allowance becomes the only row.
	if (primaryPercent == null && secondaryPercent == null && credits) {
		return {
			provider: "openai-codex",
			primaryLabel: credits.label,
			primaryKind: "credits",
			primaryPercent: credits.usedPercent ?? null,
			secondaryLabel: "",
			secondaryPercent: null,
			primaryResetAt: credits.resetAt,
			primaryDetail: credits.detail,
			primaryCompactDetail: credits.compactDetail,
			hideSecondary: true,
		};
	}

	return {
		provider: "openai-codex",
		...(credits ? { credits } : {}),
		primaryLabel: PROVIDER_META["openai-codex"].primaryLabel,
		primaryPercent,
		secondaryLabel: PROVIDER_META["openai-codex"].secondaryLabel,
		secondaryPercent,
		primaryResetAt:
			typeof primaryResetSeconds === "number" ? new Date(now + primaryResetSeconds * 1000).toISOString() : undefined,
		secondaryResetAt:
			typeof secondaryResetSeconds === "number"
				? new Date(now + secondaryResetSeconds * 1000).toISOString()
				: undefined,
	};
}

function formatAnthropicCurrency(valueInCents: number, currency: string | undefined): string {
	const usd = valueInCents / 100;
	const formatter = new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: currency || "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
	try {
		return formatter.format(usd);
	} catch {
		return `$${usd.toFixed(2)}`;
	}
}

function formatAnthropicCurrencyCompact(valueInCents: number, currency: string | undefined): string {
	const usd = valueInCents / 100;
	const symbol = (currency || "USD") === "USD" ? "$" : `${currency} `;
	if (usd >= 1000) return `${symbol}${Math.round(usd / 100) / 10}k`.replace(".0k", "k");
	if (usd >= 100) return `${symbol}${Math.round(usd)}`;
	return `${symbol}${usd.toFixed(2)}`;
}

/**
 * Anthropic reports "extra usage" as a dollar-denominated monthly credit pool.
 * Values arrive in cents and `extra_usage.utilization` is unreliable, so the ratio
 * is recomputed from the raw amounts.
 */
function readAnthropicCredits(extraUsage: any): UsageCredits | undefined {
	if (!extraUsage || extraUsage.is_enabled !== true) return undefined;
	if (typeof extraUsage.monthly_limit !== "number" || typeof extraUsage.used_credits !== "number") return undefined;

	const currency = typeof extraUsage.currency === "string" ? extraUsage.currency : "USD";
	const used = formatAnthropicCurrency(extraUsage.used_credits, currency);
	const limit = formatAnthropicCurrency(extraUsage.monthly_limit, currency);
	const compactUsed = formatAnthropicCurrencyCompact(extraUsage.used_credits, currency);
	const compactLimit = formatAnthropicCurrencyCompact(extraUsage.monthly_limit, currency);

	return {
		label: "extra usage",
		detail: `${used} / ${limit}`,
		compactDetail: `${compactUsed}/${compactLimit}`,
		usedPercent:
			extraUsage.monthly_limit > 0
				? Math.max(0, Math.min(100, (extraUsage.used_credits / extraUsage.monthly_limit) * 100))
				: null,
		...(typeof extraUsage.resets_at === "string" ? { resetAt: extraUsage.resets_at } : {}),
	};
}

type AnthropicLimit = {
	kind: string;
	group: string;
	usedPercent: number | null;
	resetAt: string | undefined;
	scopeName: string | null;
};

/** Percent fields in `limits[]` are already scaled 0-100. */
function clampPercent(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.max(0, Math.min(100, value));
}

function readScopeName(scope: any): string | null {
	if (!scope || typeof scope !== "object") return null;
	const model = scope.model;
	if (model && typeof model === "object") {
		if (typeof model.display_name === "string" && model.display_name) return model.display_name;
		if (typeof model.id === "string" && model.id) return model.id;
	}
	const surface = scope.surface;
	if (typeof surface === "string" && surface) return surface;
	if (surface && typeof surface === "object") {
		if (typeof surface.display_name === "string" && surface.display_name) return surface.display_name;
		if (typeof surface.id === "string" && surface.id) return surface.id;
	}
	return null;
}

/**
 * Newer Anthropic responses describe every limit in a generic `limits[]` array,
 * including model-scoped weekly windows (e.g. the "Fable" weekly limit) that have
 * no dedicated top-level field.
 */
function parseAnthropicLimits(data: any): AnthropicLimit[] {
	const limits = Array.isArray(data?.limits) ? data.limits : [];
	return limits
		.filter((limit: any) => limit && typeof limit === "object")
		.map((limit: any) => ({
			kind: typeof limit.kind === "string" ? limit.kind : "",
			group: typeof limit.group === "string" ? limit.group : "",
			usedPercent: clampPercent(limit.percent),
			resetAt: typeof limit.resets_at === "string" ? limit.resets_at : undefined,
			scopeName: readScopeName(limit.scope),
		}));
}

function anthropicLimitLabel(limit: AnthropicLimit): string {
	const base =
		limit.group === "session"
			? PROVIDER_META.anthropic.primaryLabel
			: limit.group === "weekly"
				? PROVIDER_META.anthropic.secondaryLabel
				: limit.group || limit.kind || "limit";
	return limit.scopeName ? `${base} (${limit.scopeName})` : base;
}

/** Legacy per-model weekly buckets, used when `limits[]` is absent. */
const ANTHROPIC_LEGACY_SCOPED_BUCKETS: ReadonlyArray<[string, string]> = [
	["seven_day_opus", "Opus"],
	["seven_day_sonnet", "Sonnet"],
	["seven_day_cowork", "Cowork"],
];

/** Limit rows that have no dedicated primary/secondary slot, e.g. per-model weekly caps. */
function readAnthropicExtraLimits(data: any): UsageExtraLimit[] {
	const scoped = parseAnthropicLimits(data).filter((limit) => limit.scopeName != null && limit.usedPercent != null);
	if (scoped.length > 0) {
		return scoped.map((limit) => ({
			label: anthropicLimitLabel(limit),
			usedPercent: limit.usedPercent,
			...(limit.resetAt ? { resetAt: limit.resetAt } : {}),
		}));
	}

	const legacy: UsageExtraLimit[] = [];
	for (const [key, name] of ANTHROPIC_LEGACY_SCOPED_BUCKETS) {
		const bucket = data?.[key];
		const usedPercent = readPercent(bucket?.utilization);
		if (usedPercent == null) continue;
		legacy.push({
			label: `${PROVIDER_META.anthropic.secondaryLabel} (${name})`,
			usedPercent,
			...(typeof bucket?.resets_at === "string" ? { resetAt: bucket.resets_at } : {}),
		});
	}
	return legacy;
}

export async function fetchClaudeUsage(auth: AuthData): Promise<UsageInfo> {
	const token = auth.anthropic?.access;
	if (!token) throw new Error("missing Anthropic access token");

	const result = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
		headers: {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
		},
	});

	if (!result.ok) {
		throw new Error(result.error ?? "failed to fetch Anthropic usage");
	}

	const fiveHour = result.data?.five_hour;
	const sevenDay = result.data?.seven_day;
	const extraUsage = result.data?.extra_usage;
	const limits = parseAnthropicLimits(result.data);
	const extra = readAnthropicExtraLimits(result.data);
	// `limits[]` mirrors the headline windows and is the only source on newer responses.
	const sessionLimit = limits.find((limit) => limit.kind === "session" || limit.group === "session");
	const weeklyLimit = limits.find((limit) => limit.scopeName == null && limit.group === "weekly");

	// Enterprise / "extra usage" plans expose a dollar-denominated monthly cap instead of
	// the default 5h / 7d rolling windows, which come back as `null`.
	const hasRollingWindows = fiveHour != null || sevenDay != null || sessionLimit != null || weeklyLimit != null;
	if (
		!hasRollingWindows &&
		extraUsage &&
		extraUsage.is_enabled === true &&
		typeof extraUsage.monthly_limit === "number" &&
		typeof extraUsage.used_credits === "number"
	) {
		const currency = typeof extraUsage.currency === "string" ? extraUsage.currency : "USD";
		// Compute the utilization ratio ourselves from the dollar-denominated fields.
		// The API's `extra_usage.utilization` value is unreliable for this view (it has shown
		// up as a percent-scaled number, e.g. 0.724 meaning 0.724%, which `readPercent` would
		// then misinterpret as the fraction 72.4%).
		const utilization = extraUsage.monthly_limit > 0 ? extraUsage.used_credits / extraUsage.monthly_limit : null;
		const used = formatAnthropicCurrency(extraUsage.used_credits, currency);
		const limit = formatAnthropicCurrency(extraUsage.monthly_limit, currency);
		const compactUsed = formatAnthropicCurrencyCompact(extraUsage.used_credits, currency);
		const compactLimit = formatAnthropicCurrencyCompact(extraUsage.monthly_limit, currency);
		const resetAt = typeof extraUsage.resets_at === "string" ? extraUsage.resets_at : undefined;

		return {
			provider: "anthropic",
			...(extra.length > 0 ? { extra } : {}),
			primaryLabel: "extra usage",
			primaryKind: "credits",
			primaryPercent: readPercent(utilization),
			secondaryLabel: "",
			secondaryPercent: null,
			primaryResetAt: resetAt,
			primaryDetail: `${used} / ${limit}`,
			primaryCompactDetail: `${compactUsed}/${compactLimit}`,
			hideSecondary: true,
		};
	}

	const credits = readAnthropicCredits(extraUsage);

	return {
		provider: "anthropic",
		...(credits ? { credits } : {}),
		...(extra.length > 0 ? { extra } : {}),
		primaryLabel: PROVIDER_META.anthropic.primaryLabel,
		primaryPercent: readPercent(fiveHour?.utilization) ?? sessionLimit?.usedPercent ?? null,
		secondaryLabel: PROVIDER_META.anthropic.secondaryLabel,
		secondaryPercent: readPercent(sevenDay?.utilization) ?? weeklyLimit?.usedPercent ?? null,
		primaryResetAt: typeof fiveHour?.resets_at === "string" ? fiveHour.resets_at : sessionLimit?.resetAt,
		secondaryResetAt: typeof sevenDay?.resets_at === "string" ? sevenDay.resets_at : weeklyLimit?.resetAt,
	};
}

export async function fetchGeminiUsage(auth: AuthData): Promise<UsageInfo> {
	const token = auth["google-gemini-cli"]?.access;
	if (!token) throw new Error("missing Gemini access token");

	const projectId = auth["google-gemini-cli"]?.projectId || (await discoverGeminiProjectId(token));
	if (!projectId) throw new Error("missing Gemini projectId");

	const result = await fetchJson(GOOGLE_QUOTA_ENDPOINT, {
		method: "POST",
		headers: googleHeaders(token, projectId),
		body: JSON.stringify({ project: projectId }),
	});

	if (!result.ok) {
		throw new Error(result.error ?? "failed to fetch Gemini usage");
	}

	const allBuckets = Array.isArray(result.data?.buckets) ? result.data.buckets : [];
	const requestBuckets = allBuckets.filter(
		(bucket: any) => String(bucket?.tokenType || "").toUpperCase() === "REQUESTS",
	);
	const buckets = requestBuckets.length > 0 ? requestBuckets : allBuckets;
	const modelId = (bucket: any) => String(bucket?.modelId || "").toLowerCase();
	const proBuckets = buckets.filter(
		(bucket: any) => modelId(bucket).includes("gemini") && modelId(bucket).includes("pro"),
	);
	const flashBuckets = buckets.filter(
		(bucket: any) => modelId(bucket).includes("gemini") && modelId(bucket).includes("flash"),
	);

	const primaryBucket =
		pickMostUsedBucket(proBuckets) || pickMostUsedBucket(flashBuckets) || pickMostUsedBucket(buckets);
	const secondaryBucket =
		pickMostUsedBucket(flashBuckets) || pickMostUsedBucket(proBuckets) || pickMostUsedBucket(buckets);

	return {
		provider: "google-gemini-cli",
		primaryLabel: PROVIDER_META["google-gemini-cli"].primaryLabel,
		primaryPercent: usedPercentFromRemainingFraction(primaryBucket?.remainingFraction),
		secondaryLabel: PROVIDER_META["google-gemini-cli"].secondaryLabel,
		secondaryPercent: usedPercentFromRemainingFraction(secondaryBucket?.remainingFraction),
		primaryResetAt: typeof primaryBucket?.resetTime === "string" ? primaryBucket.resetTime : undefined,
		secondaryResetAt: typeof secondaryBucket?.resetTime === "string" ? secondaryBucket.resetTime : undefined,
	};
}

/** Copilot bills premium model calls from a monthly "premium request" allowance. */
function readCopilotCredits(premiumSnapshot: any, resetAt: string | undefined): UsageCredits | undefined {
	if (!premiumSnapshot || typeof premiumSnapshot !== "object") return undefined;
	if (premiumSnapshot.unlimited === true) {
		return { label: "premium requests", detail: "unlimited", usedPercent: null };
	}

	const entitlement =
		typeof premiumSnapshot.entitlement === "number" && Number.isFinite(premiumSnapshot.entitlement)
			? premiumSnapshot.entitlement
			: null;
	const remaining =
		typeof premiumSnapshot.remaining === "number" && Number.isFinite(premiumSnapshot.remaining)
			? premiumSnapshot.remaining
			: null;
	if (entitlement == null || remaining == null || entitlement <= 0) return undefined;

	const used = Math.max(0, entitlement - remaining);
	return {
		label: "premium requests",
		detail: `${formatCount(remaining)} / ${formatCount(entitlement)}`,
		compactDetail: `${formatCount(remaining)}/${formatCount(entitlement)}`,
		usedPercent: Math.max(0, Math.min(100, (used / entitlement) * 100)),
		...(resetAt ? { resetAt } : {}),
	};
}

export async function fetchCopilotUsage(auth: AuthData): Promise<UsageInfo> {
	const githubToken = auth["github-copilot"]?.refresh;
	if (!githubToken) throw new Error("missing GitHub OAuth token for Copilot");

	const result = await fetchJson("https://api.github.com/copilot_internal/user", {
		headers: {
			Authorization: `token ${githubToken}`,
			...COPILOT_HEADERS,
		},
	});

	if (!result.ok) {
		throw new Error(result.error ?? "failed to fetch GitHub Copilot usage");
	}

	const premiumSnapshot = result.data?.quota_snapshots?.premium_interactions;
	const chatSnapshot = result.data?.quota_snapshots?.chat;
	const premiumRemaining = readPercent(premiumSnapshot?.percent_remaining);
	const chatRemaining = readPercent(chatSnapshot?.percent_remaining);
	const unlimitedChat = chatSnapshot?.unlimited === true && chatSnapshot?.has_quota === false;
	let secondaryPercent: number | null = null;
	if (!unlimitedChat && chatRemaining != null) {
		secondaryPercent = 100 - chatRemaining;
	}

	const resetAt = typeof result.data?.quota_reset_date_utc === "string" ? result.data.quota_reset_date_utc : undefined;
	const credits = readCopilotCredits(premiumSnapshot, resetAt);

	return {
		provider: "github-copilot",
		...(credits ? { credits } : {}),
		primaryLabel: PROVIDER_META["github-copilot"].primaryLabel,
		primaryPercent: premiumRemaining == null ? null : 100 - premiumRemaining,
		secondaryLabel: PROVIDER_META["github-copilot"].secondaryLabel,
		secondaryPercent,
		primaryResetAt: resetAt,
		secondaryResetAt: unlimitedChat ? undefined : resetAt,
		secondaryText: unlimitedChat ? "∞" : undefined,
	};
}

export async function loadUsage(provider: SupportedProvider, options: UsageLoadOptions = {}): Promise<UsageInfo> {
	let auth = readUsageAuth(options.authFile);
	if (!auth) throw new Error("missing ~/.pi/agent/auth.json");

	const refreshOptions: { force?: boolean; authFile?: string } = {};
	if (options.forceRefresh != null) refreshOptions.force = options.forceRefresh;
	if (options.authFile != null) refreshOptions.authFile = options.authFile;
	auth = await refreshUsageAuthIfNeeded(auth, provider, refreshOptions);

	try {
		if (provider === "openai-codex") return await fetchCodexUsage(auth);
		if (provider === "anthropic") return await fetchClaudeUsage(auth);
		if (provider === "google-gemini-cli") return await fetchGeminiUsage(auth);
		return await fetchCopilotUsage(auth);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/^HTTP (401|403)$/.test(message)) {
			throw error;
		}

		const forcedRefreshOptions: { force?: boolean; authFile?: string } = {
			force: true,
		};
		if (options.authFile != null) {
			forcedRefreshOptions.authFile = options.authFile;
		}
		auth = await refreshUsageAuthIfNeeded(auth, provider, forcedRefreshOptions);
		if (provider === "openai-codex") return await fetchCodexUsage(auth);
		if (provider === "anthropic") return await fetchClaudeUsage(auth);
		if (provider === "google-gemini-cli") return await fetchGeminiUsage(auth);
		return await fetchCopilotUsage(auth);
	}
}

export async function loadUsageResult(
	provider: SupportedProvider,
	options: UsageLoadOptions = {},
): Promise<UsageResult> {
	try {
		return { provider, usage: await loadUsage(provider, options) };
	} catch (error) {
		return {
			provider,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function loadAllUsageResults(
	providers: readonly SupportedProvider[] = SUPPORTED_PROVIDERS,
	options: UsageLoadOptions = {},
): Promise<Record<SupportedProvider, UsageResult>> {
	const entries = await Promise.all(
		providers.map(async (provider) => [provider, await loadUsageResult(provider, options)] as const),
	);

	return Object.fromEntries(entries) as Record<SupportedProvider, UsageResult>;
}
