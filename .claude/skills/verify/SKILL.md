---
name: verify
description: Project recipe for /verify in loadout. Drive the plugin in real headless Claude Code against two fake MCP servers with drive.mjs, then judge by the plugin's trace, the notes, the tool calls, the server call log and the token use. Use when you verify a change to hooks/, types/ or .claude-plugin/plugin.json.
---

# Verify loadout

The surface is the agent: real Claude Code with this plugin loaded from the repo (`--plugin-dir`, shown as
`loadout@inline` in the debug log). The plugin changes the listings of the first request, adds notes to later
prompts and answers `/loadout`. A docs-only or tests-only diff has no surface: report SKIP.

`drive.mjs` (next to this file) runs one session per call and prints the evidence as JSON. The session start is in
`tests/session.mjs`, which the smoke test uses too.

## Pick the drive

- `node tests/smoke.e2e.mjs` covers the fixed flow in one run (its `cases`). Run it first. Do not drive this flow
  again step by step.
- Then drive the changed code path with `drive.mjs run` and the prompts that make it run. Put several probes in one
  run when they fit one session.
- Runs are independent (own folder, session and cwd). Start the smoke test and the `drive.mjs` runs at the same
  time, as background jobs.

## Headless

```bash
D=.claude/skills/verify/drive.mjs
node $D run 'List the open issues of project OPS in the issue tracker.' '/loadout' 'Now the weather in Milan tomorrow.' \
  --allow mcp__fake_tracker__list_issues,mcp__fake_weather__get_forecast
node $D clean <dir>          # after you read the evidence
```

Each prompt goes in after the result of the one before. A prompt that starts with `/` runs a command: its output is
that turn's `result`. The servers are `fake_tracker` and `fake_weather`. Their tools and instructions are in
`tests/fake-server.mjs`.

`run` prints:

| Field | What it shows |
| --- | --- |
| `turns` | Each prompt with its reply or command output. `totalCostUsd` counts the whole session so far. |
| `trace` | The plugin's decisions (`listing`, `mcp_instructions`, `recall`). The transcript keeps the listings as Claude Code built them, so judge the cuts here. |
| `notes` | The notes that the plugin added to later prompts, as Claude read them. |
| `toolUses`, `toolResults` | What Claude called and got (results cut to 800 characters). |
| `calls` | What reached the fake servers. |
| `requests` | Each API request: `input`, `cacheRead`, `cacheWrite`. A large `cacheWrite` after the first request means the cached prefix changed. |
| `pluginLog` | The engine's debug lines about the plugin: a hook that failed, was skipped or was bypassed. |

Options: `--settings <json>` for settings and plugin options (`pluginConfigs.loadout.options`), `--model`,
`--base <dir>`, `--no-tool-search` (MCP tools stay in the prompt, so no deferred tool listing). One run with Haiku
costs about $0.01.

## Probes

- `/loadout off` between two prompts: the next request has the full listings (`isScoped: false` in the trace), a
  `cacheWrite` of several thousand tokens, and no note.
- A first prompt with only whitespace, then a real one: the listings stay full for the whole session
  (`isScoped: false`), and no note comes. The real prompt cannot set the loadout: the first request already sent the
  listings.
- A prompt that names nothing hidden: `recall` must name nothing, and `notes` stays empty.
- `--no-tool-search`: no deferred tool listing. The plugin must not fail, and the instructions of a server whose
  tools are in the prompt must stay.

## Gotchas

- Claude Code sends the MCP instructions before the tool listing. The plugin then classifies the tool groups from
  `$.tool.list()` first.
- The built-in security module skips the plugin's `prompt.section` hook (`pluginLog`: `prompt.section bypassed by
  cc-plugin-sec-default`). The instructions reach the plugin as the `mcp_instructions_delta` attachment.
- User-level plugins still load with `--restricted`: their skills are in the skill listing, so `kept` and `hidden`
  for skills differ from machine to machine. Judge skill cuts by count and by the note, not by names.
- `/loadout` output starts with `loadout: ` in a headless `result`: Claude Code adds the plugin name.
- Both the classifier and Claude are models. If a step did not happen, run again before you call it a failure.
