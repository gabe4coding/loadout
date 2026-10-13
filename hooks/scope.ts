// Pure helpers, with no `$`: parse the listings the engine injects, group their
// entries and rebuild them with only the groups the classifier kept, and read
// the words, options and decisions that register uses.

import type { Decision, Effort, Kind, ModelTier, Options, ServerFact, SkillFact, Status } from '../types'

// A deferred tool line is one bare name; an MCP tool is mcp__<server>__<tool>.
const TOOL_LINE = /^[A-Za-z0-9_.:-]+$/
const SKILL_LINE = /^- ([^\s:]+(?::[^\s:]+)?)(?::\s|$)/

export const CORE = 'core'

export const KINDS: readonly Kind[] = ['tools', 'skills']

export function toolGroup(name: string): string {
  const parts = splitMcpName(name)
  return parts === null ? CORE : normalize(parts.server)
}

// The server and tool parts of `mcp__<server>__<tool>`, or null for another tool.
export function splitMcpName(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.*)$/.exec(name)
  return match?.[1] === undefined || match[2] === undefined ? null : { server: match[1], tool: match[2] }
}

export function normalize(server: string): string {
  return server.toLowerCase().replace(/[^a-z0-9]+/g, '_')
}

export type Entry = { name: string; group: string; lines: string[] }
export type Listing = { head: string[]; entries: Entry[]; tail: string[] }

export function parseTools(text: string): Listing {
  const head: string[] = []
  const entries: Entry[] = []
  const tail: string[] = []
  for (const line of text.split('\n')) {
    const name = line.trim()
    if (TOOL_LINE.test(name)) {
      entries.push({ name, group: toolGroup(name), lines: [line] })
    } else if (entries.length === 0) {
      head.push(line)
    } else {
      tail.push(line)
    }
  }
  return { head, entries, tail }
}

// Each skill is its own group: unprefixed user skills would otherwise be one
// group that is always kept.
export function parseSkills(text: string): Listing {
  const head: string[] = []
  const entries: Entry[] = []
  for (const line of text.split('\n')) {
    const name = SKILL_LINE.exec(line)?.[1]
    const last = entries[entries.length - 1]
    if (name) {
      entries.push({ name, group: name, lines: [line] })
    } else if (last) {
      last.lines.push(line)
    } else {
      head.push(line)
    }
  }
  return { head, entries, tail: [] }
}

// One catalog row per group the classifier may drop. `core` tools are never
// offered: they are few and cheap.
export type Row = { group: string; row: string }

function toolCatalog(listing: Listing): Row[] {
  const byGroup = new Map<string, string[]>()
  for (const entry of listing.entries) {
    if (entry.group === CORE) continue
    const short = splitMcpName(entry.name)?.tool ?? entry.name
    byGroup.set(entry.group, [...(byGroup.get(entry.group) ?? []), short])
  }
  return [...byGroup].map(([group, tools]) => ({
    group,
    row: `${group} (${tools.length} tools): ${tools.slice(0, 10).join(', ')}`,
  }))
}

function skillCatalog(listing: Listing): Row[] {
  return listing.entries.map(entry => ({
    group: entry.group,
    row: entry.lines.join(' ').slice(2, 160).replace(/\s+/g, ' '),
  }))
}

export const CATALOG: Record<Kind, (listing: Listing) => Row[]> = { tools: toolCatalog, skills: skillCatalog }

// The groups that a listing of each kind always shows: the `core` tools.
const ALWAYS_SHOWN: Record<Kind, readonly string[]> = { tools: [CORE], skills: [] }

export function groupsOf(listing: Listing, kind: Kind): string[] {
  const groups = new Set(listing.entries.map(entry => entry.group))
  for (const group of ALWAYS_SHOWN[kind]) groups.delete(group)
  return [...groups]
}

// The MCP tools of the session ($.tool.list()) as a tool listing.
export function mcpTools(listed: readonly { name: string; mcp: boolean }[]): Listing {
  return parseTools(listed.filter(info => info.mcp).map(info => info.name).join('\n'))
}

