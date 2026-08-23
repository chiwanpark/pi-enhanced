import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { HarmfulCommandAnalyzer, type CommandSafetyResult } from "../extensions/internal/harmful-command-analyzer.ts";

const sandbox = mkdtempSync(path.join(os.homedir(), ".pi-enhanced-command-guard-"));
const workingDirectory = path.join(sandbox, "project");
const outsideDirectory = path.join(sandbox, "outside");
mkdirSync(path.join(workingDirectory, ".git"), { recursive: true });
mkdirSync(path.join(workingDirectory, "nested"), { recursive: true });
mkdirSync(path.join(outsideDirectory, "directory"), { recursive: true });
writeFileSync(path.join(workingDirectory, "source.txt"), "source");
writeFileSync(path.join(outsideDirectory, ".env"), "SECRET=value");
symlinkSync(path.join(outsideDirectory, "directory"), path.join(workingDirectory, "escape"));
symlinkSync(path.join(outsideDirectory, "not-created-yet"), path.join(workingDirectory, "dangling-escape"));
symlinkSync("/tmp/pi-enhanced-env-target", path.join(workingDirectory, ".env"));

const analyzer = new HarmfulCommandAnalyzer(workingDirectory);
const inside = (relativePath: string) => path.join(workingDirectory, relativePath);
const outside = (relativePath: string) => path.join(outsideDirectory, relativePath);

function assertBlocked(command: string, reason?: RegExp): void {
	const result = analyzer.analyze(command);
	assert.equal(result.blocked, true, `expected command to be blocked: ${command}`);
	if (reason) assert.match(result.reason ?? "", reason);
}

function assertAllowed(command: string): void {
	const result = analyzer.analyze(command);
	assert.equal(result.blocked, false, `expected command to be allowed: ${command}\n${result.reason ?? ""}`);
}

function assertBlockedPath(result: CommandSafetyResult): void {
	assert.equal(result.blocked, true, "expected path to be blocked");
}

after(() => rmSync(sandbox, { recursive: true, force: true }));

test("blocks every guarded command when it modifies a path outside the working directory", () => {
	assertBlocked(`rm -rf ${outside("directory")}`);
	assertBlocked(`mv ${inside("source.txt")} ${outside("moved.txt")}`);
	assertBlocked(`cp ${inside("source.txt")} ${outside("copied.txt")}`);
	assertBlocked(`chmod 600 ${outside("file.txt")}`);
	assertBlocked(`tee -a ${outside("output.txt")}`);
	assertBlocked(`chown user:group ${outside("file.txt")}`);
	assertBlocked(`touch ${outside("new.txt")}`);
});

test("allows guarded commands whose modified paths stay in the working directory", () => {
	assertAllowed("rm -rf ./nested/cache");
	assertAllowed("mv ./source.txt ./nested/moved.txt");
	assertAllowed("cp ./source.txt ./nested/copied.txt");
	assertAllowed("chmod 600 ./source.txt");
	assertAllowed("tee -a ./nested/output.txt");
	assertAllowed("chown user:group ./source.txt");
	assertAllowed("touch ./nested/new.txt");
});

test("covers Leash destructive commands", () => {
	assertBlocked(`rmdir ${outside("directory")}`);
	assertBlocked(`unlink ${outside("file")}`);
	assertBlocked(`shred ${outside("file")}`);
	assertBlocked(`chgrp users ${outside("file")}`);
	assertBlocked(`truncate -s 0 ${outside("file")}`);
	assertBlocked(`dd if=/dev/zero of=${outside("disk.img")}`);
	assertBlocked(`ln -s ./source.txt ${outside("link")}`);
});

test("allows Leash temporary, device, and platform paths", () => {
	assertAllowed("rm -rf /tmp/pi-enhanced-cache");
	assertAllowed("touch /var/tmp/pi-enhanced-cache");
	assertAllowed("tee /dev/null");
	assertAllowed("truncate -s 0 /dev/null");
	assertAllowed("rm ~/.pi/agent/cache.txt");
	assertAllowed("touch ~/.claude/plans/plan.md");
	assertAllowed("cp ./source.txt ~/.config/opencode/source.txt");
});

