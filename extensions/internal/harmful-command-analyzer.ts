import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type CommandSafetyResult = {
	blocked: boolean;
	reason?: string;
};

type Separator = "&&" | "||" | ";" | "|" | "newline";

type CommandSegment = {
	command: string;
	separatorBefore?: Separator;
	separatorAfter?: Separator;
};

type ShellToken = {
	value: string;
	dynamic: boolean;
	hasGlob: boolean;
};

type ParsedCommand = {
	name: string;
	args: ShellToken[];
};

type CopyMoveArguments = {
	operands: ShellToken[];
	targetDirectory?: ShellToken;
	noTargetDirectory: boolean;
};

/**
 * `delete` removes the target itself, so device paths stay blocked; `modify` and `write` only change
 * content or metadata, which is a harmless no-op on device paths such as /dev/null.
 */
type PathPolicy = "delete" | "modify" | "write";

const GUARDED_COMMANDS = new Set([
	"rm",
	"rmdir",
	"unlink",
	"shred",
	"mv",
	"cp",
	"chmod",
	"tee",
	"chown",
	"touch",
	"chgrp",
	"truncate",
	"dd",
	"ln",
]);
const DELETING_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred"]);
const TEMP_PATHS = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"];
const DEVICE_PATHS = ["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"];
const PLATFORM_PATHS = [".claude", ".factory", ".pi", ".config/opencode"];
const XARGS_COMMANDS = new Set(["rm", "mv", "cp"]);
const WRAPPER_OPTIONS_WITH_VALUES = new Map<string, Set<string>>([
	[
		"sudo",
		new Set([
			"-C",
			"-D",
			"-g",
			"-h",
			"-p",
			"-R",
			"-r",
			"-T",
			"-t",
			"-u",
			"--chdir",
			"--close-from",
			"--group",
			"--host",
			"--other-user",
			"--prompt",
			"--role",
			"--type",
			"--user",
		]),
	],
	["env", new Set(["-C", "-S", "-u", "--chdir", "--split-string", "--unset"])],
	["command", new Set()],
	["exec", new Set(["-a"])],
	["nice", new Set(["-n", "--adjustment"])],
	["nohup", new Set()],
	["time", new Set(["-f", "-o", "--format", "--output"])],
]);

const CONTROL_WORDS = new Set(["!", "(", "{", "do", "else", "if", "then", "until", "while"]);

function allowed(): CommandSafetyResult {
	return { blocked: false };
}

function blocked(reason: string): CommandSafetyResult {
	return { blocked: true, reason };
}

function findHeredocs(
	line: string,
	quoteState: { singleQuoted: boolean; doubleQuoted: boolean },
): Array<{ value: string; stripTabs: boolean }> {
	const delimiters: Array<{ value: string; stripTabs: boolean }> = [];

	for (let index = 0; index < line.length; index++) {
		const char = line[index] ?? "";
		const next = line[index + 1] ?? "";
		if (char === "\\" && !quoteState.singleQuoted) {
			index++;
			continue;
		}
		if (char === "'" && !quoteState.doubleQuoted) {
			quoteState.singleQuoted = !quoteState.singleQuoted;
			continue;
		}
		if (char === '"' && !quoteState.singleQuoted) {
			quoteState.doubleQuoted = !quoteState.doubleQuoted;
			continue;
		}
		if (quoteState.singleQuoted || quoteState.doubleQuoted || char !== "<" || next !== "<" || line[index + 2] === "<") {
			continue;
		}

		let cursor = index + 2;
		const stripTabs = line[cursor] === "-";
		if (stripTabs) cursor++;
		while (/\s/.test(line[cursor] ?? "")) cursor++;
		const quote = line[cursor] === "'" || line[cursor] === '"' ? line[cursor] : "";
		if (quote) cursor++;
		const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(cursor));
		const value = match?.[0];
		if (!value) continue;
		if (quote && line[cursor + value.length] !== quote) continue;
		delimiters.push({ value, stripTabs });
		index = cursor + value.length;
	}
	return delimiters;
}