// A server name as a person reads it: a claude.ai connector in the tool-name
// spelling (`claude_ai_Google_Drive`) as the connector list shows it.
export function serverLabel(name: string): string {
  const match = /^claude[._]ai[_ ](.+)$/i.exec(name)
  return match?.[1] ? `claude.ai ${match[1].replace(/_/g, ' ')}` : name
}

// One fact per MCP server of the session: its tools from $.tool.list(), and
// the tokens and the /mcp name from the context breakdown.
export function serverFacts(
  listed: readonly { name: string; mcp: boolean }[],
  counted: readonly { name: string; serverName: string; tokens: number }[],
): ServerFact[] {
  const byGroup = new Map<string, ServerFact>()
  for (const info of listed) {
    const parts = info.mcp ? splitMcpName(info.name) : null
    if (parts === null) continue
    const group = normalize(parts.server)
    const fact = byGroup.get(group) ?? { group, label: serverLabel(parts.server), tools: [], tokens: 0 }
    fact.tools.push(parts.tool)
    byGroup.set(group, fact)
  }
  for (const tool of counted) {
    const fact = byGroup.get(toolGroup(tool.name))
    if (fact === undefined) continue
    fact.tokens += tool.tokens
    if (tool.serverName !== '') fact.label = serverLabel(tool.serverName)
  }
  return [...byGroup.values()]
}

// A connector that is not logged in has only its two login tools.
export function isLoginOnly(tools: readonly string[]): boolean {
  return tools.length === 2 && tools.includes('authenticate') && tools.includes('complete_authentication')
}

// "1.2k tokens", or nothing when the engine gave no count.
export function tokenCount(tokens: number): string {
  if (tokens <= 0) return ''
  return `${tokens < 1000 ? tokens : `${(tokens / 1000).toFixed(1)}k`} tokens`
}

// A server's line in the picker: its size, then its first tools or its login state.
export function serverDetail(fact: ServerFact): string {
  const count = `${fact.tools.length} tool${fact.tools.length === 1 ? '' : 's'}`
  const first = `${fact.tools.slice(0, 3).join(', ')}${fact.tools.length > 3 ? ', …' : ''}`
  return [count, tokenCount(fact.tokens), isLoginOnly(fact.tools) ? 'not logged in' : first].filter(Boolean).join(' · ')
}

// A skill's line in the picker: its tokens, then its description.
export function skillDetail(tokens: number, about: string): string {
  return [tokenCount(tokens), about].filter(Boolean).join(' · ')
}

// The skill facts under the names of the skill listing. The context
// breakdown can name a plugin skill without its plugin (`docx` for
// `anthropic-skills:docx`): such a fact takes the one listed name that ends
// with it, so the picker has one row and a mark covers the listed skill.
export function listedSkillFacts(facts: readonly SkillFact[], listed: readonly string[]): SkillFact[] {
  const names = new Set(listed)
  return facts.map(fact => {
    if (names.has(fact.name) || fact.name.includes(':')) return fact
    const matches = listed.filter(name => name.endsWith(`:${fact.name}`))
    return matches.length === 1 && matches[0] !== undefined ? { ...fact, name: matches[0] } : fact
  })
}

// The groups of `listing` that no decision covers yet.
export function unseenGroups(
  listing: Listing,
  kind: Kind,
  before: Decision | null,
): string[] {
  return groupsOf(listing, kind).filter(group => statusOf(before, group) === undefined)
}

// The status of a group, or undefined when the decision has none. Only its own
// keys count: a group named `constructor` is not a status of every decision.
export function statusOf(decision: Decision | null, group: string): Status | undefined {
  return decision !== null && Object.hasOwn(decision, group) ? decision[group] : undefined
}

// The groups of a decision with one of `statuses`, in the order seen. An
// object lists a name that is a number first, which only changes the order.
export function groupsWith(decision: Decision | null, ...statuses: Status[]): string[] {
  return Object.entries(decision ?? {}).filter(([, status]) => statuses.includes(status)).map(([group]) => group)
}

