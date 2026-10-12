import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolInfo, TurnStepResult } from 'claude-code'

import type { Choice, Effort, Offer, Route, ServerFact, SkillFact } from '../types'
import {
  flipKeep,
  capEffort,
  isNewTask,
  parseEffort,
  parseModel,
  routeModel,
  takesTurnEffort,
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
const recent = atom({ plugin: 'loadout', key: 'recent' } as const, [])
const effort = atom({ plugin: 'loadout', key: 'effort' } as const, { level: null, isFrozen: false })
const route = atom({ plugin: 'loadout', key: 'route' } as const, null)
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

// Added to RECALL when there are earlier prompts to compare with. The verdict
// comes first, so a reply that reasons after it cannot flip it.
const TASK_CHECK = [
  'Start the reply with one line: SAME TASK or NEW TASK.',
  'SAME TASK: the newest prompt continues, fixes or extends the earlier prompts.',
  'NEW TASK: it has its own goal, unrelated to them. If unsure, SAME TASK.',
].join('\n')

// What a person reads when a later prompt starts a new task.
const NEW_TASK = 'loadout: this prompt starts a new task. A new session or /clear gives it its own loadout and a smaller context.'

const EFFORT = [
  'You choose the reasoning effort an AI coding agent needs for its newest prompt.',
  'Reply with one word: low, medium, high, xhigh or max.',
  'low: a short answer, a lookup or a one-line change.',
  'medium: a normal coding task in a few files.',
  'high: a change across many files, or debugging.',
  'xhigh: a hard bug, a design decision or a long task with many steps.',
  'max: only when correctness matters far more than cost.',
  'If unsure, reply medium.',
].join('\n')

const MODEL = [
  'You choose the model an AI coding agent needs for a new session, from its first prompt.',
  'Reply with one word: haiku, sonnet, opus or fable.',
  'haiku: a short answer, a lookup or a small change in one file.',
  'sonnet: a normal coding task: a feature, a fix or a review in a few files.',
  'opus: a hard task: a large change across many files, a hard bug or a design decision.',
  'fable: only for the hardest tasks, where correctness matters far more than cost.',
  'If unsure, reply sonnet.',
].join('\n')

// A request that keeps less than this part of the cache of the request before
// it lost the cache.
const CACHE_KEPT = 0.5

// The shortest life of the prompt cache. After a longer pause the cache can be
// gone for any reason, so a small cache read then proves nothing.
const CACHE_LIFE_MS = 5 * 60 * 1000

// How many prompts of the person the new-task check compares with, and how
// much of each.
const RECENT = 3
const RECENT_CHARS = 1000

// Decisions run one at a time, so two listings raised together (main and a
// subagent) do not classify the same groups twice. A listing with no new group
// gets the stored decision at once, with no wait behind a classifier call.
let queue: Promise<unknown> = Promise.resolve()

// The effort pick for the newest prompt of the person, until the first main
// request of its turn takes it.
let picking: Promise<Effort | null> | null = null

// The last main request: its effort, model, cached input (read plus written)
// and time, for the cache check after a change of effort.
let last: { sent: string; model: string; cached: number; at: number } | null = null

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
  const checksTask = options.newTaskNote !== false
  const setsEffort = options.effortPerPrompt === true
  const setsModel = options.modelForSession === true

  on('session.start', async ($, e, next) => {
    // A new session (also after /clear) starts with no effort history.
    picking = null
    last = null
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
    const isFirst = (await read($, prompt)) === null
    if (isFirst) {
      // The session keeps the names of this moment: a server that connects
      // later gets the same names, and a change applies from the next session.
      const names = await keepNow($, alwaysKeep)
      await update($, pinned, () => names)
      await update($, prompt, () => text.slice(0, 4000))
    }
    if (!isPerson(e.origin.kind)) return next(e)
    // The window keeps the prompts sent while the loadout is off too.
    const window = checksTask || setsEffort ? await remember($, text) : []
    if (await read($, isOff)) return next(e)
    if (setsEffort && !(await read($, effort)).isFrozen) picking = pickEffort($, file, text, window)
    if (isFirst) {
      // The person answers before the first request, which then goes to the model they chose.
      if (setsModel) await chooseModel($, file, text).catch(() => undefined)
      return next(e)
    }
    const earlier = checksTask ? window : []
    const named = new Set(await read($, surfaced))
    const open = (await read($, offers)).filter(offer => !named.has(offer.group))
    if (open.length === 0) {
      // Nothing is left to name, so only a toast can come: the prompt does not wait for it.
      if (earlier.length > 0) void recall($, file, text, earlier, open).catch(() => undefined)
      return next(e)
    }
    const picked = await recall($, file, text, earlier, open)
    if (picked.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...recallNotes(picked)] })
  }).catch(($, e, next) => next(e))

  // The main requests of the session go to the model picked for the first
  // prompt. Those of a turn get the effort picked for its prompt, at most the
  // session's own effort, and only on a model that takes the effort in a
  // message: there a change keeps the cache.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || (!setsModel && !setsEffort)) return yield* next(e)
    const model = setsModel ? await modelFor($, e.model).catch(() => null) : null
    const base = model === null ? e : { ...e, model }
    if (!setsEffort || e.effort === undefined || !takesTurnEffort(base.model)) return yield* next(base)
    const level = await effortFor($).catch(() => null)
    const sent = (level === null ? null : capEffort(level, e.effort)) ?? e.effort
    const result = yield* next(sent === e.effort ? base : { ...base, effort: sent })
    await watchCache($, file, String(sent), result).catch(() => undefined)
    return result
  })

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

  // A model the person sets with /model stays for the rest of the session.
  // The security module skips classic.PostModelSwitch for a user plugin, so
  // the plugin watches the command, and modelFor each request.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e)
    const now = await read($, route)
    if (now !== null && (await $.session.model()) !== now.from) await endRoute($)
    return result
  }).catch(($, e, next) => next(e))

  // The status line and /model still show the session's model: the footer
  // names the model that answers.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const now = await read($, route)
    if (now === null) return next(e)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, `${now.to.replace(/^claude-/, '')} (loadout)`] } })
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

