import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 2_000;
/** Files larger than this are not diffed for the lines-of-code metric. */
export const MAX_DIFFED_FILE_BYTES = 10 * 1024 * 1024;

async function git(args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await run("git", args, { timeout: GIT_TIMEOUT_MS, encoding: "utf8" });
		const trimmed = stdout.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/** Globally configured git email, used as a fallback when the provider credential exposes none. */
export async function gitUserEmail(): Promise<string | undefined> {
	return git(["config", "--global", "--get", "user.email"]);
}

/**
 * Text content of a file for diffing: an empty string when it does not exist yet, and undefined
 * when it is binary, too large, or unreadable, so the caller can skip the measurement.
 */
export async function readTextForDiff(filePath: string): Promise<string | undefined> {
	try {
		const data = await readFile(filePath);
		if (data.length > MAX_DIFFED_FILE_BYTES || data.includes(0)) return undefined;
		return data.toString("utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : undefined;
	}
}
