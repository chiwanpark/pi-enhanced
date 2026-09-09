import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
	byteLength,
	codeEditToolName,
	costUsdMicros,
	commandCreatesCommit,
	commandCreatesPullRequest,
	diffLineCounts,
	filePathFromToolInput,
	isAnthropicProvider,
	languageFromPath,
	serializeToolInput,
	pullRequestUrls,
	sessionStartType,
	tokenUsageEntries,
	toolErrorType,
	toolParameters,
	truncateContent,
} from "../extensions/internal/otel/mappers.ts";

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 100,
		output: 20,
		cacheRead: 300,
		cacheWrite: 40,
		totalTokens: 460,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
		...overrides,
	};
}

test("session start reasons map onto claude code start types", () => {
	assert.equal(sessionStartType("startup"), "fresh");
	assert.equal(sessionStartType("startup", true), "continue");
	assert.equal(sessionStartType("new"), "fresh");
	assert.equal(sessionStartType("new", true), "fresh");
	assert.equal(sessionStartType("resume"), "resume");
	assert.equal(sessionStartType("fork"), "continue");
	assert.equal(sessionStartType("reload"), undefined);
	assert.equal(sessionStartType("reload", true), undefined);
});

test("token usage splits into the four claude code token types", () => {
	assert.deepEqual(tokenUsageEntries(usage()), [
		{ type: "input", tokens: 100 },
		{ type: "output", tokens: 20 },
		{ type: "cacheRead", tokens: 300 },
		{ type: "cacheCreation", tokens: 40 },
	]);
});

test("token usage drops empty buckets and undefined usage", () => {
	assert.deepEqual(tokenUsageEntries(usage({ cacheRead: 0, cacheWrite: 0 })), [
		{ type: "input", tokens: 100 },
		{ type: "output", tokens: 20 },
	]);
	assert.deepEqual(tokenUsageEntries(undefined), []);
});

test("cost is reported in whole micros", () => {
	assert.equal(costUsdMicros(0.331234), 331234);
	assert.equal(costUsdMicros(0), 0);
	assert.equal(costUsdMicros(Number.NaN), 0);
});

test("unified diffs count changed lines without file headers", () => {
	const patch = [
		"--- a/file.ts",
		"+++ b/file.ts",
		"@@ -1,3 +1,4 @@",
		" keep",
		"-removed one",
		"-removed two",
		"+added one",
		"+added two",
		"+added three",
	].join("\n");
	assert.deepEqual(diffLineCounts(patch), { added: 3, removed: 2 });
	assert.deepEqual(diffLineCounts(undefined), { added: 0, removed: 0 });
});

test("commit and pull request commands are detected", () => {
	assert.equal(commandCreatesCommit('git commit -m "feat"'), true);
	assert.equal(commandCreatesCommit("git -C /tmp/repo commit --amend"), true);
	assert.equal(commandCreatesCommit("git add . && git commit -m x"), true);
	assert.equal(commandCreatesPullRequest("gh pr create --fill"), true);
	assert.equal(commandCreatesPullRequest("glab mr create"), true);
	assert.equal(commandCreatesPullRequest("hub pull-request -m x"), true);
});

test("commit detection ignores lookalikes", () => {
	assert.equal(commandCreatesCommit("git log --format=%h"), false);
	assert.equal(commandCreatesCommit("git revert HEAD"), false);
	assert.equal(commandCreatesCommit("# git commit -m x"), false);
	assert.equal(commandCreatesCommit("echo commit"), false);
	assert.equal(commandCreatesCommit(undefined), false);
	assert.equal(commandCreatesPullRequest("gh pr list"), false);
	assert.equal(commandCreatesPullRequest(undefined), false);
});

test("dry runs create nothing", () => {
	assert.equal(commandCreatesCommit("git commit --dry-run -m x"), false);
	assert.equal(commandCreatesPullRequest("gh pr create --dry-run"), false);
});