/** Remove heredoc bodies so shell syntax in embedded text is not treated as a command. */
function stripHeredocBodies(command: string): string {
	const delimiters: Array<{ value: string; stripTabs: boolean }> = [];
	const quoteState = { singleQuoted: false, doubleQuoted: false };
	return command
		.split("\n")
		.map((line) => {
			const current = delimiters[0];
			if (current) {
				const candidate = current.stripTabs ? line.replace(/^\t+/, "") : line;
				if (candidate.trimEnd() === current.value) delimiters.shift();
				return "";
			}
			delimiters.push(...findHeredocs(line, quoteState));
			return line;
		})
		.join("\n");
}

function splitCommandChain(command: string): CommandSegment[] {
	const source = stripHeredocBodies(command);
	const segments: CommandSegment[] = [];
	let current = "";
	let separatorBefore: Separator | undefined;
	let singleQuoted = false;
	let doubleQuoted = false;

	const push = (separatorAfter: Separator) => {
		const trimmed = current.trim();
		if (trimmed) {
			const segment: CommandSegment = { command: trimmed, separatorAfter };
			if (separatorBefore) segment.separatorBefore = separatorBefore;
			segments.push(segment);
		}
		current = "";
		separatorBefore = separatorAfter;
	};

	for (let index = 0; index < source.length; index++) {
		const char = source[index] ?? "";
		const next = source[index + 1] ?? "";

		if (char === "\\" && !singleQuoted) {
			current += char;
			if (next) {
				current += next;
				index++;
			}
			continue;
		}
		if (char === "'" && !doubleQuoted) {
			singleQuoted = !singleQuoted;
			current += char;
			continue;
		}
		if (char === '"' && !singleQuoted) {
			doubleQuoted = !doubleQuoted;
			current += char;
			continue;
		}
		if (singleQuoted || doubleQuoted) {
			current += char;
			continue;
		}
		if (char === "#" && (current === "" || /\s$/.test(current))) {
			const newline = source.indexOf("\n", index + 1);
			if (newline < 0) break;
			push("newline");
			index = newline;
			continue;
		}

		if (char === "&" && next === "&") {
			push("&&");
			index++;
		} else if (char === "|" && next === "|") {
			push("||");
			index++;
		} else if (char === "|") {
			push("|");
			if (next === "&") index++;
		} else if (char === ";") {
			push(";");
		} else if (char === "\n") {
			push("newline");
		} else {
			current += char;
		}
	}

	const trimmed = current.trim();
	if (trimmed) {
		const segment: CommandSegment = { command: trimmed };
		if (separatorBefore) segment.separatorBefore = separatorBefore;
		segments.push(segment);
	}
	return segments;
}

