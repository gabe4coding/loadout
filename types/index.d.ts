// The two listings that the classifier cuts: the deferred tools, by tool
// group, and the skills.
export type Kind = 'tools' | 'skills'

// The state of one tool group or skill in this session's loadout: kept by the
// classifier, kept because the alwaysKeep option covers it, or hidden.
export type Status = 'kept' | 'always' | 'hidden'

// What the classifier decided for one listing: each group seen so far, with its
// status, in the order seen. A group has one status, so it cannot be kept and
// hidden at once.
export type Decision = Record<string, Status>

// One hidden tool group or skill, with the catalog row a later prompt is
// matched against.
export type Offer = { kind: Kind; group: string; row: string }

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'fable'

// The model change the person approved at the first prompt: the main requests
// on the session's model `from` go to `to`.
export type Route = { from: string; to: string }

// The effort and model changes, on or off.
export type Switches = { effort: boolean; model: boolean }

// The effort the plugin sets on the main requests. `auto`: the latest pick
// sets it, null before the first. `fixed`: a change lost the cache, so the
// effort then stays for the rest of the session.
export type EffortState = { kind: 'auto'; level: Effort | null } | { kind: 'fixed'; level: Effort }

// One MCP server as the picker shows it. `group` is the normalized server
// name; `label` the name a person knows; `tools` the short tool names.
export type ServerFact = { group: string; label: string; tools: string[]; tokens: number }

// One skill as the picker shows it, with its description.
export type SkillFact = { name: string; tokens: number; about: string }

// The options of .claude-plugin/plugin.json (`userConfig`), as the hooks read
// them. tests/contract.check.mjs fails when the two differ.
export type Options = {
  alwaysKeep: string
  newTaskNote: boolean
  effortPerPrompt: boolean
  modelForSession: boolean
  traceFile: string
}

// The token use of a classifier call, as the engine's ModelUsage gives it. The
// contract cannot import the engine type: it must be self-contained.
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// The purpose of a classifier call.
export type Purpose = Kind | 'recall' | 'effort' | 'model'

// One line of the trace file (the traceFile option): one per decision. A
// trace line holds names and counts, never prompt text. tests/smoke.e2e.mjs
// and evals/impact.mjs read these fields.
export type TraceLine =
  | { event: 'classifier'; purpose: Purpose; model: string; isAnswered: boolean; usage: Usage | null }
  | { event: 'listing'; type: string; isScoped: false }
  | { event: 'listing'; type: string; isScoped: true; kept: string[]; alwaysKept: string[]; hidden: string[] }
  | { event: 'mcp_instructions'; where: string; removed: string[] }
  | { event: 'model_pick'; picked: ModelTier | null; session: string; to: string | null }
  | { event: 'model_route'; from: string; to: string; isUsed: boolean }
  | { event: 'effort_pick'; picked: Effort | null }
  | { event: 'effort_change'; from: Effort | number; to: Effort | number; cacheRead: number }
  | { event: 'effort_frozen'; level: Effort; model: string }
  | { event: 'recall'; named: string[]; isNewTask: boolean }

declare module 'claude-code' {
  interface PluginState {
    'loadout': {
      prompt: string | null
      // Null until the first decision of the session for that listing.
      toolDecision: Decision | null
      skillDecision: Decision | null
      isOff: boolean
      offers: Offer[]
      surfaced: string[]
      // The last prompts of the person, newest last, for the new-task check
      // and the effort pick.
      recent: string[]
      effortState: EffortState
      route: Route | null
      // `/loadout effort|model on|off` for this session; a missing key leaves
      // it to the option.
      switches: Partial<Switches>
      // The alwaysKeep names as the first prompt found them. A server that
      // connects later in the session gets the same names.
      pinned: string[]
      // A copy of the marks that /loadout keep and the pane saved in $.store;
      // null until the session reads or writes them.
      marks: string[] | null
      // The skill names of a listing that the plugin did not scope, for
      // /loadout list and the pane. A scoped listing records them in
      // `skillDecision`.
      skillNames: string[]
      // The text of the pane's filter field.
      filter: string
      // What the engine knows about the servers and skills, read when the pane
      // opens, so typing in the filter reads nothing again.
      facts: { servers: ServerFact[]; skills: SkillFact[] } | null
    }
  }
}
