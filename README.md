# pi-enhanced

A simple but powerful toolkits for pi-mono agent.

## Install

```
pi install git:https://github.com/chiwanpark/pi-enhanced
```

## Tools

- `todo_write`, `ask_user`: TODO tracking for multi-step work, and a focused question prompt for the user.
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

Use `harmfulCommandGuard.allowPaths` and `harmfulCommandGuard.denyPaths` (see [Configuration](#configuration)) to extend or tighten these rules per project.

The guard resolves symlinks (including existing symlink parents of new files), follows `cd` changes, and checks every command in `&&`, `||`, `;`, `|`, and newline chains. Run `/harmful` to toggle harmful mode and temporarily bypass all command, write, and edit checks for the current session branch; `/harmful on` and `/harmful off` set it explicitly, and `/harmful paths` lists the configured path exceptions.

## Configuration

This package reads the extension-specific configuration from these files, in order:

- `<project>/.pi/settings.json`
- `~/.pi/agent/settings.json`

Project settings override global settings.

### Items

- `semanticDiscipline`: Warns or blocks broad bash scans and large or unbounded `read` calls to keep file inspection scoped.
  - `mode`: `"off"`, `"warn"` (default), or `"block"`.
  - `warnLargeReadLines`: `read` line count that triggers discipline feedback (default: 400).
  - `warnUnboundedRead`: Warn on `read` calls without `limit` (default: true).
  - `warnBroadBash`: Warn on broad bash scans such as `find`, `tree`, recursive `ls`, and unscoped `rg`/`grep` (default: true).
- `planMode`: Configures plan mode behavior. Bash remains available for known read-only inspection commands; file writes, mutating commands, dynamic shell execution, and unknown commands are blocked.
  - `blockedTools`: An array of tool names to block completely when Plan Mode is active (default: `["edit", "write"]`).
- `harmfulCommandGuard`: Adds path exceptions to the command and file-operation safety checks. Entries may be absolute, `~`-prefixed, or relative to the project root, and the global and project lists are unioned instead of overridden.
  - `allowPaths`: Roots that may be targeted even outside the working directory. An allowed root also overrides the built-in `.env`/`.git` protection and the device-path deletion rule.
  - `denyPaths`: Roots that are never targetable, even inside the working directory or an allowed root. Deny wins over allow, and also covers ancestors and globs that could expand into the denied path.

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
      "blockedTools": ["edit", "write"]
    },
    "harmfulCommandGuard": {
      "allowPaths": ["~/scratch", "../sibling-repo"],
      "denyPaths": ["./infra/production", "~/.ssh"]
    }
  }
}
```

## References

- [melihmucuk/leash](https://github.com/melihmucuk/leash)
- [vinyroli/pi-codex-theme](https://github.com/vinyroli/pi-codex-theme)
- [ajarellanod/pi-usage-bars](https://github.com/ajarellanod/pi-usage-bars)
- [Winds-AI/pi-native-codex-web-search](https://github.com/Winds-AI/pi-native-codex-web-search)
