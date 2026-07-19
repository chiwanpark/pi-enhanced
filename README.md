# pi-enhanced

A simple but powerful toolkits for pi-mono agent.

## Install

```
pi install git:https://github.com/chiwanpark/pi-enhanced
```

## Tools

- `search_web`: Searches the public web through the OpenAI Codex Search API and returns a concise summary with sources. It uses the `openai-codex` OAuth credentials stored by pi; run `/login openai-codex` before using it.

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

- [vinyroli/pi-codex-theme](https://github.com/vinyroli/pi-codex-theme)
- [ajarellanod/pi-usage-bars](https://github.com/ajarellanod/pi-usage-bars)
- [Winds-AI/pi-native-codex-web-search](https://github.com/Winds-AI/pi-native-codex-web-search)
