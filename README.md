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
- `/plan`, `/harmful`, `/comments`: Toggle Plan Mode, harmful mode, and the comment guard.

## Command Safety

Bash tool calls are blocked when they:

- Use `rm`, `rmdir`, `unlink`, `shred`, `mv`, `cp`, `chmod`, `chown`, `chgrp`, `tee`, `touch`, `truncate`, `dd`, or `ln` to modify unsafe paths.
- Redirect output to an unsafe path, or use destructive `find`, `xargs`, or `rsync --delete` operations there.
- Target protected project-root `.env` files (except `.env.example`) or the project-root `.git` directory.
- Run destructive Git operations such as checkout/restore discards, hard/merge resets, forced pushes/cleaning, forced branch deletion, or stash drop/clear.

Use `harmfulCommandGuard.allowPaths` and `harmfulCommandGuard.denyPaths` (see [Configuration](#configuration)) to extend or tighten these rules per project.

The guard resolves symlinks (including existing symlink parents of new files), follows `cd` changes, and checks every command in `&&`, `||`, `;`, `|`, and newline chains. Run `/harmful` to toggle harmful mode and temporarily bypass all command, write, and edit checks for the current session branch; `/harmful on` and `/harmful off` set it explicitly, and `/harmful paths` lists the configured path exceptions.

## Comment Guard

`write` and `edit` calls are blocked when they add comments, so generated code stays free of narration that the user never asked for.

- Comments are detected per language: `//` and `/* */`, `#`, `--`, `--[[ ]]`, `<!-- -->`, and Python docstrings. Markers inside strings, template literals, escapes, and `${var#pattern}`-style shell expansions are ignored, and unknown file types (`.json`, `.txt`, ...) are skipped.
- Only new comments count. A comment that already exists somewhere in the file may be moved or re-indented, and `edit` only inspects the lines it inserts.
- Tooling directives stay allowed: shebangs, `eslint-disable`, `@ts-expect-error`, `prettier-ignore`, `biome-ignore`, `noqa`, `type:`, `go:build`, `SPDX-License-Identifier`, `region`, and similar pragmas.
- While the guard is active it adds a matching system prompt guideline, so the model knows the rule before it writes instead of learning it from a rejection.

Use `commentGuard` (see [Configuration](#configuration)) to switch to `warn` or `off`, add allow patterns, or skip paths. Run `/comments` to allow comments for the current session branch when the user asks for them; `/comments on` and `/comments off` set it explicitly.

## OpenTelemetry Exporter

Exports pi usage as OpenTelemetry metrics and log events using the same metric names, event names, and attributes as the Claude Code Enterprise OTEL integration, so existing collectors and dashboards work without changes. Telemetry is off until you enable it, and no content is exported unless you opt in.

Enable it with the Claude Code environment variables or with the `otelExporter` settings block:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4317
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <token>"
```

### Reusing the Claude Code Destination

In a Claude Code Enterprise deployment the endpoint and credentials are pushed to each machine as an `env` block instead of being typed by hand. Set `otelExporter.discoverClaudeCodeSettings` to `true` and pi reads that block and reports to the same collector, with no endpoint or token in pi's own configuration:

```json
{ "piEnhanced": { "otelExporter": { "discoverClaudeCodeSettings": true } } }
```

Files are read in this order, later ones overriding earlier ones per key:

1. `~/.claude/settings.json`
2. `<project>/.claude/settings.json`, then `<project>/.claude/settings.local.json`
3. `managed-settings.json` and `managed-settings.d/*.json` in the system directory: `/etc/claude-code` on Linux and WSL, `/Library/Application Support/ClaudeCode` on macOS, `C:\Program Files\ClaudeCode` on Windows
4. `~/.claude/remote-settings.json`, the cached server-managed settings Claude Code refreshes hourly

Borrowed configuration exports only requests to the first-party Anthropic API, because the endpoint and credential belong to the organization's Claude Code deployment. Requests served by any other provider produce no export at all, including Claude reached through a gateway or reseller . In a mixed session only the Anthropic requests, and the tool calls and metrics around them, are reported, and a session that never calls Anthropic never even loads the OpenTelemetry SDK. Set `otelExporter.restrictToAnthropicProvider` to `false` to report every provider, or to `true` to apply the same restriction to configuration you wrote yourself.

It also reports the identity Claude Code reports: `user.id` is the anonymous installation id from `~/.claude.json`, and `user.email`, `user.account_uuid`, and `organization.id` come from the account it is logged in as, falling back to the account recorded in `~/.claude/remote-settings-consent.json`. Rows from pi then land on the same user, account, and organization the dashboards already group by, instead of under an id only pi knows. Set `otelExporter.useClaudeCodeIdentity` to `false` to keep pi's own anonymous id, or to `true` to adopt the Claude Code identity for configuration you wrote yourself.

### Metrics

Each metric is computed the way Claude Code computes it, so a dashboard built for Claude Code reads pi's rows without adjustment.

| Metric                                | Source in pi                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `claude_code.session.count`           | `session_start`, with `start_type` derived from the session reason                                         |
| `claude_code.token.usage`             | Assistant message usage, split into `input`, `output`, `cacheRead`, and `cacheCreation`                    |
| `claude_code.cost.usage`              | Assistant message cost total in USD                                                                        |
| `claude_code.lines_of_code.count`     | Lines added and removed, diffed from the file before and after each `edit`/`write`                         |
| `claude_code.commit.count`            | One per bash command that runs `git commit` and exits 0, the same heuristic Claude Code applies            |
| `claude_code.pull_request.count`      | One per bash command that runs `gh pr create` or `glab mr create` and exits 0                              |
| `claude_code.code_edit_tool.decision` | Accepted and guard-rejected `edit`/`write` calls, with the file language when it is known                  |
| `claude_code.active_time.total`       | Keystroke gaps shorter than five seconds while the agent is idle (`type=user`) and agent runs (`type=cli`) |

Metric datapoints and events carry the Claude Code standard attribute set (`user.id`, `session.id`, `user.email`, `user.account_uuid`, `user.account_id`, `organization.id`, `terminal.type`), filtered by the same `OTEL_METRICS_INCLUDE_*` controls, and are published under the `com.anthropic.claude_code` instrumentation scopes. Token and cost datapoints carry `model`, `query_source`, and the provider-native `effort` when the response reports one. The resource carries `service.name`, `service.version` (this package's version, which is how pi rows can be told apart from Claude Code rows), `os.type`, `os.version`, and `host.arch`.

Metrics are exported with delta temporality, Claude Code's default, so a collector built for it sums the increments it receives. Set `otelExporter.temporalityPreference` to `"cumulative"` only when the backend expects cumulative sums; a backend that sums deltas counts a cumulative series again on every export interval.

### Events

`user_prompt`, `assistant_response`, `api_request`, `api_error`, `api_refusal`, `tool_result`, `tool_decision`, `permission_mode_changed`, `compaction`, and `internal_error`. Every event carries `prompt.id`, so one prompt and all of its API requests and tool calls can be correlated. Prompt text, response text, and tool arguments are replaced with `<REDACTED>` unless the matching `OTEL_LOG_*` flag is set.

Run `/otel` to see the active exporters, resolved endpoints, whether this session is exporting, and the last error. The command is available even while telemetry is off, where it reports what is missing.

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
- `commentGuard`: Blocks or warns when `write` and `edit` add comments. Global and project lists are unioned instead of overridden.
  - `mode`: `"off"`, `"warn"`, or `"block"` (default).
  - `allowDirectives`: Allow tooling directives such as shebangs, `eslint-disable`, `@ts-expect-error`, and `noqa` (default: true).
  - `allowPatterns`: Extra regular expressions, matched against the comment text, that stay allowed.
  - `ignorePaths`: Project-relative or absolute paths whose files are never checked.
- `planMode`: Configures plan mode behavior. Bash remains available for known read-only inspection commands; file writes, mutating commands, dynamic shell execution, and unknown commands are blocked.
  - `blockedTools`: An array of tool names to block completely when Plan Mode is active (default: `["edit", "write"]`).
- `harmfulCommandGuard`: Adds path exceptions to the command and file-operation safety checks. Entries may be absolute, `~`-prefixed, or relative to the project root, and the global and project lists are unioned instead of overridden.
  - `allowPaths`: Roots that may be targeted even outside the working directory. An allowed root also overrides the built-in `.env`/`.git` protection and the device-path deletion rule.
  - `denyPaths`: Roots that are never targetable, even inside the working directory or an allowed root. Deny wins over allow, and also covers ancestors and globs that could expand into the denied path.
- `webSearch`: Configures the `search_web` tool.
  - `model`: The OpenAI model used for the search request (default: `"gpt-5.6-luna"`).
  - `maxSources`: Default number of sources returned when the tool call omits `maxSources` (default: 5).
  - `maxAllowedSources`: Upper bound on the sources a single call may request (default: 10).
  - `timeoutMs`: Request timeout in milliseconds (default: 120000).
  - `endpoint`: Search API endpoint (default: `"https://chatgpt.com/backend-api/codex/responses"`).
  - `reasoningEffort`: Reasoning effort sent with the search request: `"none"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"`. Unset leaves the effort to the provider default.
- `otelExporter`: Configures the [OpenTelemetry exporter](#opentelemetry-exporter). Settings override the equivalent environment variables, and project settings override global ones.
  - `enabled`: Master switch, the equivalent of `CLAUDE_CODE_ENABLE_TELEMETRY` (default: false).
  - `discoverClaudeCodeSettings`: Adopt the telemetry `env` block from the Claude Code settings chain when the environment leaves a value unset (default: false). See [Reusing the Claude Code Destination](#reusing-the-claude-code-destination).
  - `restrictToAnthropicProvider`: Export only requests served by the first-party `anthropic` provider, excluding gateways and resellers (default: true when `discoverClaudeCodeSettings` supplied the configuration, otherwise false).
  - `serviceName`: Value of the `service.name` resource attribute (default: `"claude-code"` when `discoverClaudeCodeSettings` supplied the configuration, otherwise `"pi"`).
  - `useClaudeCodeIdentity`: Report the user, account, and organization Claude Code reports on this machine (default: true when `discoverClaudeCodeSettings` supplied the configuration, otherwise false).
  - `metricsExporter`: `"otlp"`, `"console"`, `"prometheus"`, `"none"`, or an array of them (default: none).
  - `logsExporter`: `"otlp"`, `"console"`, `"none"`, or an array of them (default: none).
  - `protocol`, `metricsProtocol`, `logsProtocol`: `"grpc"`, `"http/protobuf"`, or `"http/json"` (default: `"http/protobuf"`).
  - `endpoint`, `metricsEndpoint`, `logsEndpoint`: Collector endpoints. The generic endpoint gets `/v1/metrics` or `/v1/logs` appended for the HTTP protocols, unless it already ends with that path.
  - `headers`, `metricsHeaders`, `logsHeaders`: Header objects merged onto the generic headers for that signal.
  - `metricExportIntervalMillis`: Metric export interval (default: 60000).
  - `logsExportIntervalMillis`: Log batch delay (default: 5000).
  - `temporalityPreference`: `"delta"` or `"cumulative"` (default: `"delta"`).
  - `prometheusHost`, `prometheusPort`: Scrape endpoint for the Prometheus exporter (default: `"localhost"`, 9464).
  - `resourceAttributes`: Extra attributes merged with `OTEL_RESOURCE_ATTRIBUTES`.
  - `organizationId`: Value of the `organization.id` attribute, the equivalent of `CLAUDE_CODE_ORGANIZATION_ID`. Never guessed from the user's email (default: unset).
  - `includeHostAttributes`: Attach the `os.type`, `os.version`, and `host.arch` resource attributes (default: true).
  - `includeSessionId`, `includeVersion`, `includeEntrypoint`, `includeAccountUuid`, `includeResourceAttributes`: Attribute cardinality controls, applied to metrics and events alike as Claude Code does (defaults: true, false, false, true, true).
  - `logUserPrompts`, `logAssistantResponses`, `logToolDetails`: Content opt-ins (default: false). `logAssistantResponses` follows `logUserPrompts` when unset.
  - `contentMaxLength`: Truncation limit for content-bearing attributes (default: 61440).
  - `metrics`: Per-metric toggles, or `false` to disable all of them. Keys: `sessionCount`, `linesOfCode`, `pullRequest`, `commit`, `cost`, `token`, `codeEditToolDecision`, `activeTime` (all default: true).
  - `events`: Per-event toggles, or `false` to disable all of them. Keys: `userPrompt`, `assistantResponse`, `toolResult`, `toolDecision`, `apiRequest`, `apiError`, `apiRefusal`, `permissionModeChanged`, `compaction`, `internalError` (all default: true).

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
    "commentGuard": {
      "mode": "block",
      "allowDirectives": true,
      "allowPatterns": ["^// SAFETY:"],
      "ignorePaths": ["docs", "examples"]
    },
    "planMode": {
      "blockedTools": ["edit", "write"]
    },
    "harmfulCommandGuard": {
      "allowPaths": ["~/scratch", "../sibling-repo"],
      "denyPaths": ["./infra/production", "~/.ssh"]
    },
    "webSearch": {
      "model": "gpt-5.6-luna",
      "reasoningEffort": "low",
      "maxSources": 5,
      "timeoutMs": 120000
    },
    "otelExporter": {
      "enabled": true,
      "metricsExporter": "otlp",
      "logsExporter": "otlp",
      "protocol": "grpc",
      "endpoint": "http://collector.internal:4317",
      "headers": {
        "Authorization": "Bearer <token>"
      },
      "resourceAttributes": {
        "department": "platform"
      },
      "events": {
        "toolResult": false
      }
    }
  }
}
```

## References

- [melihmucuk/leash](https://github.com/melihmucuk/leash)
- [vinyroli/pi-codex-theme](https://github.com/vinyroli/pi-codex-theme)
- [ajarellanod/pi-usage-bars](https://github.com/ajarellanod/pi-usage-bars)
- [Winds-AI/pi-native-codex-web-search](https://github.com/Winds-AI/pi-native-codex-web-search)