function expandVariable(source: string, index: number, cwd: string): { value: string; end: number; dynamic: boolean } {
	const next = source[index + 1] ?? "";
	if (next === "(") return { value: "", end: index + 1, dynamic: true };
	if (next === "'" || next === '"') return { value: "", end: index, dynamic: true };
	if (next === "{") {
		const end = source.indexOf("}", index + 2);
		if (end < 0) return { value: "", end: index, dynamic: true };
		const name = source.slice(index + 2, end);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { value: "", end, dynamic: true };
		if (name === "PWD") return { value: cwd, end, dynamic: false };
		const value = process.env[name];
		return value == null ? { value: "", end, dynamic: true } : { value, end, dynamic: false };
	}
	const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index + 1));
	if (!match) return { value: "$", end: index, dynamic: /[0-9@*#?$!-]/.test(next) };
	const name = match[0];
	const end = index + name.length;
	if (name === "PWD") return { value: cwd, end, dynamic: false };
	const value = process.env[name];
	return value == null ? { value: "", end, dynamic: true } : { value, end, dynamic: false };
}

function shellTokens(command: string, cwd: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let value = "";
	let tokenStarted = false;
	let dynamic = false;
	let hasGlob = false;
	let singleQuoted = false;
	let doubleQuoted = false;

	const push = () => {
		if (tokenStarted) tokens.push({ value, dynamic, hasGlob });
		value = "";
		tokenStarted = false;
		dynamic = false;
		hasGlob = false;
	};

	for (let index = 0; index < command.length; index++) {
		const char = command[index] ?? "";
		const next = command[index + 1] ?? "";

		if (char === "\\" && !singleQuoted) {
			if (next === "\n") {
				index++;
				continue;
			}
			tokenStarted = true;
			if (next) {
				value += next;
				index++;
			}
			continue;
		}
		if (char === "'" && !doubleQuoted) {
			singleQuoted = !singleQuoted;
			tokenStarted = true;
			continue;
		}
		if (char === '"' && !singleQuoted) {
			doubleQuoted = !doubleQuoted;
			tokenStarted = true;
			continue;
		}
		if (!singleQuoted && char === "`") {
			dynamic = true;
			tokenStarted = true;
			continue;
		}
		if (!singleQuoted && char === "$") {
			const expanded = expandVariable(command, index, cwd);
			value += expanded.value;
			dynamic ||= expanded.dynamic;
			tokenStarted = true;
			index = expanded.end;
			continue;
		}
		if (!singleQuoted && !doubleQuoted && /[*?[]/.test(char)) hasGlob = true;
		if (!singleQuoted && !doubleQuoted && /\s/.test(char)) {
			push();
			continue;
		}
		value += char;
		tokenStarted = true;
	}
	push();
	return tokens;
}

function optionConsumesNext(option: string, optionsWithValues: ReadonlySet<string>): boolean {
	return optionsWithValues.has(option) && !option.includes("=");
}

function unwrapCommand(tokens: ShellToken[]): ParsedCommand | null {
	let index = 0;
	while (index < tokens.length) {
		const value = tokens[index]?.value ?? "";
		if (CONTROL_WORDS.has(value) || value === "") {
			index++;
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
			index++;
			continue;
		}
		break;
	}

	while (index < tokens.length) {
		const rawName = tokens[index]?.value.replace(/^[({]+/, "") ?? "";
		const name = path.basename(rawName);
		const optionsWithValues = WRAPPER_OPTIONS_WITH_VALUES.get(name);
		if (!optionsWithValues) {
			return name ? { name, args: tokens.slice(index + 1) } : null;
		}

		index++;
		while (index < tokens.length) {
			const option = tokens[index]?.value ?? "";
			if (option === "--") {
				index++;
				break;
			}
			if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
				index++;
				continue;
			}
			if (!option.startsWith("-") || option === "-") break;
			index += optionConsumesNext(option, optionsWithValues) ? 2 : 1;
		}
	}
	return null;
}

function parseCopyMoveArguments(args: ShellToken[]): CopyMoveArguments {
	const operands: ShellToken[] = [];
	let targetDirectory: ShellToken | undefined;
	let noTargetDirectory = false;
	let parseOptions = true;

	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		if (!token) continue;
		const value = token.value;
		if (parseOptions && value === "--") {
			parseOptions = false;
			continue;
		}
		if (parseOptions && (value === "-T" || value === "--no-target-directory")) {
			noTargetDirectory = true;
			continue;
		}
		if (parseOptions && (value === "-t" || value === "--target-directory")) {
			targetDirectory = args[index + 1];
			index++;
			continue;
		}
		if (parseOptions && value.startsWith("--target-directory=")) {
			targetDirectory = { ...token, value: value.slice("--target-directory=".length) };
			continue;
		}
		if (parseOptions && /^-[^-]*t/.test(value)) {
			const position = value.indexOf("t", 1);
			const attached = value.slice(position + 1);
			if (attached) targetDirectory = { ...token, value: attached };
			else {
				targetDirectory = args[index + 1];
				index++;
			}
			continue;
		}
		if (parseOptions && (value === "-S" || value === "--suffix")) {
			index++;
			continue;
		}
		if (parseOptions && value.startsWith("-")) continue;
		operands.push(token);
	}

	const result: CopyMoveArguments = { operands, noTargetDirectory };
	if (targetDirectory) result.targetDirectory = targetDirectory;
	return result;
}

function collectSimpleOperands(args: ShellToken[]): ShellToken[] {
	const operands: ShellToken[] = [];
	let parseOptions = true;
	for (const token of args) {
		if (parseOptions && token.value === "--") {
			parseOptions = false;
			continue;
		}
		if (parseOptions && token.value.startsWith("-") && token.value !== "-") continue;
		operands.push(token);
	}
	return operands;
}

function collectModeOwnerTargets(args: ShellToken[]): ShellToken[] {
	const targets: ShellToken[] = [];
	let metadataSeen = false;
	let parseOptions = true;
	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		if (!token) continue;
		if (parseOptions && token.value === "--") {
			parseOptions = false;
			continue;
		}
		if (parseOptions && (token.value === "--reference" || token.value === "--from")) {
			index++;
			continue;
		}
		if (parseOptions && (token.value.startsWith("--reference=") || token.value.startsWith("--from="))) {
			continue;
		}
		if (parseOptions && token.value.startsWith("-") && token.value !== "-") continue;
		if (!metadataSeen) metadataSeen = true;
		else targets.push(token);
	}
	return targets;
}

function collectTouchTargets(args: ShellToken[]): ShellToken[] {
	const targets: ShellToken[] = [];
	let parseOptions = true;
	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		if (!token) continue;
		const value = token.value;
		if (parseOptions && value === "--") {
			parseOptions = false;
			continue;
		}
		if (parseOptions && new Set(["-d", "-r", "-t", "--date", "--reference", "--time"]).has(value)) {
			index++;
			continue;
		}
		if (
			parseOptions &&
			(value.startsWith("--date=") || value.startsWith("--reference=") || value.startsWith("--time="))
		) {
			continue;
		}
		if (parseOptions && /^-[drt].+/.test(value)) continue;
		if (parseOptions && value.startsWith("-") && value !== "-") continue;
		targets.push(token);
	}
	return targets;
}

