import { readUsageAuth, refreshUsageAuthIfNeeded, type SupportedProvider } from "./usage-status";

type OpenAICodexTokenPayload = {
	"https://api.openai.com/auth"?: {
		chatgpt_plan_type?: string;
		chatgpt_account_id?: string;
	};
	"https://api.openai.com/profile"?: {
		email?: string;
	};
};

const COPILOT_HEADERS = {
	Accept: "application/json",
	"Editor-Version": "vscode/1.96.2",
	"Editor-Plugin-Version": "copilot-chat/0.26.7",
	"User-Agent": "GitHubCopilotChat/0.26.7",
	"X-Github-Api-Version": "2025-04-01",
} as const;

export const NOT_LOGGED_IN = "<not logged in>";

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

/** Human readable "who is logged in" line for a provider, e.g. `user@example.com (Pro)`. */
export async function loadAccountSummary(provider: SupportedProvider | null): Promise<string> {
	if (!provider) return "<unsupported provider>";

	const auth = readUsageAuth();
	if (!auth) return NOT_LOGGED_IN;

	if (provider === "openai-codex") {
		const refreshed = await refreshUsageAuthIfNeeded(auth, provider).catch(() => auth);
		const token = refreshed[provider]?.access ?? auth[provider]?.access;
		if (!token) return NOT_LOGGED_IN;
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
	if (!githubToken) return NOT_LOGGED_IN;

	try {
		const response = await fetch("https://api.github.com/copilot_internal/user", {
			headers: {
				Authorization: `token ${githubToken}`,
				...COPILOT_HEADERS,
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
