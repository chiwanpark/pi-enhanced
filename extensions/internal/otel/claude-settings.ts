import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Only telemetry keys are adopted, so unrelated secrets in the `env` block are never read. */
const TELEMETRY_KEY_PREFIXES = ["OTEL_", "CLAUDE_CODE_OTEL_"] as const;
const TELEMETRY_KEYS = ["CLAUDE_CODE_ENABLE_TELEMETRY"] as const;

export interface ClaudeSettingsLookup {
	cwd: string;
	home?: string;
	platform?: NodeJS.Platform;
}

function systemSettingsDir(platform: NodeJS.Platform): string {
	if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
	if (platform === "win32") return path.join("C:\\", "Program Files", "ClaudeCode");
	return "/etc/claude-code";
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function managedDropIns(systemDir: string): string[] {
	try {
		return readdirSync(path.join(systemDir, "managed-settings.d"))
			.filter((name) => name.endsWith(".json") && !name.startsWith("."))
			.sort()
			.map((name) => path.join(systemDir, "managed-settings.d", name));
	} catch {
		return [];
	}
}

/**
 * Claude Code settings files that can carry a telemetry `env` block, ordered from lowest to
 * highest precedence so a later file overrides an earlier one.
 */
export function claudeCodeSettingsFiles(lookup: ClaudeSettingsLookup): string[] {
	const home = lookup.home ?? os.homedir();
	const platform = lookup.platform ?? process.platform;
	const systemDir = systemSettingsDir(platform);

	return [
		path.join(home, ".claude", "settings.json"),
		path.join(lookup.cwd, ".claude", "settings.json"),
		path.join(lookup.cwd, ".claude", "settings.local.json"),
		path.join(systemDir, "managed-settings.json"),
		...managedDropIns(systemDir),
		// Server-managed settings occupy the top of the Claude Code managed tier.
		path.join(home, ".claude", "remote-settings.json"),
	];
}

function isTelemetryKey(key: string): boolean {
	if ((TELEMETRY_KEYS as readonly string[]).includes(key)) return true;
	return TELEMETRY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function telemetryEnvFromSettings(settings: Record<string, unknown> | null): Record<string, string> {
	const env = settings?.["env"];
	if (!env || typeof env !== "object" || Array.isArray(env)) return {};

	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
		if (!isTelemetryKey(key)) continue;
		if (typeof value === "string") result[key] = value;
		else if (typeof value === "number" || typeof value === "boolean") result[key] = String(value);
	}
	return result;
}

/**
 * Collect the telemetry environment variables Claude Code would apply on this machine, so pi can
 * report to the same collector without repeating the endpoint and credentials.
 */
export function readClaudeCodeTelemetryEnv(lookup: ClaudeSettingsLookup): Record<string, string> {
	let merged: Record<string, string> = {};
	for (const file of claudeCodeSettingsFiles(lookup)) {
		merged = { ...merged, ...telemetryEnvFromSettings(readJsonObject(file)) };
	}
	return merged;
}
