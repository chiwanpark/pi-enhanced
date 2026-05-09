import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TOKEN_DISCIPLINE_GUIDANCE = [
	"Token and context discipline rules:",
	"- Start with the narrowest tool that can answer the question; avoid broad scans unless required.",
	"- Reuse earlier findings instead of repeating large reads or searches.",
	"- When output may be large, request a narrow slice first and expand only if necessary.",
	"- Keep bash/search scoped to specific paths and patterns; avoid installed/generated directories, docs, or home directories unless the task requires them.",
	"- Do not read entire large files. Prefer symbols, diagnostics, definitions, references, hovers, or small offset+limit slices.",
	"- For codebase exploration, follow: code_overview -> lsp_symbols/ast_search -> lsp_definition/lsp_references -> targeted read slices.",
	"- Use textual search for literal strings, configs, docs, routes, CSS classes, test titles, or after semantic tools fail—not as the default for code symbols.",
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