// Adds a prompt of the person to the recent ones. Returns the ones before it.
async function remember($: EngineInterface, text: string): Promise<string[]> {
  let earlier: string[] = []
  await update($, recent, list => {
    earlier = list
    return [...list, text.slice(0, RECENT_CHARS)].slice(-RECENT)
  })
  return earlier
}

// Asks the classifier for one word of `parse` about a prompt of the person.
// Null on any failure.
async function pickWord<T>(
  $: EngineInterface,
  system: string,
  text: string,
  earlier: string[],
  parse: (reply: string) => T | null,
): Promise<T | null> {
  const reply = await $.model
    .complete({ model: 'haiku', system, prompt: promptBlock(text, earlier), maxTokens: 20, effort: 'low', timeoutMs: 5000 })
    .catch(() => null)
  return reply?.isAnswered ? parse(reply.text) : null
}

// Asks the classifier for the model of the session, from its first prompt. A
// smaller model goes to the person, who must approve it. On any failure, or a
// dismissed question, the session keeps its model.
async function chooseModel($: EngineInterface, file: string, text: string): Promise<void> {
  const [picked, session] = await Promise.all([pickWord($, MODEL, text, [], parseModel), $.session.model()])
  const to = picked === null ? null : routeModel(picked, session)
  trace($, file, { event: 'model_pick', picked, session, to })
  if (to === null) return
  const use = `Use ${to}`
  const answer = await $.ui.ask(
    `loadout: ${to} looks enough for this task. Use it instead of ${session} for this session? The status line and /model still show ${session}.`,
    { header: 'Model', options: [use, `Keep ${session}`] },
  )
  const isUsed = answer === use
  trace($, file, { event: 'model_route', from: session, to, isUsed })
  if (!isUsed) return
  await update($, route, () => ({ from: session, to }))
  $.ui.invalidate('ui.render')
}

// The model for a main request: the one the person approved. A request on
// another model (a /model change, a fallback) or /loadout off ends the change
// for the rest of the session.
async function modelFor($: EngineInterface, model: string): Promise<string | null> {
  const [now, off] = await Promise.all([read($, route), read($, isOff)])
  if (now === null) return null
  if (model === now.from && !off) return now.to
  await endRoute($)
  return null
}

async function endRoute($: EngineInterface): Promise<void> {
  if ((await read($, route)) === null) return
  await update($, route, () => null)
  $.ui.invalidate('ui.render')
}

