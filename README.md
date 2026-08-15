# pi-enhanced

A simple but powerful toolkits for pi-mono agent.

## Install

```
pi install git:https://github.com/chiwanpark/pi-enhanced
```

## Tools

- `search_web`: Searches the public web through the OpenAI Codex Search API and returns a concise summary with sources. It uses the `openai-codex` OAuth credentials stored by pi; run `/login openai-codex` before using it.

## Commands

- `/usage`: Shows the rolling limits (5h / weekly, or the provider equivalent) and the credit balance of every logged-in provider, together with the account each one belongs to. Model-scoped windows (e.g. Claude's per-model weekly limit) are listed as extra rows, and credit-metered plans (e.g. Codex Business/Enterprise workspaces, Claude extra usage) report a credits row instead of rolling windows.
- `/status`: Shows the current model, directory, `AGENTS.md` files, account, session id, and the limits of the active provider.
- `/system-prompt`: Shows the current effective system prompt.
- `/plan`, `/harmful`: Toggle Plan Mode and harmful mode.

## Command Safety

Bash tool calls are blocked when they:

- Use `rm`, `rmdir`, `unlink`, `shred`, `mv`, `cp`, `chmod`, `chown`, `chgrp`, `tee`, `touch`, `truncate`, `dd`, or `ln` to modify unsafe paths.
- Redirect output to an unsafe path, or use destructive `find`, `xargs`, or `rsync --delete` operations there.
- Target protected project-root `.env` files (except `.env.example`) or the project-root `.git` directory.
- Run destructive Git operations such as checkout/restore discards, hard/merge resets, forced pushes/cleaning, forced branch deletion, or stash drop/clear.

The same path restrictions apply to `write` and `edit`. Temporary directories, device output paths, and agent platform directories (`~/.pi`, `~/.claude`, `~/.factory`, and `~/.config/opencode`) follow Leash's allow rules.

The guard resolves symlinks (including existing symlink parents of new files), follows `cd` changes, and checks every command in `&&`, `||`, `;`, `|`, and newline chains. Run `/harmful` to toggle harmful mode and temporarily bypass all command, write, and edit checks for the current session branch; `/harmful on` and `/harmful off` set it explicitly.

## Configuration

This package reads the extension-specific configuration from these files, in order:

- `<project>/.pi/settings.json`
- `~/.pi/agent/settings.json`

Project settings override global settings.

### Items

- `semanticDiscipline`: Warns or blocks broad bash/file-tool scans and large/unbounded reads to encourage LSP/AST-first code navigation.
  - `mode`: `"off"`, `"warn"` (default), or `"block"`.
  - `warnLargeReadLines`: Read line count that triggers discipline feedback (default: 400).
  - `warnUnboundedRead`: Warn on reads without `limit` (default: true).
  - `warnBroadBash`: Warn on broad bash scans (`find`, `tree`, recursive `ls`, unscoped `rg`/`grep`) and broad `glob`, `grep`, or `ls` tool calls (default: true).
- `planMode`: Configures plan mode behavior.
  - `blockedTools`: An array of tool names to block when Plan Mode is active (default: `["bash", "edit", "write"]`).

### Example

```json
{
  "piEnhanced": {
    "semanticDiscipline": {
      "mode": "warn",
      "warnLargeReadLines": 400,
      "warnUnboundedRead": true,
      "warnBroadBash": true
    },
    "planMode": {
      "blockedTools": ["bash", "edit", "write"]
    }
  }
}
```

## References

- [melihmucuk/leash](https://github.com/melihmucuk/leash)
- [vinyroli/pi-codex-theme](https://github.com/vinyroli/pi-codex-theme)
- [ajarellanod/pi-usage-bars](https://github.com/ajarellanod/pi-usage-bars)
- [Winds-AI/pi-native-codex-web-search](https://github.com/Winds-AI/pi-native-codex-web-search)