test("pull request urls are extracted and deduplicated", () => {
	assert.deepEqual(pullRequestUrls("https://github.com/acme/app/pull/42"), ["https://github.com/acme/app/pull/42"]);
	assert.deepEqual(pullRequestUrls("https://gitlab.com/acme/app/-/merge_requests/7"), [
		"https://gitlab.com/acme/app/-/merge_requests/7",
	]);
	assert.deepEqual(
		pullRequestUrls("creating...\nhttps://github.com/acme/app/pull/42\nhttps://github.com/acme/app/pull/42\n"),
		["https://github.com/acme/app/pull/42"],
	);
	assert.deepEqual(pullRequestUrls("https://github.com/acme/app/issues/42"), []);
	assert.deepEqual(pullRequestUrls(undefined), []);
});

test("pi tool names map onto claude code code edit tools", () => {
	assert.equal(codeEditToolName("edit"), "Edit");
	assert.equal(codeEditToolName("write"), "Write");
	assert.equal(codeEditToolName("bash"), undefined);
});

test("languages use claude code display names", () => {
	assert.equal(languageFromPath("src/main.ts"), "TypeScript");
	assert.equal(languageFromPath("/tmp/x/script.py"), "Python");
	assert.equal(languageFromPath("README.md"), "Markdown");
	assert.equal(languageFromPath("Dockerfile"), "Dockerfile");
	assert.equal(languageFromPath("notes.unknownext"), "unknown");
	assert.equal(languageFromPath(undefined), "unknown");
});

test("tool errors collapse into low cardinality categories", () => {
	assert.equal(toolErrorType("Error: ENOENT: no such file"), "Error:ENOENT");
	assert.equal(toolErrorType("TypeError: x is not a function"), "TypeError");
	assert.equal(toolErrorType("something odd happened"), "Error");
	assert.equal(toolErrorType(undefined), undefined);
});

test("content truncation keeps the marker inside the limit", () => {
	assert.equal(truncateContent("short", 100), "short");
	const truncated = truncateContent("x".repeat(200), 60);
	assert.equal(truncated.length, 60);
	assert.match(truncated, /\[TRUNCATED \d+ chars\]$/);
	assert.equal(truncateContent("abc", 0), "");
});

test("tool input serialization bounds values and total size", () => {
	const serialized = serializeToolInput({ path: "a.ts", content: "y".repeat(900) }, 10, 4096);
	assert.ok(serialized);
	assert.ok(serialized.includes('"path":"a.ts"'));
	assert.ok(serialized.length < 100);

	const bounded = serializeToolInput({ blob: "z".repeat(9000) }, 8000, 200);
	assert.equal(bounded?.length, 201);
	assert.equal(serializeToolInput(undefined), undefined);
});

test("bash tool parameters expose the command shape", () => {
	const params = toolParameters("bash", { command: "git commit -m x", timeout: 30 });
	assert.equal(params?.["bash_command"], "git");
	assert.equal(params?.["full_command"], "git commit -m x");
	assert.equal(params?.["timeout"], 30);
	assert.equal(params?.["git_commit"], true);
	assert.equal(toolParameters("grep", { pattern: "x" }), undefined);
});

test("file paths are read from the usual tool input keys", () => {
	assert.equal(filePathFromToolInput({ path: "a/b.ts" }), "a/b.ts");
	assert.equal(filePathFromToolInput({ file_path: "c.py" }), "c.py");
	assert.equal(filePathFromToolInput({ pattern: "x" }), undefined);
});

test("byte length counts utf8 bytes", () => {
	assert.equal(byteLength("abc"), 3);
	assert.equal(byteLength("héllo"), 6);
	assert.equal(byteLength(undefined), 0);
});

test("only the first party anthropic provider passes", () => {
	assert.equal(isAnthropicProvider("anthropic"), true);
});

test("claude served through a gateway or reseller is excluded", () => {
	assert.equal(isAnthropicProvider("openrouter"), false);
	assert.equal(isAnthropicProvider("amazon-bedrock"), false);
	assert.equal(isAnthropicProvider("github-copilot"), false);
	assert.equal(isAnthropicProvider("vercel-ai-gateway"), false);
	assert.equal(isAnthropicProvider("cloudflare-ai-gateway"), false);
});

test("other providers and missing providers are excluded", () => {
	assert.equal(isAnthropicProvider("openai-codex"), false);
	assert.equal(isAnthropicProvider("google"), false);
	assert.equal(isAnthropicProvider(undefined), false);
});