function collectTruncateTargets(args: ShellToken[]): ShellToken[] {
	const targets: ShellToken[] = [];
	let parseOptions = true;
	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		if (!token) continue;
		const value = token.value;
		if (parseOptions && value === "--") {
			parseOptions = false;
			continue;
		}
		if (parseOptions && new Set(["-r", "-s", "--reference", "--size"]).has(value)) {
			index++;
			continue;
		}
		if (parseOptions && (value.startsWith("--reference=") || value.startsWith("--size="))) continue;
		if (parseOptions && /^-[rs].+/.test(value)) continue;
		if (parseOptions && value.startsWith("-") && value !== "-") continue;
		targets.push(token);
	}
	return targets;
}

function ddOutputTarget(args: ShellToken[]): ShellToken | null {
	for (const token of args) {
		if (token.value.startsWith("of=")) return { ...token, value: token.value.slice(3) };
	}
	return null;
}

function compoundPathCandidates(tokens: ShellToken[]): ShellToken[] {
	return tokens.filter((token) => {
		if (!token.value || token.value.startsWith("-")) return false;
		if (["+", ";", "{}"].includes(token.value)) return false;
		return !XARGS_COMMANDS.has(path.basename(token.value));
	});
}

function gitSubcommand(args: ShellToken[]): { name: string; args: ShellToken[] } | null {
	const optionsWithValues = new Set(["-C", "-c", "--exec-path", "--git-dir", "--namespace", "--work-tree"]);
	for (let index = 0; index < args.length; index++) {
		const value = args[index]?.value ?? "";
		if (value === "--") {
			const name = args[index + 1]?.value;
			return name ? { name, args: args.slice(index + 2) } : null;
		}
		if (optionConsumesNext(value, optionsWithValues)) {
			index++;
			continue;
		}
		if (value.startsWith("-")) continue;
		return { name: value, args: args.slice(index + 1) };
	}
	return null;
}

function checkDangerousGitCommand(command: ParsedCommand): CommandSafetyResult {
	if (command.name !== "git") return allowed();
	const subcommand = gitSubcommand(command.args);
	if (!subcommand) return allowed();
	const options = subcommand.args.map((token) => token.value);
	const hasShortOption = (name: string) =>
		options.some((option) => /^-[^-]+$/.test(option) && option.slice(1).includes(name));

	if (subcommand.name === "checkout" && options.includes("--")) {
		return blocked('Dangerous git command blocked: "git checkout --".');
	}
	if (subcommand.name === "restore" && (!options.includes("--staged") || options.includes("--worktree"))) {
		return blocked('Dangerous git command blocked: "git restore".');
	}
	if (subcommand.name === "reset" && options.some((option) => option === "--hard" || option.startsWith("--hard="))) {
		return blocked('Dangerous git command blocked: "git reset --hard".');
	}
	if (subcommand.name === "reset" && options.includes("--merge")) {
		return blocked('Dangerous git command blocked: "git reset --merge".');
	}
	if (subcommand.name === "push" && (options.some((option) => option.startsWith("--force")) || hasShortOption("f"))) {
		return blocked('Dangerous git command blocked: "git push --force".');
	}
	if (subcommand.name === "clean" && (options.includes("--force") || hasShortOption("f"))) {
		return blocked('Dangerous git command blocked: "git clean -f".');
	}
	if (subcommand.name === "branch" && options.includes("-D")) {
		return blocked('Dangerous git command blocked: "git branch -D".');
	}
	if (subcommand.name === "stash" && (options[0] === "drop" || options[0] === "clear")) {
		return blocked(`Dangerous git command blocked: "git stash ${options[0]}".`);
	}
	return allowed();
}

