// What the classifier kept for one listing; `hidden` are the names cut out,
// `always` the kept names that the alwaysKeep option covered.
export type Choice = { kept: string[]; hidden: string[]; always: string[] }

// One hidden tool group or skill, with the catalog row a later prompt is
// matched against.
export type Offer = { kind: 'tools' | 'skills'; group: string; row: string }

// One MCP server as the picker shows it. `group` is the normalized server
// name; `label` the name a person knows; `tools` the short tool names.
export type ServerFact = { group: string; label: string; tools: string[]; tokens: number }

// One skill as the picker shows it, with its description.
export type SkillFact = { name: string; tokens: number; about: string }

declare module 'claude-code' {
  interface PluginState {
    'loadout': {
      prompt: string | null
      tools: Choice | null
      skills: Choice | null
      isOff: boolean
      offers: Offer[]
      surfaced: string[]
      // The alwaysKeep names as the first prompt found them. A server that
      // connects later in the session gets the same names.
      pinned: string[]
      // A copy of the marks that /loadout keep and the pane saved in $.store;
      // null until the session reads or writes them.
      marks: string[] | null
      // The skill names of a listing that the plugin did not scope, for
      // /loadout list and the pane. A scoped listing records them in `skills`.
      skillNames: string[]
      // The text of the pane's filter field.
      filter: string
      // What the engine knows about the servers and skills, read when the pane
      // opens, so typing in the filter reads nothing again.
      facts: { servers: ServerFact[]; skills: SkillFact[] } | null
    }
  }
}
