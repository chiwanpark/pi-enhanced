import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOAuthApiKey } from "@mariozechner/pi-ai/oauth";

export type SupportedProvider = "openai-codex" | "anthropic" | "google-gemini-cli" | "github-copilot";

export type AuthEntry = {
	access?: string;
	refresh?: string;
	expires?: number;
	projectId?: string;
	enterpriseUrl?: string;
};

export type AuthData = Partial<Record<SupportedProvider, AuthEntry>> & Record<string, AuthEntry | undefined>;

export type UsageInfo = {
	provider: SupportedProvider;
	primaryLabel: string;
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

export async function refreshUsageAuthIfNeeded(
	auth: AuthData,
	provider: SupportedProvider,
	options: { force?: boolean; authFile?: string } = {},
): Promise<AuthData> {
	const current = auth[provider];
	if (!current?.refresh) return auth;

	const shouldRefresh =
		options.force ||
		!current.access ||
		(typeof current.expires === "number" && Date.now() + TOKEN_REFRESH_SKEW_MS >= current.expires);

	if (!shouldRefresh) return auth;

	try {
		const resolved = await getOAuthApiKey(provider, auth as Record<string, any>);
		if (!resolved?.newCredentials) return auth;

		const next: AuthData = {
			...auth,
			[provider]: {
				...current,
				...(resolved.newCredentials as AuthEntry),
			},
		};

		writeUsageAuth(next, options.authFile);
		return next;
	} catch {
		if (current.access) {
			return auth;
		}
		throw new Error(`missing access token for ${provider}`);
	}
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

	return {
		provider: "openai-codex",
		primaryLabel: PROVIDER_META["openai-codex"].primaryLabel,
		primaryPercent: readPercent(result.data?.rate_limit?.primary_window?.used_percent),
		secondaryLabel: PROVIDER_META["openai-codex"].secondaryLabel,
		secondaryPercent: readPercent(result.data?.rate_limit?.secondary_window?.used_percent),
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

	// Enterprise / "extra usage" plans expose a dollar-denominated monthly cap instead of
	// the default 5h / 7d rolling windows, which come back as `null`.
	const hasRollingWindows = fiveHour != null || sevenDay != null;
	if (
		!hasRollingWindows &&
		extraUsage &&
		extraUsage.is_enabled === true &&
		typeof extraUsage.monthly_limit === "number" &&
		typeof extraUsage.used_credits === "number"
	) {
		const currency = typeof extraUsage.currency === "string" ? extraUsage.currency : "USD";
		const utilization =
			typeof extraUsage.utilization === "number" && Number.isFinite(extraUsage.utilization)
				? extraUsage.utilization
				: extraUsage.monthly_limit > 0
					? extraUsage.used_credits / extraUsage.monthly_limit
					: null;
		const used = formatAnthropicCurrency(extraUsage.used_credits, currency);
		const limit = formatAnthropicCurrency(extraUsage.monthly_limit, currency);
		const compactUsed = formatAnthropicCurrencyCompact(extraUsage.used_credits, currency);
		const compactLimit = formatAnthropicCurrencyCompact(extraUsage.monthly_limit, currency);
		const resetAt = typeof extraUsage.resets_at === "string" ? extraUsage.resets_at : undefined;

		return {
			provider: "anthropic",
			primaryLabel: "extra usage",
			primaryPercent: readPercent(utilization),
			secondaryLabel: "",
			secondaryPercent: null,
			primaryResetAt: resetAt,
			primaryDetail: `${used} / ${limit}`,
			primaryCompactDetail: `${compactUsed}/${compactLimit}`,
			hideSecondary: true,
		};
	}

	return {
		provider: "anthropic",
		primaryLabel: PROVIDER_META.anthropic.primaryLabel,
		primaryPercent: readPercent(fiveHour?.utilization),
		secondaryLabel: PROVIDER_META.anthropic.secondaryLabel,
		secondaryPercent: readPercent(sevenDay?.utilization),
		primaryResetAt: typeof fiveHour?.resets_at === "string" ? fiveHour.resets_at : undefined,
		secondaryResetAt: typeof sevenDay?.resets_at === "string" ? sevenDay.resets_at : undefined,
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

	return {
		provider: "github-copilot",
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
