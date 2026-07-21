import { Type, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep, matchesGlob } from "node:path";

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
const DEFAULT_IGNORES_DESCRIPTION =
	"Apply default ignores: .git, node_modules, dist, build, coverage, .next, .turbo, and .cache. Defaults to true; set false to include them.";

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
	useDefaultIgnores: Type.Optional(Type.Boolean({ description: DEFAULT_IGNORES_DESCRIPTION })),
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
	useDefaultIgnores: Type.Optional(Type.Boolean({ description: DEFAULT_IGNORES_DESCRIPTION })),
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
	useDefaultIgnores: Type.Optional(Type.Boolean({ description: DEFAULT_IGNORES_DESCRIPTION })),
	maxEntries: Type.Optional(
		Type.Number({ description: "Maximum entries to return. Defaults to 200, capped at 1000." }),
	),
});

type GlobInput = Static<typeof GlobParams>;
type GrepInput = Static<typeof GrepParams>;
type LsInput = Static<typeof LsParams>;
type Entry = {
	path: string;
	absolutePath: string;
	type: "file" | "directory" | "symlink" | "other";
	targetType?: "file" | "directory" | "other";
};
type Match = { path: string; line: number; text: string };

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizePath(input: string | undefined): string {
	const path = input?.trim() || ".";
	return path.startsWith("@") ? path.slice(1) : path;
}

function toRelative(ctx: ExtensionContext, absolutePath: string): string {
	const rel = relative(resolve(ctx.cwd), absolutePath).split(sep).join("/");
	return rel === "" ? "." : rel;
}

function isHiddenRelative(path: string): boolean {
	return path.split("/").some((part) => part !== "." && part !== ".." && part.startsWith("."));
}

function shouldIgnore(relPath: string, includeHidden: boolean, useDefaultIgnores: boolean): boolean {
	if (!includeHidden && isHiddenRelative(relPath)) return true;
	return useDefaultIgnores && DEFAULT_IGNORES.some((pattern) => matchesGlob(relPath, pattern));
}

function entryType(dirent: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): Entry["type"] {
	if (dirent.isDirectory()) return "directory";
	if (dirent.isFile()) return "file";
	if (dirent.isSymbolicLink()) return "symlink";
	return "other";
}

async function targetType(path: string): Promise<Entry["targetType"]> {
	try {
		const stats = await stat(path);
		if (stats.isDirectory()) return "directory";
		if (stats.isFile()) return "file";
		return "other";
	} catch {
		return undefined;
	}
}

function isFileEntry(entry: Entry): boolean {
	return entry.type === "file" || (entry.type === "symlink" && entry.targetType === "file");
}

function isDirectoryEntry(entry: Entry): boolean {
	return entry.type === "directory" || (entry.type === "symlink" && entry.targetType === "directory");
}

function matchesEntryPattern(entry: Entry, root: string, pattern: string): boolean {
	const rootRelative = relative(root, entry.absolutePath).split(sep).join("/") || entry.path;
	return matchesGlob(entry.path, pattern) || matchesGlob(rootRelative, pattern);
}

