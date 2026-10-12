import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolInfo } from 'claude-code'

import type { Choice, Offer, ServerFact, SkillFact } from '../types'
import {
  flipKeep,
  groupsOf,
  isAlwaysKept,
  mcpTools,
  normalize,
  parseKeep,
  parseKept,
  parseSkills,
  parseTools,
  rebuild,
  skillCatalog,
  toolCatalog,
  toolGroup,
  removedServers,
  serverDetail,
  serverFacts,
  skillDetail,
  listedSkillFacts,
  trimMcpInstructions,
  unseenGroups,
} from './scope'
import type { Listing } from './scope'


const prompt = atom({ plugin: 'loadout', key: 'prompt' } as const, null)
const tools = atom({ plugin: 'loadout', key: 'tools' } as const, null)
const skills = atom({ plugin: 'loadout', key: 'skills' } as const, null)
const isOff = atom({ plugin: 'loadout', key: 'isOff' } as const, false)
const offers = atom({ plugin: 'loadout', key: 'offers' } as const, [])
const surfaced = atom({ plugin: 'loadout', key: 'surfaced' } as const, [])
const pinned = atom({ plugin: 'loadout', key: 'pinned' } as const, [])
const marks = atom({ plugin: 'loadout', key: 'marks' } as const, null)
const skillNames = atom({ plugin: 'loadout', key: 'skillNames' } as const, [])
const filter = atom({ plugin: 'loadout', key: 'filter' } as const, '')
const facts = atom({ plugin: 'loadout', key: 'facts' } as const, null)

const PANE = 'loadout-keep'
// The $.store key of the always-keep marks.
const MARKS = 'alwaysKeep'

type Kind = 'tools' | 'skills'

const SYSTEM = [
  'You choose which tool groups or skills an AI coding agent may need for one task.',
  'Reply with the ids to keep, one per line, and nothing else.',
  'Keep generously: keep anything that could plausibly help with the task or its follow-ups.',
  'A dropped one can still be found later, but that costs the agent a search.',
].join('\n')

const RECALL = [
  'An AI coding agent works on a task. Some tool groups and skills were hidden from it.',
  'Given its newest prompt, pick the hidden ones it clearly needs for that prompt.',
  'Reply with their ids, one per line, or the word none. Pick few: only clear needs.',
].join('\n')

// Decisions run one at a time, so two listings raised together (main and a
// subagent) do not classify the same groups twice. A listing with no new group
// gets the stored decision at once, with no wait behind a classifier call.
let queue: Promise<unknown> = Promise.resolve()

async function choose($: EngineInterface, kind: Kind, listing: Listing): Promise<Choice> {
  const before = await readChoice($, kind)
  if (before !== null && unseenGroups(listing, kind, before).length === 0) return before
  const run = queue.then(() => decide($, kind, listing))
  queue = run.catch(() => undefined)
  return run
}

// The servers with a tool that a plugin keeps in the prompt's own list while
// tool search is on. Their instructions always stay: Claude sees their tools.
const front = new Set<string>()

// One JSON line per decision when the traceFile option names a file. The
// smoke test reads it: the transcript keeps a listing as the engine made it,
// not as this plugin answered it. Writes run one at a time, so no line is lost.
let traceQueue: Promise<unknown> = Promise.resolve()

function trace($: EngineInterface, file: string, line: Record<string, unknown>): void {
  if (file === '') return
  traceQueue = traceQueue
    .then(async () => {
      const before = await $.fs.read(file).catch(() => '')
      await $.fs.write(file, `${before}${JSON.stringify(line)}\n`)
    })
    .catch(() => undefined)
}