export class HarmfulCommandAnalyzer {
	private readonly workingDirectory: string;

	constructor(workingDirectory: string) {
		this.workingDirectory = this.resolveSymlinks(workingDirectory, process.cwd());
	}

	private expandHome(input: string): string {
		return input.replace(/^~(?=$|[\\/])/, os.homedir());
	}

	/** Resolve every existing symlink component before handling following `..` or missing path components. */
	private resolveSymlinks(input: string, base: string): string {
		const expanded = this.expandHome(input);
		let current: string;
		let pending: string[];

		if (path.isAbsolute(expanded)) {
			const root = path.parse(expanded).root;
			current = root;
			pending = expanded.slice(root.length).split(/[\\/]+/);
		} else {
			try {
				current = realpathSync(base);
			} catch {
				current = path.resolve(base);
			}
			pending = expanded.split(/[\\/]+/);
		}

		let followedLinks = 0;
		while (pending.length > 0) {
			const component = pending.shift();
			if (!component || component === ".") continue;
			if (component === "..") {
				current = path.dirname(current);
				continue;
			}

			const candidate = path.join(current, component);
			try {
				if (!lstatSync(candidate).isSymbolicLink()) {
					current = candidate;
					continue;
				}
				if (++followedLinks > 40) return candidate;
				const target = readlinkSync(candidate);
				if (path.isAbsolute(target)) {
					const root = path.parse(target).root;
					current = root;
					pending.unshift(...target.slice(root.length).split(/[\\/]+/));
				} else {
					pending.unshift(...target.split(/[\\/]+/));
				}
			} catch {
				current = candidate;
			}
		}
		return path.resolve(current);
	}

	private isInsideWorkingDirectory(resolved: string): boolean {
		const relative = path.relative(this.workingDirectory, resolved);
		return (
			relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
		);
	}

	private matchesRoot(resolved: string, root: string): boolean {
		return resolved === root || resolved.startsWith(`${root}${path.sep}`);
	}

	private isAllowedOutsidePath(resolved: string, policy: PathPolicy): boolean {
		const tempPaths = TEMP_PATHS.map((candidate) => this.resolveSymlinks(candidate, this.workingDirectory));
		if (tempPaths.some((candidate) => this.matchesRoot(resolved, candidate))) return true;

		const home = os.homedir();
		const platformPaths = PLATFORM_PATHS.map((candidate) => this.resolveSymlinks(path.join(home, candidate), home));
		if (platformPaths.some((candidate) => this.matchesRoot(resolved, candidate))) return true;

		if (policy === "delete") return false;

		const devicePaths = DEVICE_PATHS.map((candidate) => this.resolveSymlinks(candidate, this.workingDirectory));
		return devicePaths.some((candidate) => this.matchesRoot(resolved, candidate));
	}

