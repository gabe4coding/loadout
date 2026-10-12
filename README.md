# context-scope

A Claude Code mod that makes the session setup smaller.

At the start of a session, Claude reads long lists: deferred tools, skills and MCP server instructions. Most of them are not related to the task. This mod reads your first prompt and removes the items that the task does not need.

## How it works

1. The mod saves the first prompt of the session.
2. It sends the prompt and a short catalog to Haiku. The catalog has the MCP tools in groups by server, and each skill.
3. Haiku replies with the items to keep. If the call fails, the mod keeps all items.
4. The mod removes the other items from:
   - the deferred tool list (built-in tools always stay)
   - the skill list
   - the MCP server instructions of the hidden servers
5. Each list gets a note: hidden items still work, and Claude can find them with ToolSearch or SearchSkills.

On a later prompt, the mod does not change the lists, because that would make the prompt cache invalid. It asks Haiku if the new prompt needs a hidden item. If yes, it adds a note to that prompt only, which tells Claude how to load the item. The mod names each item one time per session.

## Commands

- `/scope`: shows the kept items, the hidden items and the items named to later prompts.
- `/scope off`: puts the full lists back for this session.
- `/scope on`: turns the mod on again.

## Install

Run these commands in a terminal:

```bash
claude plugin marketplace add /Users/gpavanello/Repositories/dynamic-profiles
claude plugin install context-scope@dynamic-profiles --scope user
```

Claude Code reads the mod from this folder. After you change a file, run `/reload-plugins` in an open session.

## Development

```bash
claude plugin validate .
claude plugin test .
```

## Files

- `hooks/register.ts`: the hooks, the Haiku calls and `/scope`
- `hooks/scope.ts`: reads and rebuilds the lists
- `hooks/scope.test.ts`: the tests
- `types/index.d.ts`: the state the mod keeps for the session
