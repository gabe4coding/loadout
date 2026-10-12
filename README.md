# loadout

<p align="center">
  A Claude Code plugin that makes the start of each session smaller.
  It reads your first prompt and hides the tools, skills and MCP server instructions that the task does not need.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/gabe4coding/loadout?color=blue"></a>
  <a href="docs/installation.mdx"><img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=claude&logoColor=white"></a>
  <a href="https://github.com/gabe4coding/loadout/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/gabe4coding/loadout/actions/workflows/test.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/usage.mdx">Usage</a> ·
  <a href="docs/how-it-works.mdx">How it works</a> ·
  <a href="docs/troubleshooting.mdx">Troubleshooting</a>
</p>

---

At session start, Claude reads long listings before it reads your prompt: deferred tools, skills and MCP server
instructions. With many servers and plugins, these listings are a large part of each request. Most of the items
are not related to your task.

Without loadout, you turn off servers and plugins by hand for each task. With loadout, the plugin
selects the items from your first prompt.

- **Smaller requests**: the plugin removes the tool groups, skills and server instructions that the task does not
  need.
- **Nothing breaks**: a hidden item still works. Claude finds it with ToolSearch or SearchSkills.
- **Valid prompt cache**: the listings change one time, before the first request. A later prompt gets a short note
  instead.
- **Safe failure**: if the classifier fails, the plugin keeps all items.

## Quick start

You need Claude Code 2.1.296 or later.

Type these commands at the prompt of a Claude Code session:

```
/plugin marketplace add gabe4coding/loadout
/plugin install loadout@loadout
```

Start a new session and write your task. Then type `/loadout` to see the items that the plugin kept and hid.

## Example

You start a session with this prompt: *"Check the login page in the browser and fix the layout bug."*

The plugin keeps the browser tools and hides the other tool groups. The tool listing then ends with this note:

```
(loadout hid 249 more deferred tools that look unrelated to this task, from: datadog (230), slack (19). They still work: ToolSearch finds them by keyword.)
```

Later, you write: *"Now look at the error logs in Datadog."* The plugin adds a note to this prompt only. The note
tells Claude to load the Datadog tools with ToolSearch.

## Documentation

| Page | |
| --- | --- |
| [Installation](docs/installation.mdx) | Requirements, install, local folder, update |
| [Usage](docs/usage.mdx) | The first prompt, `/loadout`, later prompts, cost |
| [How it works](docs/how-it-works.mdx) | One session from start to end, the prompt cache, the data sent |
| [Troubleshooting](docs/troubleshooting.mdx) | Common problems and known limits |
| [Development](docs/development.mdx) | Layout, checks, releases |

## License

MIT. See [LICENSE](LICENSE).