	private protectedName(relativePath: string, token: ShellToken): string | null {
		if (/^\.env($|\.(?!example$).+)/.test(relativePath)) return ".env files";
		if (/^\.git($|[\\/])/.test(relativePath)) return ".git directory";

		const rootComponent = relativePath.split(path.sep)[0] ?? "";
		if (token.hasGlob && rootComponent.startsWith(".")) {
			const wildcard = rootComponent.search(/[*?[]/);
			if (wildcard >= 0) {
				const prefix = rootComponent.slice(0, wildcard);
				if (prefix.startsWith(".env") || ".env".startsWith(prefix)) return ".env files";
				if (prefix.startsWith(".git") || ".git".startsWith(prefix)) return ".git directory";
			}
		}
		return null;
	}

	private checkTarget(
		command: string,
		token: ShellToken,
		cwd: string,
		policy: PathPolicy = "modify",
	): CommandSafetyResult {
		if (token.dynamic) return blocked(`Command "${command}" has a target path that cannot be safely resolved.`);
		if (token.value === "" || token.value === "-") return allowed();

		const lexical = path.resolve(cwd, this.expandHome(token.value));
		if (this.isInsideWorkingDirectory(lexical)) {
			const protectedName = this.protectedName(path.relative(this.workingDirectory, lexical), token);
			if (protectedName) {
				return blocked(`Command "${command}" targets protected path ${protectedName}: ${token.value}`);
			}
		}

		const resolved = this.resolveSymlinks(token.value, cwd);
		if (!this.isInsideWorkingDirectory(resolved)) {
			if (this.isAllowedOutsidePath(resolved, policy)) return allowed();
			return blocked(`Command "${command}" targets a path outside the working directory: ${token.value}`);
		}

		const protectedName = this.protectedName(path.relative(this.workingDirectory, resolved), token);
		if (protectedName) {
			return blocked(`Command "${command}" targets protected path ${protectedName}: ${token.value}`);
		}
		return allowed();
	}

	private checkTargets(
		command: string,
		targets: ShellToken[],
		cwd: string,
		policy: PathPolicy = "modify",
	): CommandSafetyResult {
		for (const target of targets) {
			const result = this.checkTarget(command, target, cwd, policy);
			if (result.blocked) return result;
		}
		return allowed();
	}

	private checkRedirects(command: string, cwd: string): CommandSafetyResult {
		let singleQuoted = false;
		let doubleQuoted = false;
		for (let index = 0; index < command.length; index++) {
			const char = command[index] ?? "";
			const next = command[index + 1] ?? "";
			if (char === "\\" && !singleQuoted) {
				index++;
				continue;
			}
			if (char === "'" && !doubleQuoted) {
				singleQuoted = !singleQuoted;
				continue;
			}
			if (char === '"' && !singleQuoted) {
				doubleQuoted = !doubleQuoted;
				continue;
			}
			if (singleQuoted || doubleQuoted || char !== ">") continue;

			let cursor = index + (next === ">" ? 2 : 1);
			if (command[cursor] === "|") cursor++;
			while (/\s/.test(command[cursor] ?? "")) cursor++;
			if (command[cursor] === "&") {
				cursor++;
				while (/\s/.test(command[cursor] ?? "")) cursor++;
				if (/^[0-9-]$/.test(command[cursor] ?? "")) continue;
			}
			const target = shellTokens(command.slice(cursor), cwd)[0];
			if (!target) continue;
			const result = this.checkTarget("redirect", target, cwd, "write");
			if (result.blocked) return result;
		}
		return allowed();
	}

	private checkCompoundCommand(command: ParsedCommand, allArguments: ShellToken[], cwd: string): CommandSafetyResult {
		const values = command.args.map((token) => token.value);
		let name: string | null = null;
		let candidates = command.args;
		if (command.name === "find" && values.includes("-delete")) name = "find -delete";
		if (
			command.name === "find" &&
			values.includes("-exec") &&
			values.some((value) => XARGS_COMMANDS.has(path.basename(value)))
		) {
			name = "find -exec";
		}
		if (command.name === "xargs" && values.some((value) => XARGS_COMMANDS.has(path.basename(value)))) {
			name = "xargs";
			candidates = allArguments;
		}
		if (command.name === "rsync" && values.includes("--delete")) name = "rsync --delete";
		if (!name) return allowed();
		return this.checkTargets(name, compoundPathCandidates(candidates), cwd, "delete");
	}

	private destinationIsDirectory(token: ShellToken, cwd: string, sourceCount: number): boolean {
		if (sourceCount > 1 || /[\\/]$/.test(token.value)) return true;
		try {
			return statSync(this.resolveSymlinks(token.value, cwd)).isDirectory();
		} catch {
			return false;
		}
	}

	private checkCopyMove(command: "cp" | "mv", args: ShellToken[], cwd: string): CommandSafetyResult {
		const parsed = parseCopyMoveArguments(args);
		let sources: ShellToken[];
		let destination: ShellToken | undefined;

		if (parsed.targetDirectory) {
			sources = parsed.operands;
			destination = parsed.targetDirectory;
		} else {
			if (parsed.operands.length < 2) return allowed();
			sources = parsed.operands.slice(0, -1);
			destination = parsed.operands.at(-1);
		}
		if (!destination) return allowed();

		if (command === "mv") {
			// Moving a source removes it from its original location, so treat it as a deletion.
			const sourceResult = this.checkTargets(command, sources, cwd, "delete");
			if (sourceResult.blocked) return sourceResult;
		}
		const destinationResult = this.checkTarget(command, destination, cwd, "write");
		if (destinationResult.blocked) return destinationResult;

		if (!parsed.noTargetDirectory && this.destinationIsDirectory(destination, cwd, sources.length)) {
			for (const source of sources) {
				if (source.dynamic) return blocked(`Command "${command}" has a target path that cannot be safely resolved.`);
				const derived: ShellToken = {
					value: path.join(destination.value, path.basename(source.value)),
					dynamic: false,
					hasGlob: source.hasGlob || destination.hasGlob,
				};
				const result = this.checkTarget(command, derived, cwd, "write");
				if (result.blocked) return result;
			}
		}
		return allowed();
	}

	private checkGuardedCommand(command: ParsedCommand, cwd: string): CommandSafetyResult {
		if (!GUARDED_COMMANDS.has(command.name)) return allowed();
		if (command.name === "cp" || command.name === "mv") return this.checkCopyMove(command.name, command.args, cwd);
		if (command.name === "chmod" || command.name === "chown" || command.name === "chgrp") {
			return this.checkTargets(command.name, collectModeOwnerTargets(command.args), cwd);
		}
		if (command.name === "touch") return this.checkTargets(command.name, collectTouchTargets(command.args), cwd);
		if (command.name === "truncate") {
			return this.checkTargets(command.name, collectTruncateTargets(command.args), cwd, "write");
		}
		if (command.name === "dd") {
			const output = ddOutputTarget(command.args);
			return output ? this.checkTarget(command.name, output, cwd, "write") : allowed();
		}
		const policy: PathPolicy =
			command.name === "tee" ? "write" : DELETING_COMMANDS.has(command.name) ? "delete" : "modify";
		return this.checkTargets(command.name, collectSimpleOperands(command.args), cwd, policy);
	}

	private cdTarget(command: ParsedCommand, cwd: string): string | null {
		if (command.name !== "cd") return null;
		const operands = collectSimpleOperands(command.args);
		const target = operands[0];
		if (!target) return this.resolveSymlinks(os.homedir(), cwd);
		if (target.dynamic || target.value === "-") return null;
		return this.resolveSymlinks(target.value, cwd);
	}

	analyze(command: string): CommandSafetyResult {
		let possibleDirectories = new Set([this.workingDirectory]);
		const segments = splitCommandChain(command);
		for (const segment of segments) {
			const pipelinePart = segment.separatorBefore === "|" || segment.separatorAfter === "|";
			const parsedByDirectory = [...possibleDirectories].map((cwd) => ({
				cwd,
				command: unwrapCommand(shellTokens(segment.command, cwd)),
			}));

			for (const parsed of parsedByDirectory) {
				const redirectResult = this.checkRedirects(segment.command, parsed.cwd);
				if (redirectResult.blocked) return redirectResult;
				if (!parsed.command) continue;

				const gitResult = checkDangerousGitCommand(parsed.command);
				if (gitResult.blocked) return gitResult;
				const guardedResult = this.checkGuardedCommand(parsed.command, parsed.cwd);
				if (guardedResult.blocked) return guardedResult;

				const allArguments = segments.flatMap((candidate) => {
					const parsedCandidate = unwrapCommand(shellTokens(candidate.command, parsed.cwd));
					return parsedCandidate?.args ?? [];
				});
				const compoundResult = this.checkCompoundCommand(parsed.command, allArguments, parsed.cwd);
				if (compoundResult.blocked) return compoundResult;
			}

			if (pipelinePart) continue;
			const changedDirectories = new Set<string>();
			for (const parsed of parsedByDirectory) {
				if (!parsed.command || parsed.command.name !== "cd") continue;
				const target = this.cdTarget(parsed.command, parsed.cwd);
				if (target) changedDirectories.add(target);
			}
			if (changedDirectories.size === 0) continue;

			if (segment.separatorBefore === "&&" || segment.separatorBefore === "||") {
				possibleDirectories = new Set([...possibleDirectories, ...changedDirectories]);
			} else {
				possibleDirectories = changedDirectories;
			}
		}
		return allowed();
	}

	validatePath(inputPath: string): CommandSafetyResult {
		if (!inputPath) return allowed();
		return this.checkTarget(
			"file operation",
			{ value: inputPath, dynamic: false, hasGlob: false },
			this.workingDirectory,
			"write",
		);
	}
}
