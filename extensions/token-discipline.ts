import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const TOKEN_DISCIPLINE_GUIDANCE = [
	"Token discipline rules:",
	"- Prefer ast_search and lsp_definition before broad read or bash scans.",
	"- Use read with offset and limit for large files, then continue in chunks only as needed.",
	"- Keep bash/search scoped to specific paths and patterns; avoid broad scans across installed dependencies, docs, or home directories unless the task truly requires them.",
	"- Reuse earlier findings when possible instead of repeating large reads or searches.",
	"- When output may be large, get a narrow slice first and expand only if it is still necessary.",
	"- After docs-heavy or repo-archeology work, prefer a fresh session before implementation work.",
].join("\n");

export function appendTokenDisciplineGuidance(systemPrompt: string): string {
	if (systemPrompt.includes(TOKEN_DISCIPLINE_GUIDANCE)) {
		return systemPrompt;
	}

	return `${systemPrompt}\n\n${TOKEN_DISCIPLINE_GUIDANCE}`;
}

export default function tokenDisciplineExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: appendTokenDisciplineGuidance(event.systemPrompt),
	}));
}