// Asks the classifier for the effort of a prompt of the person. Null on any
// failure: the request then keeps the effort it has.
async function pickEffort($: EngineInterface, file: string, text: string, earlier: string[]): Promise<Effort | null> {
  const picked = await pickWord($, EFFORT, text, earlier, parseEffort)
  trace($, file, { event: 'effort_pick', picked })
  return picked
}

// The effort for a main request: the pick of the newest prompt once it is
// there, else the one before. Null when the plugin leaves the effort alone.
async function effortFor($: EngineInterface): Promise<Effort | null> {
  const pending = picking
  picking = null
  const [state, off] = await Promise.all([read($, effort), read($, isOff)])
  if (state.isFrozen) return state.level
  if (off) return null
  const picked = pending === null ? null : await pending
  if (picked === null || picked === state.level) return state.level
  await update($, effort, now => ({ ...now, level: picked }))
  $.ui.status(`loadout: effort ${picked}`)
  return picked
}

// After a main request with a changed effort: if it lost most of the cache,
// the model did not take the effort in a message. The effort then stays.
async function watchCache($: EngineInterface, file: string, sent: string, result: TurnStepResult): Promise<void> {
  const usage = result.usage
  if (usage === null) return
  const before = last
  const at = await $.clock.now()
  last = { sent, model: usage.model, cached: usage.cache_read_input_tokens + usage.cache_creation_input_tokens, at }
  if (before === null || before.sent === sent) return
  trace($, file, { event: 'effort_change', from: before.sent, to: sent, cacheRead: usage.cache_read_input_tokens })
  // A change of model, or a pause past the life of the cache, also loses it.
  if (before.model !== usage.model || at - before.at > CACHE_LIFE_MS) return
  if (before.cached === 0 || usage.cache_read_input_tokens >= before.cached * CACHE_KEPT) return
  await update($, effort, now => ({ ...now, isFrozen: true }))
  trace($, file, { event: 'effort_frozen', level: sent, model: usage.model })
}

// The prompt of a classifier call on a prompt of the person.
function promptBlock(text: string, earlier: string[]): string {
  const before = earlier.length === 0 ? '' : `Earlier prompts:\n${earlier.map(one => `<earlier>\n${one}\n</earlier>`).join('\n')}\n\n`
  return `${before}Newest prompt:\n<prompt>\n${text.slice(0, 4000)}\n</prompt>`
}

// Matches a later prompt against the hidden items not yet named, and against
// the earlier prompts: a toast when it starts a different task. With no
// earlier prompts the task is not checked.
async function recall($: EngineInterface, file: string, text: string, earlier: string[], open: Offer[]): Promise<Offer[]> {
  const hidden = open.length === 0 ? 'none' : open.map(offer => offer.row).join('\n')
  const reply = await $.model
    .complete({
      model: 'haiku',
      system: earlier.length === 0 ? RECALL : `${RECALL}\n${TASK_CHECK}`,
      prompt: `${promptBlock(text, earlier)}\n\nHidden:\n${hidden}`,
      maxTokens: 300,
      effort: 'low',
      timeoutMs: 5000,
    })
    .catch(() => null)
  const answer = reply?.isAnswered ? reply.text : ''
  const isNew = earlier.length > 0 && isNewTask(answer)
  const kept = parseKept(answer, open.map(offer => offer.group))
  const picked = open.filter(offer => kept.includes(offer.group))
  trace($, file, { event: 'recall', named: picked.map(offer => offer.group), isNewTask: isNew })
  if (isNew) $.ui.toast(NEW_TASK, { timeoutMs: 10000 })
  if (picked.length > 0) {
    await update($, surfaced, list => [...list, ...picked.map(offer => offer.group)])
    $.ui.status(`loadout: pointed to ${picked.map(offer => offer.group).join(', ')}`)
  }
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
  if (t === null && s === null) {
    return ['loadout has not picked a loadout for this session yet. Send a prompt first.', ...modelLine(await read($, route)), ...effortLine(await read($, effort))].join('\n')
  }
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
    ...modelLine(await read($, route)),
    ...effortLine(await read($, effort)),
  ].join('\n')
}

function modelLine(state: Route | null): string[] {
  return state === null ? [] : [`Model: ${state.to} (the session's model: ${state.from})`]
}

function effortLine(state: { level: string | null; isFrozen: boolean }): string[] {
  if (state.level === null) return []
  return [`Effort: ${state.level}${state.isFrozen ? ' (fixed: a change lost the prompt cache on this model)' : ''}`]
}