// The groups a decision keeps: by the classifier or by the alwaysKeep option.
export function keptGroups(decision: Decision | null): string[] {
  return groupsWith(decision, 'kept', 'always')
}

// Reads the alwaysKeep option: names split on commas or white space, once each.
export function parseKeep(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(name => name !== ''))]
}

// Whether a name of the alwaysKeep option covers a group. A tool group matches
// its server name in any spelling (`claude-in-chrome`). A skill matches its full
// name, its plugin name alone (`retro` covers `retro:recall`), or its own name
// without the plugin (`recall` covers `retro:recall`): the context breakdown
// and people often leave the plugin out. A name that covers too much keeps
// more, which costs less than a wrong cut.
export function isAlwaysKept(group: string, kind: Kind, names: readonly string[]): boolean {
  return names.some(name => COVERS[kind](name, group))
}

const COVERS: Record<Kind, (name: string, group: string) => boolean> = {
  tools: (name, group) => normalize(name) === group,
  skills: (name, group) => group === name || group.startsWith(`${name}:`) || (!name.includes(':') && group.endsWith(`:${name}`)),
}

// The alwaysKeep names after a mark on a group is set or cleared. Clearing
// removes each name that covers the group, so the group is not kept after.
export function flipKeep(names: readonly string[], group: string, kind: Kind, isOn: boolean): string[] {
  if (!isOn) return names.filter(name => !isAlwaysKept(group, kind, [name]))
  return isAlwaysKept(group, kind, names) ? [...names] : [...names, group]
}

