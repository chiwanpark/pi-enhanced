import { createHash } from "node:crypto";

export const TAG_LENGTH = 4;
export const TAG_RE = new RegExp(`^[0-9A-F]{${TAG_LENGTH}}$`);

export interface DecodedText {
	bom: string;
	eol: "\n" | "\r\n";
	trailingNewline: boolean;
	content: string;
	lines: string[];
}

export function detectLineEnding(text: string): "\n" | "\r\n" {
	const crlf = text.indexOf("\r\n");
	if (crlf === -1) return "\n";
	const lf = text.indexOf("\n");
	return crlf + 1 === lf ? "\r\n" : "\n";
}

export function splitLines(content: string): string[] {
	if (content === "") return [];
	const lines = content.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function decodeText(raw: string): DecodedText {
	const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
	const body = bom === "" ? raw : raw.slice(1);
	const eol = detectLineEnding(body);
	const content = body.replace(/\r\n/g, "\n");
	return {
		bom,
		eol,
		trailingNewline: content.endsWith("\n"),
		content,
		lines: splitLines(content),
	};
}

export function joinLines(lines: string[], trailingNewline: boolean): string {
	if (lines.length === 0) return "";
	return trailingNewline ? `${lines.join("\n")}\n` : lines.join("\n");
}

export function encodeText(content: string, decoded: Pick<DecodedText, "bom" | "eol">): string {
	const body = decoded.eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
	return `${decoded.bom}${body}`;
}

export function computeTag(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, TAG_LENGTH).toUpperCase();
}

export function formatHeader(displayPath: string, tag: string): string {
	return `[${displayPath}#${tag}]`;
}

export function formatNumberedLines(lines: string[], startLine: number): string[] {
	return lines.map((line, index) => `${startLine + index}:${line}`);
}
