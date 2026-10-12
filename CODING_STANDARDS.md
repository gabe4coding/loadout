# Coding standards

Rules for changing code, tests, model-facing text and docs in this repo. `[test: x]` marks a rule that a test
enforces; the others rely on discipline.

## Code
- `hooks/` is the hooks module that Claude Code loads (`hooks/hooks.json`). Pure helpers go in `hooks/scope.ts`,
  with no `$`, so tests call them directly. Anything that uses `$` goes in `hooks/register.tsx`, in a function
  declared at the top of the file: the engine's loader follows `$` only there, never across an import, and a module
  that passes `$` to another file does not load. `[test: claude plugin validate .]`
- Spell each state atom at its `read` or `update` call (`read($, tools)`), never through a variable that holds one of
  several atoms: the loader cannot follow it. `readChoice` and `writeChoice` show the pattern.
  `[test: claude plugin validate .]`
- Declare every `$.state` value in `types/index.d.ts`. `[test: claude plugin validate .]`
- Change a listing only before the first request of a session. A later change spends the prompt cache of the whole
  conversation. A later prompt gets a note through `prompt.submit` context instead.
- On any failure (Haiku call, parse, timeout) keep every item. Never let a failure hide an item.
- A guard hook (`prompt.submit`) has a `.catch` that passes the event on, so a failure never drops a prompt.
- Do not depend on the order of the listings. Claude Code can raise the MCP instructions before the tool listing:
  `trimmed` then classifies the tool groups from `$.tool.list()`, and the tool listing reuses the decision.
  `[test: smoke.e2e.mjs]`
- Write one trace line for each decision that a smoke check reads. A trace line holds names and counts, never
  prompt text.

## Tests and commits
- Before every commit, run all three checks. `[test: CI runs all three]`
  - `claude plugin validate .`: the manifests, the module and the state contract, as the engine reads them.
  - `claude plugin test .`: the hooks against a fake host (`tests/*.test.ts`). Mock `model.complete` there: the
    test kit has no model.
  - `node tests/docs.check.mjs`: the doc rules below.
- `node tests/smoke.e2e.mjs`: real `claude -p` with the plugin and two fake MCP servers, two prompts in one
  session. It needs a login and costs API usage, so it is not one of the three checks and CI does not run it. Run it
  after a change to `hooks/`, before a release, and after you raise the pinned Claude Code version. Its checks read
  the trace file (`traceFile` option) and the fake servers' calls, never the words of the model: the transcript keeps
  a listing as Claude Code made it, not as the plugin answered it.
- Write a test for each behaviour change. A test that needs `ui.status` or `ui.invalidate` registers the `quiet`
  hooks in `tests/loadout.test.ts`: the kit has no implementation for them.
- CI (`.github/workflows/test.yml`) pins the Claude Code version for `claude plugin test .`, and a weekly job runs
  the tests with the newest release.
- The type check (`docs/development.mdx`) does not run in CI: its types come from a logged-in Claude Code session.
  Run it after a change to types or to the engine API that the hooks use.
- Never put real prompts, MCP data, company names, user ids or tokens in tests or docs: this repo is public. Use
  `datadog`, `slack` and similar generic server names.

## Plugin
- When anything under `hooks/`, `types/` or `.claude-plugin/plugin.json` changes, bump `version` in
  `.claude-plugin/plugin.json`: Claude Code caches a plugin per version.
  `[test: CI runs tests/version.check.mjs on each pull request]`

## Model-facing text
The text a model reads is part of the product: the notes that `rebuild` adds to a listing (`note` in
`hooks/scope.ts`), the notes for later prompts (`recallNotes` in `hooks/register.tsx`), and the Haiku prompts
`SYSTEM` and `RECALL`.
- Every sentence must change what the model does. Remove facts the model cannot act on.
- Each listing note says that the hidden items still work and names the way to reach them (ToolSearch,
  SearchSkills, the Skill tool). Without it, Claude treats a hidden item as missing.
- Notes load in every session, so each word costs tokens in every session.
- The Haiku prompts ask to keep generously at session start and to pick few on later prompts. A wrong cut costs a
  search, a wrong pick costs a few tokens.

## Docs
User docs are `README.md` and `docs/*.mdx`. They are for humans first: a developer who installs the plugin or
changes it. Out of this set: `AGENTS.md`, this file and the model-facing text above.
`tests/docs.check.mjs` checks the rules marked `[test]`.

### Content
- `README.md` stays a short landing page: pitch, quick start, one example, links. User docs live in `docs/*.mdx`.
  When behaviour changes, change the matching page.
- The code is the source of truth. Check every default, limit and behaviour in `hooks/` before you write it.
- Lead with what the reader wants to do and a short example. Reference tables come after.
- Keep only facts that change what a user does or understands. Leave out function names unless the user types
  them, and history.

### Format
- Each `docs/*.mdx` starts with front matter (`title`, one-sentence `description`) and an H1 equal to the title.
  `[test]`
- Plain Markdown, no JSX, imports or comments, so GitHub renders them. Keep `<…>` and `{…}` inside backticks or
  code blocks: MDX reads them as JSX. `[test]`
- Relative links use the `.mdx` name and the GitHub heading slug. When you rename a heading, fix every link to it.
  `[test: every link and anchor must resolve]`

### Language: ASD-STE100 (Simplified Technical English)
Technical names are allowed: tool names, options, file and product names.
- Instructions: imperative, one instruction per sentence, at most 20 words, condition first ("If X, do Y").
- Descriptions: at most 25 words per sentence `[test]`, one topic per sentence, at most 6 sentences per paragraph.
- Active voice, simple present. "can" for possibility, "must" for a requirement, "do not" for a prohibition.
- No should/may/might/would/could, contractions, semicolons, e.g./i.e./etc., or filler words (just, simply,
  easily) `[test]`. No -ing forms where a plain verb works. Keep the articles.
- Vertical lists for three or more items, numbered lists when order matters. A warning starts with the
  instruction, then gives the reason.
- One word for one meaning, in all docs:

| Term | Meaning | Do not use |
| --- | --- | --- |
| plugin | loadout as Claude Code installs it | mod, extension |
| listing | A list that Claude reads at session start: the deferred tools, the skills or the MCP server instructions | catalog, context |
| item | One entry of a listing: a tool, a skill or the instructions of one server | entry |
| tool group | The MCP tools of one server | server tools, toolset |
| loadout | The items that the plugin keeps for a session | profile, filter, scope |
| hidden item | An item that the plugin removed from a listing. It still works. | removed, disabled |
| note | A text that the plugin adds for Claude: at the end of a listing, or after a later prompt | hint, message |
| classifier | The Haiku call that selects the items to keep | model, AI |
| first prompt | The first prompt of a session that is not empty | initial prompt |
| later prompt | A prompt after the first prompt, sent by the user | follow-up |