export const register: Register = (on, options) => {
  const file = typeof options.traceFile === 'string' ? options.traceFile : ''
  const alwaysKeep = typeof options.alwaysKeep === 'string' ? parseKeep(options.alwaysKeep) : []

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'loadout',
      description: 'Show the loadout of this session. Also: list, pick, keep <name>, unkeep <name>, off, on',
    })
    return next(e)
  })

  // The first prompt sets the loadout. A later prompt never changes the lists,
  // which would spend the prompt cache: it gets a note naming the hidden
  // items it needs, attached to that prompt alone.
  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    if (text === '') return next(e)
    if ((await read($, prompt)) === null) {
      // The session keeps the names of this moment: a server that connects
      // later gets the same names, and a change applies from the next session.
      const names = await keepNow($, alwaysKeep)
      await update($, pinned, () => names)
      await update($, prompt, () => text.slice(0, 4000))
      return next(e)
    }
    if ((await read($, isOff)) || !isPerson(e.origin.kind)) return next(e)
    const picked = await recall($, text)
    trace($, file, { event: 'recall', named: picked.map(offer => offer.group) })
    if (picked.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...recallNotes(picked)] })
  }).catch(($, e, next) => next(e))

  on('prompt.attachment', { type: 'deferred_tools_delta' }, async ($, e, next) => {
    const base = await next(e)
    if (base.text === null || (await scopedTools($)) === null) {
      trace($, file, { event: 'listing', type: e.type, isScoped: false })
      return base
    }
    const listing = parseTools(base.text)
    const choice = await choose($, 'tools', listing)
    $.ui.invalidate('prompt.section')
    const out = rebuild(listing, choice.kept, 'tools')
    trace($, file, { event: 'listing', type: e.type, isScoped: true, kept: choice.kept, alwaysKept: choice.always, hidden: out.hidden })
    return { text: out.text }
  })

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const base = await next(e)
    if (base.text === null) return base
    const listing = parseSkills(base.text)
    if (await isSkipped($)) {
      await update($, skillNames, names => [...new Set([...names, ...groupsOf(listing, 'skills')])])
      trace($, file, { event: 'listing', type: e.type, isScoped: false })
      return base
    }
    const choice = await choose($, 'skills', listing)
    const out = rebuild(listing, choice.kept, 'skills')
    trace($, file, { event: 'listing', type: e.type, isScoped: true, kept: choice.kept, alwaysKept: choice.always, hidden: out.hidden })
    return { text: out.text }
  })

  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    const isDeferred = described.isDeferred ?? e.isDeferred === true
    if (e.tool.startsWith('mcp__') && !isDeferred) front.add(toolGroup(e.tool))
    return described
  })

  // The MCP server instructions, in the system prompt or as an attachment.
  on('prompt.section', async ($, e, next) => {
    const base = await next(e)
    if (base.text === null || !base.text.includes('# MCP Server Instructions')) return base
    const text = await trimmed($, base.text)
    trace($, file, { event: 'mcp_instructions', where: e.name, removed: removedServers(base.text, text) })
    return { text }
  })

  on('prompt.attachment', { type: /mcp_instructions/ }, async ($, e, next) => {
    const base = await next(e)
    if (base.text === null) return base
    const text = await trimmed($, base.text)
    trace($, file, { event: 'mcp_instructions', where: e.type, removed: removedServers(base.text, text) })
    return { text }
  })

  on('command.run', { command: 'loadout' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    if (word === 'off' || word === 'on') {
      await update($, isOff, () => word === 'off')
      $.ui.invalidate('prompt.attachment')
      $.ui.invalidate('prompt.section')
      return { text: `loadout is ${word} for this session. The next request uses it.` }
    }
    if (word === 'keep' || word === 'unkeep') {
      const [name] = rest
      if (name === undefined || rest.length > 1 || name.includes(',')) {
        return { text: `Type "/loadout ${word} <name>" with one skill, plugin or server name.` }
      }
      // The kind of a typed name is not known: a skill or a server.
      return { text: await setMark($, alwaysKeep, name, ['skills', 'tools'], word === 'keep') }
    }
    if (word === 'list') return { text: listText(await items($, null), await keepNow($, alwaysKeep)) }
    if (word === 'pick') {
      const held = await readMarks($)
      await Promise.all([update($, marks, () => held), update($, filter, () => '')])
      const { isPlaced } = await $.ui.open({ id: PANE, title: 'loadout: always keep', focus: true, closeOnEscape: true })
      return { text: isPlaced ? 'Opened the always-keep picker.' : 'No surface shows the picker here. Use "/loadout list" and "/loadout keep <name>".' }
    }
    return { text: await summary($) }
  })

  // Each opening of the picker reads the facts once, so a draw on each key of
  // the filter reads nothing.
  on('ui.open', { id: PANE }, async ($, e, next) => {
    const known = await readFacts($)
    await update($, facts, () => known)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The always-keep picker: a section for the tool servers and one for the
  // skills, one row each. A press flips the mark and saves it at once.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const [names, query, held] = await Promise.all([keepNow($, alwaysKeep), read($, filter), read($, facts)])
    // A draw may not write state: without facts from ui.open, each draw reads them.
    const all = await items($, held ?? (await readFacts($)))
    const needle = query.trim().toLowerCase()
    const shown = all.filter(item => `${item.group} ${item.label}`.toLowerCase().includes(needle))
    const isOn = (item: Item) => isAlwaysKept(item.group, item.kind, names)
    const width = Math.min(34, Math.max(12, ...shown.map(item => item.label.length))) + 4
    const setFilter = (value: string) => void update($, filter, () => value)
    // Only a server has a label other than its name.
    const labels = new Map(all.filter(item => item.kind === 'tools').map(item => [item.group, item.label]))

    const row = (item: Item) => {
      const marked = isOn(item)
      const flip = () => void setMark($, alwaysKeep, item.group, [item.kind], !marked).then(text => $.ui.toast(text))
      return (
        <Box key={`row:${item.kind}:${item.group}`} flexDirection="row">
          <Box width={width} flexShrink={0}>
            <Button key={`${item.kind}:${item.group}`} plain onPress={flip}>
              <Text color={marked ? 'success' : 'inactive'}>{marked ? '● ' : '○ '}</Text>
              {item.label.length > width - 2 ? `${item.label.slice(0, width - 3)}…` : item.label}
            </Button>
          </Box>
          <Box width={8} flexShrink={0}>
            <Text color={item.status === 'kept' ? 'success' : 'warning'}>{item.status}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{item.detail}</Text>
        </Box>
      )
    }
    const section = (kind: Kind) => {
      const rows = shown.filter(item => item.kind === kind)
      const total = all.filter(item => item.kind === kind).length
      const empty = needle === '' ? 'None seen yet. The list fills after the first prompt.' : 'No match.'
      return (
        <Box key={`section:${kind}`} flexDirection="column" marginTop={1}>
          <Text bold>
            {SECTION[kind]} <Text dimColor>{rows.length === total ? `${total}` : `${rows.length} of ${total}`}</Text>
          </Text>
          {rows.length === 0 ? <Text dimColor>{`  ${empty}`}</Text> : rows.map(row)}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>loadout never hides a marked item. A change applies from the next session.</Text>
        <Text wrap="truncate-end">{keepLine(names.map(name => labels.get(normalize(name)) ?? name))}</Text>
        {'Input' in ui && (
          <Box marginTop={1}>
            <ui.Input key="filter" label="Filter" placeholder="server or skill name" value={query} autoFocus onInput={setFilter} onSubmit={setFilter} />
          </Box>
        )}
        {e.surface === 'terminal' && <Text dimColor>Tab moves · Enter marks · Esc closes</Text>}
        {section('tools')}
        {section('skills')}
      </Box>
    )
  })
}

