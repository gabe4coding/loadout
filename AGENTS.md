# loadout

A Claude Code plugin (one hooks module). It reads the first prompt of a session, asks Haiku which deferred tools,
skills and MCP server instructions the task needs, and hides the rest from the listings Claude reads. A later prompt
gets a note when it needs a hidden item. The whole repo is the plugin (marketplace source `./`).

## Read first, by task
- Any change to code, tests, model-facing text or docs → `CODING_STANDARDS.md`.
- Hooks, Haiku calls, `/loadout`, session state → `hooks/register.tsx`. Parse and rebuild of listings (pure, no `$`)
  → `hooks/scope.ts`. State contract → `types/index.d.ts`.
- Behaviour end to end → `docs/how-it-works.mdx`. Known limits → `docs/troubleshooting.mdx`.
- What real Claude Code does (event order, origins) → `tests/smoke.e2e.mjs` and its trace. Run it before you trust
  an assumption about the engine.
- The engine API (`$`, events, `claude-code/testing`) → `.claude-plugin/types/claude-code/index.d.ts`. Claude Code
  writes it when the plugin loads with `--plugin-dir`. It is not in git.

## Rules
- Never change a listing after the first request of a session: the listings sit in the first message, so a change
  spends the prompt cache of the whole conversation. Reach later prompts only through `prompt.submit` context.
- On any failure keep everything: a wrong cut costs more than no cut.
- Run the three checks in `CODING_STANDARDS.md` before every commit.
