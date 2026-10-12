// What the classifier kept for one listing; `hidden` are the names cut out.
export type Choice = { kept: string[]; hidden: string[] }

// One hidden tool group or skill, with the catalog row a later prompt is
// matched against.
export type Offer = { kind: 'tools' | 'skills'; group: string; row: string }

declare module 'claude-code' {
  interface PluginState {
    'loadout': {
      prompt: string | null
      tools: Choice | null
      skills: Choice | null
      isOff: boolean
      offers: Offer[]
      surfaced: string[]
    }
  }
}
