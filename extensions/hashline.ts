import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
	generateDiffString,
	generateUnifiedPatch,
	renderDiff,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadToolDetails,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { annotateReadOutput } from "./internal/hashline/annotate.ts";
import {
	applyHashlineEdits,
	collectSeenAfterEdit,
	EDIT_OPS,
	HashlineEditError,
	type AppliedRegion,
	type HashlineEdit,
} from "./internal/hashline/apply.ts";
import { AnnotationRegistry, applyContextAnnotations } from "./internal/hashline/context.ts";
import { prepareEditArguments } from "./internal/hashline/params.ts";
import { buildPreview, summarizeEdit } from "./internal/hashline/preview.ts";
import { SnapshotStore } from "./internal/hashline/store.ts";
import { computeTag, decodeText, encodeText, formatHeader, TAG_RE } from "./internal/hashline/text.ts";

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	tag: Type.String({
		description: "The 4-hex tag from the [path#TAG] header of the latest read of this file.",
	}),
	edits: Type.Array(
		Type.Object({
			op: Type.Union(
				EDIT_OPS.map((op) => Type.Literal(op)),
				{ description: "replace, delete, insert_before or insert_after" },
			),
			from: Type.Number({
				description:
					"First line of the range for replace/delete, or the anchor line for insert_before/insert_after. Use 0 with insert_after to prepend to the file.",
			}),
			to: Type.Optional(
				Type.Number({ description: "Last line of the range for replace/delete (inclusive). Defaults to from." }),
			),
			lines: Type.Optional(
				Type.Array(Type.String(), {
					description: "New lines, without line-number prefixes and without trailing newline characters.",
				}),
			),
		}),
		{ description: "Operations addressing the line numbers of the tagged snapshot." },
	),
});

type EditToolInput = Static<typeof editSchema>;

const DESCRIPTION = `Edit a text file by line number, anchored to the \`[path#TAG]\` header from the latest \`read\` of that file.

- \`tag\` must match the latest \`read\`. If the file changed since then the edit is rejected; re-read and retry.
- Line numbers address the tagged snapshot. Earlier edits in the same call never shift later ones.
- You may only touch lines that were actually displayed to you. \`read\` the range first.
- \`replace\` swaps from..to for \`lines\`; \`delete\` removes from..to; \`insert_before\` and \`insert_after\` add \`lines\` next to \`from\` (\`insert_after\` with from=0 prepends to the file).
- \`to\` defaults to \`from\`. Never put the \`N:\` \`read\` prefix inside \`lines\`.
- The result returns the new tag plus the changed region with fresh numbers, so consecutive edits need no re-read.
- Use \`write\` to create a file or to replace it entirely.`;

const GUIDELINES = [
	"`read` returns a `[path#TAG]` header plus `N:content` lines; call `edit` with that tag and those line numbers.",
	"Never copy the `N:` line-number prefix from `read` output into `edit` content.",
];

function toDisplayPath(absolutePath: string, cwd: string): string {
	const relativePath = relative(cwd, absolutePath);
	if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) return absolutePath;
	return relativePath;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function readPathArg(input: Record<string, unknown>): string | undefined {
	const path = input.path ?? input.file_path;
	return typeof path === "string" ? path : undefined;
}

async function readSnapshotSource(absolutePath: string): Promise<ReturnType<typeof decodeText>> {
	const raw = await readFile(absolutePath, "utf-8");
	return decodeText(raw);
}

function targetedRegions(edits: readonly { from: number; to?: number }[], lineCount: number): AppliedRegion[] {
	const regions: AppliedRegion[] = [];
	for (const edit of edits) {
		if (typeof edit?.from !== "number") continue;
		const from = Math.max(1, Math.min(Math.floor(edit.from), lineCount));
		const to = Math.max(from, Math.min(Math.floor(edit.to ?? edit.from), lineCount));
		if (lineCount > 0) regions.push({ from, to });
	}
	return regions;
}

