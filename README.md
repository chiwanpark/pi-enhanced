# pi-enhanced

A simple but powerful toolkits for pi-mono agent.

## Install

```
pi install git:https://github.com/chiwanpark/pi-enhanced
```

## Configuration

This package reads the extension-specific configuration from these files, in order:

- `<project>/.pi/settings.json`
- `~/.pi/agent/settings.json`

Project settings override global settings.

### Items

- `compactThresholdTokens`: The number of tokens to trigger auto-compaction (default: 100000). Other compaction options follow the original pi-mono configuration (`compaction`).
- `semanticDiscipline`: Warns or blocks broad bash scans and large/unbounded reads to encourage LSP/AST-first code navigation.
  - `mode`: `"off"`, `"warn"` (default), or `"block"`.
  - `warnLargeReadLines`: Read line count that triggers discipline feedback (default: 400).
  - `warnUnboundedRead`: Warn on reads without `limit` (default: true).
  - `warnBroadBash`: Warn on broad `find`, `tree`, recursive `ls`, and unscoped `rg`/`grep` (default: true).

### Example

```json
{
  "piEnhanced": {
    "compactThresholdTokens": 100000,
    "semanticDiscipline": {
      "mode": "warn",
      "warnLargeReadLines": 400,
      "warnUnboundedRead": true,
      "warnBroadBash": true
    }
  }
}
```

## References

- [vinyroli/pi-codex-theme](https://github.com/vinyroli/pi-codex-theme)
- [ajarellanod/pi-usage-bars](https://github.com/ajarellanod/pi-usage-bars)
