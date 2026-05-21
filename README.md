# Opencode Session Budget

Local Opencode plugin that stops agent work when a session reaches a user-defined USD budget.

## Usage

This repo is already wired through `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./.opencode/session-budget.js"]
}
```

The plugin injects a `/budget` command for every Opencode session:

```text
/budget 0.25
/budget status
/budget off
```

The value is USD and is compared against Opencode's reported assistant message cost.

Explicit `/budget` settings and observed spend are persisted outside project worktrees by default, keyed by worktree, so restarts keep the same limit and spend without creating files in consumer repos. Default limits from `OPENCODE_SESSION_BUDGET_USD` are recomputed at startup. Set `OPENCODE_SESSION_BUDGET_STATE=/path/to/state.json` or pass `{ "statePath": "/path/to/state.json" }` to move persisted state. Set `OPENCODE_SESSION_BUDGET_PERSIST_STATE=false` or pass `{ "persistState": false }` to keep state in memory only.

## Install

Recommended global install from a public GitHub repo:

```sh
opencode plugin github:carles-grafana/opencode-session-budget --global
```

Pin a tag, branch, or commit:

```sh
opencode plugin github:carles-grafana/opencode-session-budget#v0.1.0 --global
```

Install for only the current project:

```sh
opencode plugin github:carles-grafana/opencode-session-budget
```

Opencode will install the package and update the right config file. Restart Opencode after installing.

If you publish it to npm, the install command becomes:

```sh
opencode plugin opencode-session-budget --global
```

## Manual Install

From a public GitHub repo, users can install it directly as an npm package spec in their global or project Opencode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["github:carles-grafana/opencode-session-budget"]
}
```

To pin a branch, tag, or commit:

```json
{
  "plugin": ["github:carles-grafana/opencode-session-budget#v0.1.0"]
}
```

If you publish it to npm, users can add it by package name instead:

```json
{
  "plugin": ["opencode-session-budget"]
}
```

To use a local clone without publishing:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-session-budget"]
}
```

Opencode installs package plugins at startup, so users need to quit and restart Opencode after changing their config.

## Publishing Checklist

- Push the repo to GitHub with `package.json` at the repository root.
- Create the repository under `carles-grafana/opencode-session-budget` or adjust the examples to match the final repo name.
- Create a release tag, for example `v0.1.0`, and recommend the pinned install command for stable installs.
- If publishing to npm, run `npm publish` after choosing a package name you control.

## Behavior

When the budget is reached, the plugin:

- Aborts the session and its child sessions by default.
- Blocks future model calls, tool executions, slash commands, and compaction auto-continue for the locked session.
- Denies pending permission prompts for the locked session.
- Prints a no-reply message in the session explaining that the budget was reached and how to continue.
- Shows a TUI toast and writes an Opencode app log entry when available.

`/budget` is intercepted before the command prompt reaches the model, so setting or checking a budget should not spend tokens. Opencode does not currently expose a clean "handled command" return from plugins, so the plugin throws after handling `/budget` to stop the normal command path.

Budgets are scoped to the current Opencode session. Subagent child sessions count against their parent session budget; unrelated sessions keep separate budgets and spend.

You can also set a default per-session budget for new sessions with:

```sh
OPENCODE_SESSION_BUDGET_USD=0.25 opencode
```

After changing `opencode.json` or the plugin file, quit and restart Opencode. Config and plugin files are loaded only at startup.
