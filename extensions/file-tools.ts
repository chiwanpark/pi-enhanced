import { Type, type Static } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, matchesGlob } from "node:path";

const DEFAULT_IGNORES = [
	"**/.git/**",
	"**/node_modules/**",
	"**/dist/**",
	"**/build/**",
	"**/coverage/**",
	"**/.next/**",
	"**/.turbo/**",
	"**/.cache/**",
] as const;

const MAX_RESULTS_CAP = 1_000;
const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_PER_FILE_BYTES = 200_000;

const GlobParams = Type.Object({
	pattern: Type.String({ description: "Glob pattern to match, relative to cwd or path. Supports *, ?, and **." }),
	path: Type.Optional(
		Type.String({ description: "Directory to search within. Defaults to the current working directory." }),
	),
	includeHidden: Type.Optional(
		Type.Boolean({ description: "Include hidden files and directories. Defaults to false." }),
	),
	maxResults: Type.Optional(
		Type.Number({ description: "Maximum matched paths to return. Defaults to 200, capped at 1000." }),
	),
});

const GrepParams = Type.Object({
	pattern: Type.String({ description: "Text or regular expression to search for." }),
	path: Type.Optional(
		Type.String({ description: "File or directory to search. Defaults to the current working directory." }),
	),
	glob: Type.Optional(Type.String({ description: "Optional file glob filter such as **/*.ts." })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal text instead of a regular expression. Defaults to false." }),
	),
	caseSensitive: Type.Optional(Type.Boolean({ description: "Use case-sensitive matching. Defaults to true." })),
	includeHidden: Type.Optional(
		Type.Boolean({ description: "Include hidden files and directories. Defaults to false." }),
	),
	maxResults: Type.Optional(
		Type.Number({ description: "Maximum matching lines to return. Defaults to 200, capped at 1000." }),
	),
});

const LsParams = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list. Defaults to the current working directory." })),
	recursive: Type.Optional(Type.Boolean({ description: "List recursively. Defaults to false." })),
	depth: Type.Optional(Type.Number({ description: "Maximum recursive depth. Defaults to 1, capped at 10." })),
	includeHidden: Type.Optional(
		Type.Boolean({ description: "Include hidden files and directories. Defaults to false." }),
	),
	maxEntries: Type.Optional(
		Type.Number({ description: "Maximum entries to return. Defaults to 200, capped at 1000." }),
	),
});

type GlobInput = Static<typeof GlobParams>;
type GrepInput = Static<typeof GrepParams>;
type LsInput = Static<typeof LsParams>;
type Entry = { path: string; type: "file" | "directory" | "symlink" | "other" };
type Match = { path: string; line: number; text: string };

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizePath(input: string | undefined): string {
	const path = input?.trim() || ".";
	return path.startsWith("@") ? path.slice(1) : path;
}

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function safeResolve(ctx: ExtensionContext, input: string | undefined): Promise<string> {
	const root = await realpath(ctx.cwd);
	const candidate = resolve(root, normalizePath(input));
	if (!isInside(root, candidate)) throw new Error(`Path escapes the workspace: ${input ?? "."}`);

	try {
		const canonical = await realpath(candidate);
		if (!isInside(root, canonical)) throw new Error(`Path escapes the workspace via symlink: ${input ?? "."}`);
		return canonical;
	} catch (error) {
		if (error instanceof Error && error.message.includes("escapes the workspace")) throw error;
		return candidate;
	}
}

function toRelative(ctx: ExtensionContext, absolutePath: string): string {
	const rel = relative(ctx.cwd, absolutePath).split(sep).join("/");
	return rel === "" ? "." : rel;
}

function isHiddenRelative(path: string): boolean {
	return path.split("/").some((part) => part.startsWith("."));
}

function shouldIgnore(relPath: string, includeHidden: boolean): boolean {
	if (!includeHidden && isHiddenRelative(relPath)) return true;
	return DEFAULT_IGNORES.some((pattern) => matchesGlob(relPath, pattern));
}

function entryType(dirent: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): Entry["type"] {
	if (dirent.isDirectory()) return "directory";
	if (dirent.isFile()) return "file";
	if (dirent.isSymbolicLink()) return "symlink";
	return "other";
}