test("allows non-deleting operations on device paths", () => {
	assertAllowed("touch /dev/null");
	assertAllowed("chmod 666 /dev/null");
	assertAllowed("chown root /dev/null");
	assertAllowed("ln -sf /dev/null ./nested/nul");
	assertAllowed("cp ./source.txt /dev/null");
	assertAllowed("mv ./source.txt /dev/null");
	assertAllowed("dd if=/dev/zero of=/dev/null");
	assertAllowed("cat ./source.txt > /dev/stdout");
});

test("still blocks deleting device paths", () => {
	assertBlocked("rm /dev/null");
	assertBlocked("rm -f /dev/stdout");
	assertBlocked("unlink /dev/null");
	assertBlocked("shred /dev/null");
	assertBlocked("rmdir /dev/null");
	assertBlocked("mv /dev/null ./nested/moved");
	assertBlocked("find /dev/null -delete", /find -delete/);
	assertBlocked("echo /dev/null | xargs rm", /xargs/);
});

test("cp may read outside, but mv may not modify an outside source", () => {
	assertAllowed(`cp ${outside("file.txt")} ./nested/copied.txt`);
	assertBlocked(`mv ${outside("file.txt")} ./nested/moved.txt`);
});

test("handles cp and mv target-directory options", () => {
	assertBlocked(`cp -v -t ${outsideDirectory} ./source.txt`);
	assertBlocked(`mv -vt${outsideDirectory} ./source.txt`);
	assertAllowed("cp -t ./nested ./source.txt");
});

test("protects root .env files and .git while allowing .env.example", () => {
	assertBlocked("rm .env", /protected path \.env files/);
	assertAllowed("rm .env.example");
	assertBlocked("tee .env.production", /protected path \.env files/);
	assertBlocked("cp source.txt .env.local", /protected path \.env files/);
	assertBlocked("chmod 600 .git/config", /protected path \.git directory/);
	assertBlocked("touch .git/HEAD", /protected path \.git directory/);
	assertBlocked("rm -rf .*", /protected path/);
	assertAllowed("rm -rf *");
	assertAllowed("touch .gitignore");
	assertAllowed("touch nested/.env.local");
});

test("protects a sensitive filename derived when cp targets a directory", () => {
	assertBlocked(`cp ${outside(".env")} .`, /protected path \.env files/);
});

test("blocks destructive git operations in any path", () => {
	assertBlocked("git checkout -- source.txt", /git checkout --/);
	assertBlocked("git restore source.txt", /git restore/);
	assertBlocked("git reset --hard HEAD~1", /git reset --hard/);
	assertBlocked("git reset --merge", /git reset --merge/);
	assertBlocked("git -C /tmp push origin main --force", /git push --force/);
	assertBlocked("git push --force-with-lease origin main", /git push --force/);
	assertBlocked("sudo git clean -fd", /git clean -f/);
	assertBlocked("git push -uf origin main", /git push --force/);
	assertBlocked("git branch -D old-branch", /git branch -D/);
	assertBlocked("git stash drop", /git stash drop/);
	assertBlocked("git stash clear", /git stash clear/);
});

test("allows non-destructive git variants", () => {
	assertAllowed("git reset --soft HEAD~1");
	assertAllowed("git clean -n");
	assertAllowed("git push origin main");
	assertAllowed("git restore --staged .");
});

test("checks every command in &&, ||, semicolon, pipe, and newline chains", () => {
	assertBlocked(`echo ok && rm ${outside("a")}`);
	assertBlocked(`false || touch ${outside("b")}`);
	assertBlocked(`echo ok; chmod 600 ${outside("c")}`);
	assertBlocked(`printf data | tee ${outside("d")}`);
	assertBlocked(`echo ok\ngit clean -f`);
	assertAllowed(`echo "rm ${outside("quoted")}" && touch ./nested/safe`);
});