const SECTION: Record<Kind, string> = { tools: 'Tool servers', skills: 'Skills' }

// One tool group or skill of the session, with its state in this session's
// loadout: `kept`, `hidden`, or empty before the first decision. `label` is
// the name a person knows; `detail` its size and what it is.
type Item = { kind: Kind; group: string; status: '' | 'kept' | 'hidden'; label: string; detail: string }

type Facts = { servers: ServerFact[]; skills: SkillFact[] }

// What the engine knows about each tool server and skill: the tools, the /mcp
// name, the tokens and the descriptions.
async function readFacts($: EngineInterface): Promise<Facts> {
  const [listed, usage, commands] = await Promise.all([
    $.tool.list().catch(() => []),
    $.session.usage({ breakdown: 'summary' }).catch(() => null),
    $.command.list().catch(() => []),
  ])
  const breakdown = usage?.context.breakdown
  const about = new Map(commands.map(command => [command.name, command.description]))
  return {
    servers: serverFacts(listed, breakdown?.mcpTools ?? []),
    skills: (breakdown?.skills?.skillFrontmatter ?? []).map(skill => {
      // The breakdown can leave out the plugin of a plugin skill.
      const name = skill.name.includes(':') || !skill.pluginName ? skill.name : `${skill.pluginName}:${skill.name}`
      return { name, tokens: skill.tokens, about: about.get(name) ?? about.get(skill.name) ?? '' }
    }),
  }
}