// Reads the classifier's reply: one group id per line, anything else ignored.
export function parseKept(reply: string, groups: readonly string[]): string[] {
  const known = new Set(groups)
  return reply
    .split(/[\n,]/)
    .map(part => part.trim().replace(/^[-*\s`"]+|[`"\s]+$/g, ''))
    .filter(part => known.has(part))
}

// The first line of a later prompt's reply says if the prompt starts a new task.
export function isNewTask(reply: string): boolean {
  const first = reply.trim().split('\n')[0] ?? ''
  return /^[-*\s`"]*new task[`"\s.:]*$/i.test(first)
}

// From the lowest to the highest. The EFFORT prompt names them from this list.
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
// From the smallest model to the largest. The MODEL prompt names them from
// this list, and each takes the effort in a message (a test checks it).
export const MODEL_ID: Record<ModelTier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}
export const MODELS = Object.keys(MODEL_ID) as ModelTier[]

// "a, b or c", for the prompts that list the words of a reply.
export function wordList(words: readonly string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
}

export function isEffort(value: unknown): value is Effort {
  return EFFORTS.includes(value as Effort)
}

// The words of /loadout after the name, each as the command description shows
// it. Each has a case in the command.run hook of register.
export const COMMANDS = {
  list: 'list',
  pick: 'pick',
  keep: 'keep <name>',
  unkeep: 'unkeep <name>',
  off: 'off',
  on: 'on',
  effort: 'effort on|off',
  model: 'model on|off',
} as const
export type CommandWord = keyof typeof COMMANDS

export function isCommandWord(word: string): word is CommandWord {
  return Object.hasOwn(COMMANDS, word)
}

const wordOf = (words: readonly string[]) => new RegExp(`(?<![a-z])(${words.join('|')})(?![a-z])`, 'gi')
const EFFORT_WORD = wordOf(EFFORTS)
const MODEL_WORD = wordOf(MODELS)

// The one word that a reply names, or null when it names none or several.
function oneWord<T extends string>(reply: string, pattern: RegExp): T | null {
  const named = new Set([...reply.matchAll(pattern)].map(match => match[1]?.toLowerCase() as T))
  return named.size === 1 ? ([...named][0] ?? null) : null
}

export function parseEffort(reply: string): Effort | null {
  return oneWord(reply, EFFORT_WORD)
}

export function parseModel(reply: string): ModelTier | null {
  return oneWord(reply, MODEL_WORD)
}

// The model to send instead of the session's: the pick, when it is a smaller
// model of the same family. Null keeps the session's model: a pick at or above
// it, or a session model out of the family (also one with a larger context,
// such as `[1m]`, that the smaller model may not have).
export function routeModel(picked: ModelTier, session: string): string | null {
  const ceiling = MODELS.findIndex(tier => MODEL_ID[tier] === session)
  return MODELS.indexOf(picked) < ceiling ? MODEL_ID[picked] : null
}

// The lower of two levels: the plugin may lower the session's effort, never
// raise it. Null when the session's effort is not a level (a number).
export function capEffort(picked: Effort, session: Effort | number): Effort | null {
  if (!isEffort(session)) return null
  return EFFORTS[Math.min(EFFORTS.indexOf(picked), EFFORTS.indexOf(session))] ?? null
}

// The models that take the effort in a message (per-turn control), so a change
// keeps the prompt cache. On other models a change rebuilds the whole cache.
export function takesTurnEffort(model: string): boolean {
  return /^claude-(sonnet-5-5|opus-5-5|opus-5|fable-5-1|mythos-5-1|haiku-5-5)(?![-.\d])/.test(model)
}

export function rebuild(
  listing: Listing,
  kept: readonly string[],
  kind: Kind,
): { text: string; hidden: string[] } {
  const keep = new Set([...kept, ...ALWAYS_SHOWN[kind]])
  const shown = listing.entries.filter(entry => keep.has(entry.group))
  const dropped = listing.entries.filter(entry => !keep.has(entry.group))
  const lines = [...listing.head, ...shown.flatMap(entry => entry.lines)]
  if (dropped.length > 0) lines.push(NOTE[kind](dropped))
  lines.push(...listing.tail)
  return { text: lines.join('\n'), hidden: dropped.map(entry => entry.name) }
}

const NOTE: Record<Kind, (dropped: Entry[]) => string> = {
  skills: dropped =>
    `(loadout hid ${dropped.length} more skills that look unrelated to this task. They still work: find one with SearchSkills or ListSkills, or call Skill with its name.)`,
  tools: dropped => {
    const counts = new Map<string, number>()
    for (const entry of dropped) counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1)
    const groups = [...counts].map(([group, n]) => `${group} (${n})`).join(', ')
    return `(loadout hid ${dropped.length} more deferred tools that look unrelated to this task, from: ${groups}. They still work: ToolSearch finds them by keyword.)`
  },
}

// Drops the "## <server>" blocks of the MCP instructions for the hidden
// servers. A server it does not know stays.
export function trimMcpInstructions(text: string, hiddenGroups: ReadonlySet<string>): string {
  // The system prompt section has this header. An attachment has the blocks
  // alone.
  const start = Math.max(0, text.indexOf('# MCP Server Instructions'))
  if (hiddenGroups.size === 0) return text
  const before = text.slice(0, start)
  const blocks = text.slice(start).split(/\n(?=## )/)
  const kept = blocks.filter(block => {
    const match = /^## (.+)$/m.exec(block)
    return !(block.startsWith('## ') && match?.[1] && hiddenGroups.has(normalize(match[1])))
  })
  return before + kept.join('\n')
}

// The "## <server>" headers of `before` that `after` lacks.
export function removedServers(before: string, after: string): string[] {
  const headers = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map(match => match[1] ?? '')
  const kept = new Set(headers(after))
  return headers(before).filter(header => !kept.has(header))
}

// The options when the settings leave one out or give it with another type.
// The same as the defaults of .claude-plugin/plugin.json: a test checks it.
export const OPTION_DEFAULTS: Readonly<Options> = {
  alwaysKeep: '',
  newTaskNote: true,
  effortPerPrompt: false,
  modelForSession: false,
  traceFile: '',
}

// The options of the plugin, each with the type of its default.
export function readOptions(raw: Readonly<Record<string, unknown>>): Options {
  const options: Record<string, unknown> = { ...OPTION_DEFAULTS }
  for (const [key, fallback] of Object.entries(OPTION_DEFAULTS)) {
    if (typeof raw[key] === typeof fallback) options[key] = raw[key]
  }
  return options as Options
}

// How much of a prompt of the person the plugin keeps and sends to the classifier.
export const PROMPT_CHARS = 4000