test("blocks unsafe output redirects", () => {
	assertBlocked(`echo data > ${outside("output.txt")}`, /redirect/);
	assertBlocked("echo secret >> .env", /protected path/);
	assertAllowed("echo example > .env.example");
	assertAllowed("echo cache > /tmp/pi-enhanced-output");
	assertAllowed("echo ignored 2>/dev/null");
});

test("blocks destructive find, xargs, and rsync patterns", () => {
	assertBlocked(`find ${outsideDirectory} -name '*.tmp' -delete`, /find -delete/);
	assertBlocked(`find ${outsideDirectory} -exec rm {} \\;`, /find -exec/);
	assertBlocked(`find ${outsideDirectory} -print | xargs rm`, /xargs/);
	assertBlocked(`rsync -a --delete ./source.txt ${outside("backup")}`, /rsync --delete/);
	assertBlocked("find . -name .env -delete", /protected path/);
	assertAllowed("find ./nested -name '*.tmp' -delete");
});

test("validates write and edit paths with the same policy", () => {
	assertBlockedPath(analyzer.validatePath(outside("written.txt")));
	assertBlockedPath(analyzer.validatePath(".env"));
	assertBlockedPath(analyzer.validatePath(".git/config"));
	assertBlockedPath(analyzer.validatePath("./escape/new-file"));
	assert.equal(analyzer.validatePath(".env.example").blocked, false);
	assert.equal(analyzer.validatePath("./nested/file.txt").blocked, false);
	assert.equal(analyzer.validatePath("/tmp/pi-enhanced-file").blocked, false);
	assert.equal(analyzer.validatePath("~/.pi/agent/file.txt").blocked, false);
});

test("recognizes common command wrappers and absolute executable paths", () => {
	assertBlocked(`sudo -u root /bin/rm ${outside("wrapped")}`);
	assertBlocked(`env MODE=test command rm ${outside("env-wrapped")}`);
	assertBlocked(`exec touch ${outside("exec-wrapped")}`);
	assertBlocked(`time -f %E rm ${outside("time-wrapped")}`);
});

test("tracks cd across command chains", () => {
	assertBlocked(`cd ${outsideDirectory} && rm relative-file`);
	assertAllowed("cd ./nested && rm relative-file");
	assertAllowed(`cd ${outsideDirectory} | true; rm ./nested/cache`);
});

test("resolves symlinks, including missing descendants and parent traversal", () => {
	assertBlocked("touch ./escape/new-file", /outside the working directory/);
	assertBlocked("tee ./escape/missing/output.txt", /outside the working directory/);
	assertBlocked("touch ./escape/../escaped-parent.txt", /outside the working directory/);
	assertBlocked("touch ./dangling-escape", /outside the working directory/);
});

test("does not analyze heredoc bodies, quoted markers, or comments as shell commands", () => {
	assertAllowed(`cat <<'EOF'\nrm ${outside("example")}; git clean -f\nEOF`);
	assertAllowed(`echo '<<EOF'\nrm ./nested/safe`);
	assertAllowed(`echo 'first line\n<<EOF'\nrm ./nested/safe`);
	assertAllowed(`echo ok # ; rm ${outside("commented")}`);
	assertBlocked(`echo '<<EOF'\nrm ${outside("real-command")}`);
	assertBlocked(`cat <<'EOF'\nexample\nEOF\ntouch ${outside("after-heredoc")}`);
});

test("blocks dynamically computed targets that cannot be resolved safely", () => {
	assertBlocked('rm "$(printf /etc/passwd)"', /cannot be safely resolved/);
	assertBlocked("rm $'/etc/passwd'", /cannot be safely resolved/);
	assertBlocked('rm "$PI_ENHANCED_UNKNOWN_PATH"', /cannot be safely resolved/);
});

test("handles shell line continuations without turning absolute paths into relative paths", () => {
	assertBlocked("rm \\\n" + outside("continued"));
});
