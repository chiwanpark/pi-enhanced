import { normalizeOutputLine } from "./annotate.ts";

export interface ReadAnnotation {
	kind: "read";
	header: string;
	offset: number;
	shownCount: number;
}

export interface AppendAnnotation {
	kind: "append";
	text: string;
}

export type ContextAnnotation = ReadAnnotation | AppendAnnotation;

const MAX_ANNOTATIONS = 8192;

export class AnnotationRegistry {
	private readonly entries = new Map<string, ContextAnnotation>();

	set(toolCallId: string, annotation: ContextAnnotation): void {
		if (this.entries.size >= MAX_ANNOTATIONS && !this.entries.has(toolCallId)) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		this.entries.set(toolCallId, annotation);
	}

	get(toolCallId: string): ContextAnnotation | undefined {
		return this.entries.get(toolCallId);
	}

	get size(): number {
		return this.entries.size;
	}
}

interface TextPartLike {
	type?: unknown;
	text?: unknown;
}

interface MessageLike {
	role?: unknown;
	toolCallId?: unknown;
	isError?: unknown;
	content?: unknown;
}

function annotateReadText(text: string, annotation: ReadAnnotation): string | undefined {
	if (text.startsWith(annotation.header)) return undefined;
	const lines = text.split("\n");
	const rewritten = lines.map((line, index) =>
		index < annotation.shownCount
			? `${annotation.offset + index}:${normalizeOutputLine(line, annotation.offset === 1 && index === 0)}`
			: line,
	);
	return [annotation.header, ...rewritten].join("\n");
}

export function applyContextAnnotations(messages: readonly unknown[], registry: AnnotationRegistry): boolean {
	if (registry.size === 0) return false;

	let changed = false;
	for (const raw of messages) {
		const message = raw as MessageLike;
		if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
		if (message.isError === true) continue;
		const annotation = registry.get(message.toolCallId);
		if (!annotation || !Array.isArray(message.content)) continue;

		if (annotation.kind === "append") {
			const last = message.content[message.content.length - 1] as TextPartLike | undefined;
			if (last?.type === "text" && typeof last.text === "string" && last.text.endsWith(annotation.text)) continue;
			message.content.push({ type: "text", text: annotation.text });
			changed = true;
			continue;
		}

		const part = message.content.find((entry: TextPartLike) => entry?.type === "text") as TextPartLike | undefined;
		if (!part || typeof part.text !== "string") continue;
		const annotated = annotateReadText(part.text, annotation);
		if (annotated === undefined) continue;
		part.text = annotated;
		changed = true;
	}
	return changed;
}