const byName = new Intl.Collator(undefined, { sensitivity: 'base' })

// Every tool server and skill the session has seen: from the decisions, the
// skill listings that the plugin did not scope, and the facts when the pane
// has them. Without facts, the MCP tools give the servers.
async function items($: EngineInterface, known: Facts | null): Promise<Item[]> {
  const [t, s, names] = await Promise.all([readChoice($, 'tools'), readChoice($, 'skills'), read($, skillNames)])
  const servers = new Map((known?.servers ?? []).map(fact => [fact.group, fact]))
  const listed = [...names, ...(s?.kept ?? []), ...(s?.hidden ?? [])]
  const skillFacts = new Map(listedSkillFacts(known?.skills ?? [], listed).map(fact => [fact.name, fact]))
  if (known === null && t === null) {
    const listed = await $.tool.list().catch(() => [])
    for (const group of groupsOf(mcpTools(listed), 'tools')) servers.set(group, { group, label: group, tools: [], tokens: 0 })
  }
  const status = (choice: Choice | null, group: string): Item['status'] =>
    choice?.kept.includes(group) ? 'kept' : choice?.hidden.includes(group) ? 'hidden' : ''
  const groups = (choice: Choice | null, seen: Iterable<string>) => [
    ...new Set([...seen, ...(choice?.kept ?? []), ...(choice?.hidden ?? [])]),
  ]
  const tools = groups(t, servers.keys()).map((group): Item => {
    const fact = servers.get(group)
    const detail = fact === undefined || fact.tools.length === 0 ? '' : serverDetail(fact)
    return { kind: 'tools', group, status: status(t, group), label: fact?.label ?? group, detail }
  })
  const skillItems = groups(s, [...names, ...skillFacts.keys()]).map((group): Item => {
    const fact = skillFacts.get(group)
    const detail = fact === undefined ? '' : skillDetail(fact.tokens, fact.about)
    return { kind: 'skills', group, status: status(s, group), label: group, detail }
  })
  const sorted = (list: Item[]) => list.sort((a, b) => byName.compare(a.label, b.label))
  return [...sorted(tools), ...sorted(skillItems)]
}

// The always-keep list for the next session: the option and the marks.
async function keepNow($: EngineInterface, option: string[]): Promise<string[]> {
  return [...new Set([...option, ...(await readMarks($))])]
}

// The names that /loadout keep and the pane saved. They live in the plugin's
// store, so they last across sessions. The `marks` atom holds a copy, so a
// write draws the pane again.
async function readMarks($: EngineInterface): Promise<string[]> {
  return (await read($, marks)) ?? (await storedMarks($)) ?? []
}

// The marks in $.store, or null when the store cannot be read.
async function storedMarks($: EngineInterface): Promise<string[] | null> {
  const stored = await $.store.get(MARKS).catch(() => null)
  if (stored === null) return null
  return Array.isArray(stored) ? stored.filter((name): name is string => typeof name === 'string') : []
}

function keepLine(names: readonly string[]): string {
  return `Always keep: ${names.join(', ') || 'none'}`
}

function listText(all: Item[], names: string[]): string {
  const row = (item: Item) =>
    `${isAlwaysKept(item.group, item.kind, names) ? '[x]' : '[ ]'} ${item.group}${item.status === '' ? '' : `  (${item.status})`}`
  const part = (kind: Kind, title: string) => {
    const rows = all.filter(item => item.kind === kind).map(row)
    return [`${title}:`, ...(rows.length === 0 ? ['none seen yet'] : rows)]
  }
  return [
    keepLine(names),
    '[x] marks an item that the plugin never hides. (kept) and (hidden) give its state in this session.',
    ...part('tools', 'Tool groups'),
    ...part('skills', 'Skills'),
    'Change a mark with "/loadout keep <name>" or "/loadout unkeep <name>", or with the picker: "/loadout pick".',
  ].join('\n')
}

