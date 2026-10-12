import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolInfo } from 'claude-code'

import type { Choice, Offer } from '../types'
import {
  parseKept,
  parseSkills,
  parseTools,
  rebuild,
  skillCatalog,
  toolCatalog,
  toolGroup,
  removedServers,
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

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'loadout',
      description: 'Show the loadout of this session; "/loadout off" or "/loadout on" to switch it',
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
    trace($, file, { event: 'listing', type: e.type, isScoped: true, kept: choice.kept, hidden: out.hidden })
    return { text: out.text }
  })

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const base = await next(e)
    if (base.text === null || (await isSkipped($))) {
      trace($, file, { event: 'listing', type: e.type, isScoped: false })
      return base
    }
    const listing = parseSkills(base.text)
    const choice = await choose($, 'skills', listing)
    const out = rebuild(listing, choice.kept, 'skills')
    trace($, file, { event: 'listing', type: e.type, isScoped: true, kept: choice.kept, hidden: out.hidden })
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
    const word = e.args.trim()
    if (word === 'off' || word === 'on') {
      await update($, isOff, () => word === 'off')
      $.ui.invalidate('prompt.attachment')
      $.ui.invalidate('prompt.section')
      return { text: `loadout is ${word} for this session. The next request uses it.` }
    }
    return { text: await summary($) }
  })
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
  const names = listed.filter(info => info.mcp).map(info => info.name)
  const choice = await choose($, 'tools', parseTools(names.join('\n')))
  return trimMcpInstructions(text, new Set(choice.hidden.filter(group => !front.has(group))))
}

// Classifies only the groups not seen before, so a later delta (an MCP server
// that connected late) gets a decision of its own and earlier ones stay.
async function decide($: EngineInterface, kind: Kind, listing: Listing): Promise<Choice> {
  const before: Choice = (await readChoice($, kind)) ?? { kept: [], hidden: [] }
  const unseen = unseenGroups(listing, kind, before)
  if (unseen.length === 0) return before

  const catalog = (kind === 'tools' ? toolCatalog(listing) : skillCatalog(listing)).filter(row =>
    unseen.includes(row.group),
  )
  const rows = catalog.map(row => row.row)
  const kept = await classify($, kind, (await read($, prompt)) ?? '', rows, unseen)
  const dropped = catalog
    .filter(row => !kept.includes(row.group))
    .map(row => ({ kind, group: row.group, row: row.row }))
  // Two decisions can run at once (the instructions and the tool listing), so
  // a group can come twice. Keep one of each.
  await update($, offers, list => [...list, ...dropped.filter(offer => !list.some(one => one.group === offer.group))])
  const choice: Choice = {
    kept: [...new Set([...before.kept, ...kept])],
    hidden: [...new Set([...before.hidden, ...unseen.filter(group => !kept.includes(group))])],
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
    ...toolLines,
    `Skills kept: ${s?.kept.join(', ') || 'none'}`,
    `Skills hidden: ${s?.hidden.length ?? 0}`,
    `Named to later prompts: ${(await read($, surfaced)).join(', ') || 'none'}`,
  ].join('\n')
}
