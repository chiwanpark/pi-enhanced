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

### Example

```json
{
  "piEnhanced": {
    "compactThresholdTokens": 100000
  }
}
```

## References

- [vinyroli/pi-codex-theme](https://github.com/vinyroli/pi-codex-theme)
- [ajarellanod/pi-usage-bars](https://github.com/ajarellanod/pi-usage-bars)
