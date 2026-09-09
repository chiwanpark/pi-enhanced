import assert from "node:assert/strict";
import test from "node:test";
import { detectCommentSyntax, findComments } from "../extensions/internal/comment-analyzer.ts";

function scan(filePath: string, source: string, options = {}) {
	return findComments(filePath, source.split("\n"), options);
}

test("flags line comments in c-family files", () => {
	const findings = scan("src/app.ts", ["const value = 1; // trailing", "// leading", "const other = 2;"].join("\n"));

	assert.deepEqual(
		findings.map((finding) => finding.line),
		[1, 2],
	);
	assert.equal(findings[0]?.text, "// trailing");
});

test("flags block comments and their opening line only", () => {
	const findings = scan("src/app.ts", ["/*", " * doc", " */", "export const a = 1;"].join("\n"));

	assert.equal(findings.length, 1);
	assert.equal(findings[0]?.line, 1);
});

test("ignores comment markers inside strings", () => {
	const findings = scan(
		"src/app.ts",
		[
			'const url = "https://example.com";',
			"const template = `a // b`;",
			"const pattern = /https:\\/\\//;",
			"const hash = '#not-a-comment';",
		].join("\n"),
	);

	assert.deepEqual(findings, []);
});

test("allows tooling directives but not prose", () => {
	const findings = scan(
		"src/app.ts",
		[
			"// eslint-disable-next-line @typescript-eslint/no-explicit-any",
			"// @ts-expect-error legacy",
			"// compute the total",
		].join("\n"),
	);

	assert.deepEqual(
		findings.map((finding) => finding.line),
		[3],
	);
});

test("honors allowDirectives false and custom allow patterns", () => {
	const strict = scan("src/app.ts", "// eslint-disable-next-line no-console", { allowDirectives: false });
	assert.equal(strict.length, 1);

	const custom = scan("src/app.ts", "// TRACE: keep", { allowPatterns: [/TRACE:/] });
	assert.deepEqual(custom, []);
});

test("treats hash comments as comments only at a token boundary", () => {
	const shell = scan("scripts/run.sh", ["#!/usr/bin/env bash", 'echo "${count#prefix}" $#', "# explain"].join("\n"));

	assert.deepEqual(
		shell.map((finding) => finding.line),
		[3],
	);
});

test("flags yaml and python comments", () => {
	assert.equal(scan("config/app.yaml", "key: value # note").length, 1);
	assert.equal(scan("config/app.yaml", "key: value").length, 0);
	assert.equal(scan("app.py", "value = 1  # note").length, 1);
	assert.equal(scan("app.py", 'value = "# not a comment"').length, 0);
});

test("flags python docstrings after a definition and at file start", () => {
	const docstring = scan("app.py", ["def run():", '    """Run the app."""', "    return 1"].join("\n"));
	assert.deepEqual(
		docstring.map((finding) => finding.line),
		[2],
	);

	const moduleDoc = scan("app.py", ['"""Module docs."""', "value = 1"].join("\n"), { wholeFile: true });
	assert.equal(moduleDoc.length, 1);

	const plainString = scan("app.py", ['value = """text"""'].join("\n"), { wholeFile: true });
	assert.deepEqual(plainString, []);
});

test("flags sql, lua, and markup comments", () => {
	assert.equal(scan("query.sql", "select 1 -- note").length, 1);
	assert.equal(scan("init.lua", "local a = 1 -- note").length, 1);
	assert.equal(scan("page.html", "<div></div> <!-- note -->").length, 1);
	assert.equal(scan("README.md", "<!-- note -->").length, 1);
	assert.equal(scan("README.md", "# Heading").length, 0);
});

test("skips lines that already exist in the file", () => {
	const findings = scan("src/app.ts", ["// existing", "// added"].join("\n"), {
		knownLines: new Set(["// existing"]),
	});

	assert.deepEqual(
		findings.map((finding) => finding.text),
		["// added"],
	);
});

test("detects syntax only for known file types", () => {
	assert.ok(detectCommentSyntax("src/app.ts"));
	assert.ok(detectCommentSyntax("Dockerfile"));
	assert.ok(detectCommentSyntax("project/Makefile"));
	assert.equal(detectCommentSyntax("data/values.json"), null);
	assert.equal(detectCommentSyntax("notes.txt"), null);
	assert.deepEqual(scan("data/values.json", '{ "a": 1 }'), []);
});
