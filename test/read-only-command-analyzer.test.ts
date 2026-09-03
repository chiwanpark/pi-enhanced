import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReadOnlyShellCommand } from "../extensions/internal/harmful-command-analyzer.ts";

const cwd = "/workspace/project";

function assertAllowed(command: string): void {
	const result = analyzeReadOnlyShellCommand(command, cwd);
	assert.equal(result.blocked, false, `expected command to be allowed: ${command}\n${result.reason ?? ""}`);
}

function assertBlocked(command: string, reason?: RegExp): void {
	const result = analyzeReadOnlyShellCommand(command, cwd);
	assert.equal(result.blocked, true, `expected command to be blocked: ${command}`);
	if (reason) assert.match(result.reason ?? "", reason);
}

test("allows common read-only inspection commands", () => {
	assertAllowed("pwd");
	assertAllowed("ls -la src");
	assertAllowed("cat package.json | head -40");
	assertAllowed("rg 'registerTool' extensions --glob '*.ts'");
	assertAllowed("find extensions -name '*.ts' -maxdepth 2");
	assertAllowed("sed -n '1,120p' extensions/index.ts");
	assertAllowed("git status --short && git diff -- extensions/index.ts");
	assertAllowed("cd extensions && env LC_ALL=C command rg plan .");
});

test("allows harmless output descriptor redirection", () => {
	assertAllowed("rg pattern src 2>/dev/null");
	assertAllowed("printf '%s\\n' result >&2");
});

test("blocks file writes and mutating commands", () => {
	assertBlocked("echo changed > file.txt", /Output redirection/);
	assertBlocked("cat input | tee output", /tee/);
	assertBlocked("sed -i 's/a/b/' file.txt", /sed -i/);
	assertBlocked("rm file.txt", /rm/);
	assertBlocked("mkdir generated", /mkdir/);
	assertBlocked("cp source target", /cp/);
	assertBlocked("git add file.txt", /git add/);
	assertBlocked("git commit -m test", /git commit/);
	assertBlocked("sort input -o output", /output-file/);
	assertBlocked("tree -o tree.txt", /output-file/);
	assertBlocked("time -o timing.txt cat package.json", /time/);
	assertBlocked("nohup cat package.json", /nohup/);
	assertBlocked("sudo cat package.json", /sudo/);
});

test("blocks executable search actions and dynamic shell execution", () => {
	assertBlocked("find . -delete", /find/);
	assertBlocked("find . -exec cat {} \\;", /find/);
	assertBlocked("fd -x touch {}", /fd/);
	assertBlocked("fd -Xtouch {}", /fd/);
	assertBlocked("rg --pre process pattern .", /rg --pre/);
	assertBlocked('cat "$(touch changed)"', /dynamic shell execution/);
	assertBlocked("cat <(touch changed)", /dynamic shell execution/);
	assertBlocked("echo safe & touch changed", /touch/);
});

test("blocks unknown commands conservatively", () => {
	assertBlocked("node script.js", /node/);
	assertBlocked("python -c 'print(1)'", /python/);
	assertBlocked("npm test", /npm/);
});