async function walkFiles(
	ctx: ExtensionContext,
	root: string,
	options: {
		includeHidden: boolean;
		maxEntries: number;
		signal?: AbortSignal | undefined;
		includeDirectories?: boolean;
		depth?: number;
	},
): Promise<Entry[]> {
	const entries: Entry[] = [];
	const maxDepth = options.depth ?? Number.POSITIVE_INFINITY;

	async function visit(directory: string, depth: number): Promise<void> {
		options.signal?.throwIfAborted();
		if (entries.length >= options.maxEntries) return;

		const dir = await opendir(directory);
		for await (const dirent of dir) {
			options.signal?.throwIfAborted();
			const absolutePath = resolve(directory, dirent.name);
			const relPath = toRelative(ctx, absolutePath);
			if (shouldIgnore(relPath, options.includeHidden)) continue;

			const type = entryType(dirent);
			if (type !== "directory" || options.includeDirectories) {
				entries.push({ path: relPath, type });
				if (entries.length >= options.maxEntries) return;
			}

			if (type === "directory" && depth < maxDepth) {
				await visit(absolutePath, depth + 1);
				if (entries.length >= options.maxEntries) return;
			}
		}
	}

	const rootStat = await stat(root);
	if (rootStat.isFile()) return [{ path: toRelative(ctx, root), type: "file" }];
	if (!rootStat.isDirectory()) return [{ path: toRelative(ctx, root), type: "other" }];

	await visit(root, 0);
	return entries;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePattern(params: GrepInput): RegExp {
	try {
		return new RegExp(
			params.literal ? escapeRegExp(params.pattern) : params.pattern,
			params.caseSensitive === false ? "i" : "",
		);
	} catch (error) {
		throw new Error(`Invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}
}

function looksBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, Math.min(buffer.length, 8_000)).includes(0);
}

async function readTextFile(
	path: string,
	maxBytes: number,
): Promise<{ text: string; bytes: number; truncatedByBytes: boolean }> {
	const buffer = await readFile(path);
	if (looksBinary(buffer)) throw new Error("binary file skipped");
	const slice = buffer.subarray(0, maxBytes);
	return { text: slice.toString("utf8"), bytes: slice.length, truncatedByBytes: buffer.length > maxBytes };
}

function formatEntries(entries: Entry[], truncated: boolean): string {
	const lines = entries.map((entry) => `${entry.path}${entry.type === "directory" ? "/" : ""}`);
	if (truncated) lines.push("... truncated; increase limit or narrow the path/pattern");
	return lines.length === 0 ? "No entries found." : lines.join("\n");
}

function formatMatches(matches: Match[], truncated: boolean): string {
	const lines = matches.map((match) => `${match.path}:${match.line}: ${match.text}`);
	if (truncated) lines.push("... truncated; increase maxResults or narrow the search");
	return lines.length === 0 ? "No matches found." : lines.join("\n");
}

export default function fileToolsExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glob",
		label: "Glob",
		description: "Find files by glob pattern inside the current workspace, with safe defaults and bounded results.",
		promptSnippet: "Find files by glob pattern with bounded results and common generated directories ignored.",
		promptGuidelines: [
			"Use glob for scoped file discovery instead of broad find/tree/bash scans.",
			"Keep glob patterns narrow and avoid searching generated directories unless explicitly needed.",
		],
		parameters: GlobParams,
		async execute(_toolCallId, params: GlobInput, signal, _onUpdate, ctx) {
			const root = await safeResolve(ctx, params.path);
			const maxResults = clamp(params.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CAP);
			const entries = await walkFiles(ctx, root, {
				includeHidden: params.includeHidden === true,
				maxEntries: maxResults + 1,
				signal,
			});
			const matches = entries.filter((entry) => entry.type === "file" && matchesGlob(entry.path, params.pattern));
			const limited = matches.slice(0, maxResults);
			return {
				content: [{ type: "text" as const, text: formatEntries(limited, matches.length > maxResults) }],
				details: { matches: limited },
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("glob"))} ${theme.fg("text", args.pattern)}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "grep",
		label: "Grep",
		description: "Search text files inside the current workspace with optional glob filtering and bounded results.",
		promptSnippet: "Search text files with optional file glob filters and bounded results.",
		promptGuidelines: [
			"Use grep for literal strings, docs, config keys, routes, CSS classes, or unsupported languages; prefer LSP/AST tools for code symbols.",
			"Always scope grep with path or glob when possible to keep searches efficient.",
		],
		parameters: GrepParams,
		async execute(_toolCallId, params: GrepInput, signal, _onUpdate, ctx) {
			const root = await safeResolve(ctx, params.path);
			const maxResults = clamp(params.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CAP);
			const regex = compilePattern(params);
			const entries = await walkFiles(ctx, root, {
				includeHidden: params.includeHidden === true,
				maxEntries: 10_000,
				signal,
			});
			const matches: Match[] = [];

			for (const entry of entries) {
				signal?.throwIfAborted();
				if (entry.type !== "file") continue;
				if (params.glob && !matchesGlob(entry.path, params.glob)) continue;
				try {
					const { text } = await readTextFile(resolve(ctx.cwd, entry.path), DEFAULT_PER_FILE_BYTES);
					const lines = text.split(/\r?\n/);
					for (let index = 0; index < lines.length; index += 1) {
						const line = lines[index] ?? "";
						regex.lastIndex = 0;
						if (!regex.test(line)) continue;
						matches.push({ path: entry.path, line: index + 1, text: line });
						if (matches.length >= maxResults + 1) break;
					}
				} catch {
					// Skip unreadable and binary files; grep should be best-effort.
				}
				if (matches.length >= maxResults + 1) break;
			}

			const limited = matches.slice(0, maxResults);
			return {
				content: [{ type: "text" as const, text: formatMatches(limited, matches.length > maxResults) }],
				details: { matches: limited },
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("text", args.pattern)}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "ls",
		label: "List",
		description: "List directory entries inside the current workspace with bounded output.",
		promptSnippet: "List directory entries with bounded output.",
		promptGuidelines: ["Use ls for targeted directory inspection; use code_overview for initial repository mapping."],
		parameters: LsParams,
		async execute(_toolCallId, params: LsInput, signal, _onUpdate, ctx) {
			const root = await safeResolve(ctx, params.path);
			const maxEntries = clamp(params.maxEntries, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CAP);
			const depth = params.recursive === true ? clamp(params.depth, 3, 0, 10) : 0;
			const entries = await walkFiles(ctx, root, {
				includeHidden: params.includeHidden === true,
				maxEntries: maxEntries + 1,
				signal,
				includeDirectories: true,
				depth,
			});
			const limited = entries.slice(0, maxEntries);
			return {
				content: [{ type: "text" as const, text: formatEntries(limited, entries.length > maxEntries) }],
				details: { entries: limited },
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("text", args.path ?? ".")}`, 0, 0);
		},
	});
}