// Sets or clears the mark of a name and saves the marks. A name that the
// option covers stays: the plugin does not write the settings.
async function setMark($: EngineInterface, option: string[], name: string, kinds: readonly Kind[], isOn: boolean): Promise<string> {
  const as = (kind: Kind) => (kind === 'tools' ? normalize(name) : name)
  const isCovered = (names: string[]) => kinds.some(kind => isAlwaysKept(as(kind), kind, names))
  // The store first: another session can have saved marks since this one read them.
  const before = (await storedMarks($)) ?? (await readMarks($))
  if (isOn && isCovered([...option, ...before])) return `${name} is already on the always-keep list.`
  const after = isOn ? [...before, name] : kinds.reduce((names, kind) => flipKeep(names, as(kind), kind, false), before)
  if (isCovered(option)) return `${name} stays on the always-keep list: the option alwaysKeep in your settings covers it. Remove it there.`
  if (after.length === before.length) return `${name} is not on the always-keep list.`
  await update($, marks, () => after)
  const isSaved = await $.store.set(MARKS, after).then(() => true, () => false)
  if (!isSaved) return 'loadout could not save the always-keep list. It holds for this session only.'
  const when = (await read($, prompt)) === null ? 'This session uses it from the first prompt.' : 'It applies from the next session.'
  return `${keepLine([...new Set([...option, ...after])])}. ${when}`
}

function isPerson(kind: string): boolean {
  return kind === 'composer' || kind === 'bridge' || kind === 'sdk'
}

// Matches a later prompt against what is still hidden and not yet named.
async function recall($: EngineInterface, text: string): Promise<Offer[]> {
  const named = new Set(await read($, surfaced))
  const open = (await read($, offers)).filter(offer => !named.has(offer.group))
  if (open.length === 0) return []

  const groups = open.map(offer => offer.group)
  const reply = await $.model
    .complete({
      model: 'haiku',
      system: RECALL,
      prompt: `Newest prompt:\n<prompt>\n${text.slice(0, 4000)}\n</prompt>\n\nHidden:\n${open.map(offer => offer.row).join('\n')}`,
      maxTokens: 300,
      effort: 'low',
      timeoutMs: 5000,
    })
    .catch(() => null)
  if (reply === null || !reply.isAnswered) return []
  const picked = open.filter(offer => parseKept(reply.text, groups).includes(offer.group))
  if (picked.length === 0) return []

  await update($, surfaced, list => [...list, ...picked.map(offer => offer.group)])
  $.ui.status(`loadout: pointed to ${picked.map(offer => offer.group).join(', ')}`)
  return picked
}

function recallNotes(picked: Offer[]): string[] {
  const tools = picked.filter(offer => offer.kind === 'tools').map(offer => `- ${offer.row}`)
  const skills = picked.filter(offer => offer.kind === 'skills').map(offer => `- ${offer.row}`)
  const notes: string[] = []
  if (tools.length > 0) {
    notes.push(`loadout: this prompt may need tools hidden at session start. Load them with ToolSearch ("select:<name>" or keywords):\n${tools.join('\n')}`)
  }
  if (skills.length > 0) {
    notes.push(`loadout: this prompt may need skills hidden from the skill list. Call Skill with the name:\n${skills.join('\n')}`)
  }
  return notes
}

async function isSkipped($: EngineInterface): Promise<boolean> {
  return (await read($, isOff)) || (await read($, prompt)) === null
}

// The tools of the session, or null when no tool group may be hidden: the
// session is skipped, or it has no ToolSearch. Without ToolSearch (tool search
// off, or a deny rule on it) the engine puts every MCP tool in the prompt, so
// Claude sees them all. The engine still says isDeferred for these tools, so
// ToolSearch in the tool list is the one sign.
async function scopedTools($: EngineInterface): Promise<ToolInfo[] | null> {
  if (await isSkipped($)) return null
  const listed = await $.tool.list()
  return listed.some(info => info.name === 'ToolSearch') ? listed : null
}

// Claude Code can raise the instructions before the tool listing, and a server
// that connects late can raise its instructions before its tools. So the tool
// groups are classified here from the MCP tools of the session: `decide`
// classifies only the new groups, and the tool listing reuses the decision.
async function trimmed($: EngineInterface, text: string): Promise<string> {
  const listed = await scopedTools($)
  if (listed === null) return text
  const choice = await choose($, 'tools', mcpTools(listed))
  return trimMcpInstructions(text, new Set(choice.hidden.filter(group => !front.has(group))))
}

