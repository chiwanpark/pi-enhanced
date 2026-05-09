import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { drawBox, getPackageVersion } from "./internal/common";

const THEME_VERSION = getPackageVersion();

function basename(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	const parts = normalized.split(/[\\/]/);
	return parts[parts.length - 1] || path;
}

export default function welcomeExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		const cwdName = basename(ctx.cwd);
		let model = ctx.model?.id ?? "no-model";
		let thinking = pi.getThinkingLevel();

		ctx.ui.setHeader((_tui, theme: Theme) => ({
			render(width: number): string[] {
				try {
					model = ctx.model?.id ?? "no-model";
					thinking = pi.getThinkingLevel();
				} catch {
					// Session shutdown/replacement can trigger one last render after the
					// extension context is invalidated. Keep showing the last known state.
				}

				const contents = [
					` ${theme.fg("dim", ">_")} ${theme.bold("Pi Enhanced")} ${theme.fg("dim", `(v${THEME_VERSION})`)}`,
					"",
					` ${theme.fg("dim", "model:".padEnd(11))}${model} ${thinking}${theme.fg("accent", "  /model")}${theme.fg("dim", " to change")}`,
					` ${theme.fg("dim", "directory:".padEnd(11))}~/${cwdName}`,
				];
				const preferredContentWidth = Math.max(24, ...contents.map((line) => visibleWidth(line))) + 1;

				return drawBox(theme, contents, {
					indent: " ",
					paddingX: 0,
					maxWidth: Math.max(width, 5),
					minContentWidth: 2,
					preferredContentWidth,
				});
			},
			invalidate() {},
		}));
	});
}