export default function hashlineExtension(pi: ExtensionAPI): void {
	const store = new SnapshotStore();
	const registry = new AnnotationRegistry();

	const editTool: ToolDefinition<typeof editSchema, { diff: string; patch: string; firstChangedLine?: number }> = {
		name: "edit",
		label: "edit",
		description: DESCRIPTION,
		promptSnippet: "Edit files by line number against the tag from the latest read",
		promptGuidelines: GUIDELINES,
		parameters: editSchema,
		prepareArguments: (args: unknown) => prepareEditArguments(args) as EditToolInput,
		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			const cwd = ctx?.cwd ?? process.cwd();
			const absolutePath = resolve(cwd, params.path);
			const displayPath = toDisplayPath(absolutePath, cwd);

			return withFileMutationQueue(absolutePath, async () => {
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};
				throwIfAborted();

				let decoded: ReturnType<typeof decodeText>;
				try {
					decoded = await readSnapshotSource(absolutePath);
				} catch (error) {
					const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
					throw new HashlineEditError(
						code === "ENOENT" ? "E_NOT_FOUND" : "E_ACCESS",
						`could not read ${displayPath} (${code}). Use write to create a new file.`,
					);
				}
				throwIfAborted();

				const snapshot = store.get(absolutePath);
				if (!snapshot) {
					throw new HashlineEditError(
						"E_NO_SNAPSHOT",
						`no read of ${displayPath} in this session. Read the file first, then edit with the tag it returns.`,
					);
				}
				if (snapshot.content !== decoded.content) {
					store.forget(absolutePath);
					throw new HashlineEditError(
						"E_STALE_FILE",
						`${displayPath} changed on disk since your last read. Nothing was written. Read it again for fresh line numbers.`,
					);
				}
				if (!TAG_RE.test(params.tag)) {
					throw new HashlineEditError(
						"E_BAD_TAG",
						`tag must be the 4-hex value from the [${displayPath}#....] header; got "${params.tag}".`,
					);
				}
				if (params.tag !== snapshot.tag) {
					const regions = targetedRegions(params.edits, snapshot.lines.length);
					const context =
						regions.length > 0
							? buildPreview(displayPath, snapshot.tag, snapshot.lines, regions, { maxLines: 40 })
							: undefined;
					if (context) store.markSeen(absolutePath, context.shown);
					throw new HashlineEditError(
						"E_STALE_TAG",
						`tag ${params.tag} is not current for ${displayPath}; nothing was written. The current tag is ${snapshot.tag}. Verify your line numbers against the current content below and retry with that tag.${context ? `\n${context.text}` : ""}`,
					);
				}

				const result = applyHashlineEdits(snapshot, params.edits as HashlineEdit[]);
				throwIfAborted();

				await writeFile(absolutePath, encodeText(result.content, decoded), "utf-8");

				const carried = collectSeenAfterEdit(snapshot, result.spans);
				const updated = store.replace(absolutePath, result.content, carried);
				const tag = updated?.tag ?? snapshot.tag;
				const preview = buildPreview(displayPath, tag, result.lines, result.regions);
				if (updated) store.markSeen(absolutePath, preview.shown);

				const diffResult = generateDiffString(snapshot.content, result.content);
				const patch = generateUnifiedPatch(displayPath, snapshot.content, result.content);
				const summary = summarizeEdit(params.edits.length, result.addedLines, result.removedLines);

				return {
					content: [{ type: "text" as const, text: `${summary}\n${preview.text}` }],
					details: {
						diff: diffResult.diff,
						patch,
						...(diffResult.firstChangedLine === undefined ? {} : { firstChangedLine: diffResult.firstChangedLine }),
					},
				};
			});
		},
		renderCall(args, theme, context) {
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const rawPath = typeof args?.path === "string" ? args.path : "";
			const count = Array.isArray(args?.edits) ? args.edits.length : 0;
			const suffix = count > 0 ? theme.fg("muted", ` (${count} ${count === 1 ? "edit" : "edits"})`) : "";
			component.setText(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", rawPath)}${suffix}`);
			return component;
		},
		renderResult(result, _options, theme, context) {
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 1, 0);
			const text = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
			if (context.isError) {
				component.setText(`\n${theme.fg("error", text)}`);
				return component;
			}
			const diff = result.details?.diff;
			const rawPath = typeof context.args?.path === "string" ? context.args.path : undefined;
			component.setText(
				diff ? `\n${renderDiff(diff, rawPath ? { filePath: rawPath } : {})}` : `\n${theme.fg("toolOutput", text)}`,
			);
			return component;
		},
	};

	pi.registerTool(editTool);

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return undefined;
		if (event.toolName !== "read" && event.toolName !== "write") return undefined;

		const input = asRecord(event.input) ?? {};
		const rawPath = readPathArg(input);
		if (!rawPath) return undefined;
		if (event.toolName === "read" && event.content.some((part) => part.type !== "text")) return undefined;
		const absolutePath = resolve(ctx.cwd, rawPath);
		const displayPath = toDisplayPath(absolutePath, ctx.cwd);

		let decoded: ReturnType<typeof decodeText>;
		try {
			decoded = await readSnapshotSource(absolutePath);
		} catch {
			return undefined;
		}

		if (event.toolName === "write") {
			const snapshot = store.record(absolutePath, decoded.content, "all");
			if (!snapshot) return undefined;
			registry.set(event.toolCallId, {
				kind: "append",
				text: `\n${formatHeader(displayPath, snapshot.tag)} (edit by these line numbers)`,
			});
			return undefined;
		}

		const textPart = event.content.find((part) => part.type === "text");
		if (!textPart || typeof textPart.text !== "string") return undefined;

		const offset = typeof input.offset === "number" && input.offset >= 1 ? Math.floor(input.offset) : 1;
		const truncation = (event.details as ReadToolDetails | undefined)?.truncation;
		const annotated = annotateReadOutput({
			output: textPart.text,
			fileLines: decoded.lines,
			displayPath,
			tag: computeTag(decoded.content),
			offset,
			...(truncation?.truncated ? { outputLines: truncation.outputLines } : {}),
		});
		if (!annotated) return undefined;

		const snapshot = store.record(absolutePath, decoded.content, annotated.shown ? [annotated.shown] : []);
		if (!snapshot) return undefined;

		registry.set(event.toolCallId, {
			kind: "read",
			header: annotated.header,
			offset,
			shownCount: annotated.shownCount,
		});
		return undefined;
	});

	pi.on("context", async (event) => {
		return applyContextAnnotations(event.messages, registry) ? { messages: event.messages } : undefined;
	});
}