async function walkFiles(
	ctx: ExtensionContext,
	root: string,
	options: {
		includeHidden: boolean;
		useDefaultIgnores: boolean;
		maxEntries: number;
		signal?: AbortSignal | undefined;
		includeDirectories?: boolean;
		depth?: number;
		onEntry?: (entry: Entry) => boolean;
	},
): Promise<Entry[]> {
	const entries: Entry[] = [];
	const maxDepth = options.depth ?? Number.POSITIVE_INFINITY;
	const visitedDirectories = new Set<string>();

	function addEntry(entry: Entry): boolean {
		if (options.onEntry && !options.onEntry(entry)) return entries.length >= options.maxEntries;
		entries.push(entry);
		return entries.length >= options.maxEntries;
	}

	async function visit(directory: string, depth: number): Promise<void> {
		options.signal?.throwIfAborted();
		if (entries.length >= options.maxEntries) return;

		try {
			const canonicalDirectory = await realpath(directory);
			if (visitedDirectories.has(canonicalDirectory)) return;
			visitedDirectories.add(canonicalDirectory);
		} catch {
			// Let opendir surface the concrete filesystem error below.
		}

		const dir = await opendir(directory);
		for await (const dirent of dir) {
			options.signal?.throwIfAborted();
			const absolutePath = resolve(directory, dirent.name);
			const relPath = toRelative(ctx, absolutePath);
			if (shouldIgnore(relPath, options.includeHidden, options.useDefaultIgnores)) continue;

			const type = entryType(dirent);
			const resolvedTargetType = type === "symlink" ? await targetType(absolutePath) : undefined;
			const entry: Entry = {
				path: relPath,
				absolutePath,
				type,
				...(resolvedTargetType ? { targetType: resolvedTargetType } : {}),
			};

			if (!isDirectoryEntry(entry) || options.includeDirectories) {
				if (addEntry(entry)) return;
			}

			if (isDirectoryEntry(entry) && depth < maxDepth) {
				await visit(absolutePath, depth + 1);
				if (entries.length >= options.maxEntries) return;
			}
		}
	}

	const rootStat = await stat(root);
	const rootEntry: Entry = {
		path: toRelative(ctx, root),
		absolutePath: root,
		type: rootStat.isFile() ? "file" : rootStat.isDirectory() ? "directory" : "other",
	};
	if (rootStat.isFile()) return !options.onEntry || options.onEntry(rootEntry) ? [rootEntry] : [];
	if (!rootStat.isDirectory()) return !options.onEntry || options.onEntry(rootEntry) ? [rootEntry] : [];

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
		description: "Find files by glob pattern, with safe defaults and bounded results.",
		parameters: GlobParams,
		async execute(_toolCallId, params: GlobInput, signal, _onUpdate, ctx) {
			const root = resolve(ctx.cwd, normalizePath(params.path));
			const maxResults = clamp(params.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CAP);
			const matches = await walkFiles(ctx, root, {
				includeHidden: params.includeHidden === true,
				useDefaultIgnores: params.useDefaultIgnores !== false,
				maxEntries: maxResults + 1,
				signal,
				onEntry: (entry) => isFileEntry(entry) && matchesEntryPattern(entry, root, params.pattern),
			});
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
		description: "Search text files with optional glob filtering and bounded results.",
		parameters: GrepParams,
		async execute(_toolCallId, params: GrepInput, signal, _onUpdate, ctx) {
			const root = resolve(ctx.cwd, normalizePath(params.path));
			const maxResults = clamp(params.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CAP);
			const regex = compilePattern(params);
			const entries = await walkFiles(ctx, root, {
				includeHidden: params.includeHidden === true,
				useDefaultIgnores: params.useDefaultIgnores !== false,
				maxEntries: 10_000,
				signal,
			});
			const matches: Match[] = [];

			for (const entry of entries) {
				signal?.throwIfAborted();
				if (!isFileEntry(entry)) continue;
				if (params.glob && !matchesEntryPattern(entry, root, params.glob)) continue;
				try {
					const { text } = await readTextFile(entry.absolutePath, DEFAULT_PER_FILE_BYTES);
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
		description: "List directory entries with bounded output.",
		parameters: LsParams,
		async execute(_toolCallId, params: LsInput, signal, _onUpdate, ctx) {
			const root = resolve(ctx.cwd, normalizePath(params.path));
			const maxEntries = clamp(params.maxEntries, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CAP);
			const depth = params.recursive === true ? clamp(params.depth, 3, 0, 10) : 0;
			const entries = await walkFiles(ctx, root, {
				includeHidden: params.includeHidden === true,
				useDefaultIgnores: params.useDefaultIgnores !== false,
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