// Classifies only the groups not seen before, so a later delta (an MCP server
// that connected late) gets a decision of its own and earlier ones stay.
async function decide($: EngineInterface, kind: Kind, listing: Listing): Promise<Choice> {
  const before: Choice = (await readChoice($, kind)) ?? { kept: [], hidden: [], always: [] }
  const unseen = unseenGroups(listing, kind, before)
  if (unseen.length === 0) return before

  // The always-kept groups skip the classifier: it cannot hide them.
  const names = await read($, pinned)
  const always = unseen.filter(group => isAlwaysKept(group, kind, names))
  const open = unseen.filter(group => !always.includes(group))
  const catalog = (kind === 'tools' ? toolCatalog(listing) : skillCatalog(listing)).filter(row =>
    open.includes(row.group),
  )
  const rows = catalog.map(row => row.row)
  const picked = open.length === 0 ? [] : await classify($, kind, (await read($, prompt)) ?? '', rows, open)
  const kept = [...always, ...picked]
  const dropped = catalog
    .filter(row => !kept.includes(row.group))
    .map(row => ({ kind, group: row.group, row: row.row }))
  // Two decisions can run at once (the instructions and the tool listing), so
  // a group can come twice. Keep one of each.
  await update($, offers, list => [...list, ...dropped.filter(offer => !list.some(one => one.group === offer.group))])
  const choice: Choice = {
    kept: [...new Set([...before.kept, ...kept])],
    hidden: [...new Set([...before.hidden, ...unseen.filter(group => !kept.includes(group))])],
    always: [...new Set([...before.always, ...always])],
  }
  await writeChoice($, kind, choice)
  const [t, s] = [await read($, tools), await read($, skills)]
  $.ui.status(`loadout: hid ${t?.hidden.length ?? 0} tool groups, ${s?.hidden.length ?? 0} skills`)
  return choice
}

// The scan needs each atom spelled at its call, hence the two branches.
async function readChoice($: EngineInterface, kind: Kind): Promise<Choice | null> {
  return kind === 'tools' ? read($, tools) : read($, skills)
}

async function writeChoice($: EngineInterface, kind: Kind, choice: Choice): Promise<void> {
  if (kind === 'tools') await update($, tools, () => choice)
  else await update($, skills, () => choice)
}

// On any failure everything is kept: a wrong cut costs more than no cut.
async function classify(
  $: EngineInterface,
  kind: Kind,
  task: string,
  rows: string[],
  groups: string[],
): Promise<string[]> {
  const what = kind === 'tools' ? 'tool groups (id, then sample tools)' : 'skills (id: description)'
  const reply = await $.model
    .complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: `Task:\n<task>\n${task}\n</task>\n\nAvailable ${what}:\n${rows.join('\n')}`,
      maxTokens: 800,
      effort: 'low',
      timeoutMs: 10000,
    })
    .catch(() => null)
  if (reply === null || !reply.isAnswered) return groups
  return parseKept(reply.text, groups)
}

async function summary($: EngineInterface): Promise<string> {
  if (await read($, isOff)) return 'loadout is off for this session.'
  const [t, s] = [await read($, tools), await read($, skills)]
  if (t === null && s === null) return 'loadout has not picked a loadout for this session yet. Send a prompt first.'
  // No tool decision: the session has no ToolSearch or no MCP tools.
  const toolLines = t === null
    ? ['Tool groups hidden: none']
    : [`Tool groups kept: ${t.kept.join(', ') || 'none'}`, `Tool groups hidden: ${t.hidden.join(', ') || 'none'}`]
  return [
    `Always kept: ${[...(t?.always ?? []), ...(s?.always ?? [])].join(', ') || 'none'}`,
    ...toolLines,
    `Skills kept: ${s?.kept.join(', ') || 'none'}`,
    `Skills hidden: ${s?.hidden.length ?? 0}`,
    `Named to later prompts: ${(await read($, surfaced)).join(', ') || 'none'}`,
  ].join('\n')
}
