import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUsageAuth, type AuthData } from "../usage-status.ts";
import { readClaudeCodeIdentity } from "./claude-settings.ts";

export const OTEL_IDENTITY_FILE = path.join(os.homedir(), ".pi", "agent", "pi-enhanced-otel.json");

export interface OtelIdentity {
	/** Stable anonymous installation id, the analogue of Claude Code's `user.id`. */
	userId: string;
	email: string | undefined;
	accountUuid: string | undefined;
	organizationId: string | undefined;
}

export interface IdentityOptions {
	identityFile?: string;
	claudeCode?: boolean;
	home?: string;
}

type IdentityFile = {
	userId?: unknown;
};

type CodexTokenPayload = {
	"https://api.openai.com/auth"?: { chatgpt_account_id?: string };
	"https://api.openai.com/profile"?: { email?: string };
};

function decodeJwtPayload<T>(token: string): T | null {
	const parts = token.split(".");
	if (parts.length < 2) return null;
	try {
		const payload = parts[1] ?? "";
		const normalized = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
		return JSON.parse(Buffer.from(normalized, "base64url").toString("utf8")) as T;
	} catch {
		return null;
	}
}

/** Read the persisted anonymous id, creating it on first run. Falls back to an ephemeral id when unwritable. */
export function loadOrCreateUserId(identityFile = OTEL_IDENTITY_FILE): string {
	try {
		const parsed = JSON.parse(readFileSync(identityFile, "utf8")) as IdentityFile;
		if (typeof parsed.userId === "string" && parsed.userId.length > 0) return parsed.userId;
	} catch {
		// Missing or unreadable file: fall through and create one.
	}

	const userId = randomUUID();
	try {
		mkdirSync(path.dirname(identityFile), { recursive: true });
		writeFileSync(identityFile, `${JSON.stringify({ userId }, null, 2)}\n`, "utf8");
	} catch {
		// Read-only home: keep the ephemeral id for this process.
	}
	return userId;
}

/** Best-effort offline account lookup for the active provider. Never performs network calls. */
export function readAccountIdentity(
	provider: string | undefined,
	auth: AuthData | null,
): Pick<OtelIdentity, "email" | "accountUuid"> {
	if (!provider || !auth) return { email: undefined, accountUuid: undefined };

	if (provider === "openai-codex") {
		const token = auth[provider]?.access;
		const payload = token ? decodeJwtPayload<CodexTokenPayload>(token) : null;
		return {
			email: payload?.["https://api.openai.com/profile"]?.email,
			accountUuid: payload?.["https://api.openai.com/auth"]?.chatgpt_account_id,
		};
	}

	const entry = auth[provider] as ({ email?: unknown; accountUuid?: unknown } & Record<string, unknown>) | undefined;
	return {
		email: typeof entry?.email === "string" ? entry.email : undefined,
		accountUuid: typeof entry?.accountUuid === "string" ? entry.accountUuid : undefined,
	};
}

/**
 * Identity for the standard attributes. With `claudeCode` on, the values Claude Code reports on this
 * machine win, so pi's rows join the ones its dashboards already group; the provider account and pi's
 * own anonymous id fill whatever Claude Code leaves unknown.
 */
export function loadIdentity(provider: string | undefined, options: IdentityOptions = {}): OtelIdentity {
	let auth: AuthData | null;
	try {
		auth = readUsageAuth();
	} catch {
		auth = null;
	}
	const account = readAccountIdentity(provider, auth);
	const claudeCode = options.claudeCode ? readClaudeCodeIdentity(options.home) : undefined;

	return {
		userId: claudeCode?.userId ?? loadOrCreateUserId(options.identityFile ?? OTEL_IDENTITY_FILE),
		email: claudeCode?.email ?? account.email,
		accountUuid: claudeCode?.accountUuid ?? account.accountUuid,
		organizationId: claudeCode?.organizationId,
	};
}

/** Terminal identifier comparable to Claude Code's `terminal.type`. */
export function detectTerminalType(env: Record<string, string | undefined> = process.env): string | undefined {
	if (env["TMUX"]) return "tmux";
	for (const key of ["TERM_PROGRAM", "TERMINAL_EMULATOR"]) {
		const value = env[key];
		if (value && value.trim().length > 0) return value.trim();
	}
	if (env["WT_SESSION"]) return "Windows Terminal";
	if (env["KONSOLE_VERSION"]) return "konsole";
	const term = env["TERM"];
	return term && term.trim().length > 0 ? term.trim() : undefined;
}

/**
 * How this pi process was launched, using Claude Code's `app.entrypoint` vocabulary so dashboards
 * that filter on it keep working: RPC sessions report `sdk-cli`, everything else reports `cli`.
 */
export function detectEntrypoint(
	mode: string | undefined,
	env: Record<string, string | undefined> = process.env,
): string {
	const override = env["PI_ENHANCED_ENTRYPOINT"];
	if (override && override.trim().length > 0) return override.trim();
	return mode === "rpc" ? "sdk-cli" : "cli";
}

/**
 * Organization identifier for the `organization.id` attribute. pi has no organization concept, so it
 * comes from configuration or the adopted Claude Code account; it is never guessed from an email domain.
 */
export function resolveOrganizationId(
	configured: string | undefined,
	env: Record<string, string | undefined> = process.env,
	discovered?: string | undefined,
): string | undefined {
	const candidates = [configured, env["CLAUDE_CODE_ORGANIZATION_ID"], discovered];
	for (const candidate of candidates) {
		if (candidate && candidate.trim().length > 0) return candidate.trim();
	}
	return undefined;
}
