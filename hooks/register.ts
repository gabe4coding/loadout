import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Choice, Offer } from '../types'
import {
  groupsOf,
  parseKept,
  parseSkills,
  parseTools,
  rebuild,
  skillCatalog,
  toolCatalog,
  trimMcpInstructions,
} from './scope'
import type { Listing } from './scope'


const prompt = atom({ plugin: 'context-scope', key: 'prompt' } as const, null)
const tools = atom({ plugin: 'context-scope', key: 'tools' } as const, null)
const skills = atom({ plugin: 'context-scope', key: 'skills' } as const, null)
const isOff = atom({ plugin: 'context-scope', key: 'isOff' } as const, false)
const offers = atom({ plugin: 'context-scope', key: 'offers' } as const, [])
const surfaced = atom({ plugin: 'context-scope', key: 'surfaced' } as const, [])

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
// subagent) do not classify the same groups twice.
let queue: Promise<unknown> = Promise.resolve()

function choose($: EngineInterface, kind: Kind, listing: Listing): Promise<Choice> {
  const run = queue.then(() => decide($, kind, listing))
  queue = run.catch(() => undefined)
  return run
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'scope',
      description: 'Show what context-scope hid; "/scope off" or "/scope on" to switch it',
    })
    return next(e)
  })

  // The first prompt sets the scope. A later prompt never changes the lists,
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
    const notes = await recall($, text)
    return notes.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...notes] })
  }).catch(($, e, next) => next(e))

  on('prompt.attachment', { type: 'deferred_tools_delta' }, async ($, e, next) => {
    const base = await next(e)
    if (base.text === null || (await isSkipped($))) return base
    const listing = parseTools(base.text)
    const choice = await choose($, 'tools', listing)
    $.ui.invalidate('prompt.section')
    return { text: rebuild(listing, choice.kept, 'tools').text }
  })

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const base = await next(e)
    if (base.text === null || (await isSkipped($))) return base
    const listing = parseSkills(base.text)
    const choice = await choose($, 'skills', listing)
    return { text: rebuild(listing, choice.kept, 'skills').text }
  })

  // The MCP server instructions, in the system prompt or as an attachment.
  on('prompt.section', async ($, e, next) => {
    const base = await next(e)
    if (base.text === null || !base.text.includes('# MCP Server Instructions')) return base
    return { text: await trimmed($, base.text) }
  })

  on('prompt.attachment', { type: /mcp_instructions/ }, async ($, e, next) => {
    const base = await next(e)
    if (base.text === null) return base
    return { text: await trimmed($, base.text) }
  })

  on('command.run', { command: 'scope' }, async ($, e) => {
    const word = e.args.trim()
    if (word === 'off' || word === 'on') {
      await update($, isOff, () => word === 'off')
      $.ui.invalidate('prompt.attachment')
      $.ui.invalidate('prompt.section')
      return { text: `context-scope is ${word} for this session. The next request uses it.` }
    }
    return { text: await summary($) }
  })
}

function isPerson(kind: string): boolean {
  return kind === 'composer' || kind === 'bridge' || kind === 'sdk'
}

// Matches a later prompt against what is still hidden and not yet named.
async function recall($: EngineInterface, text: string): Promise<string[]> {
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
  $.ui.status(`scope: pointed to ${picked.map(offer => offer.group).join(', ')}`)
  return recallNotes(picked)
}

function recallNotes(picked: Offer[]): string[] {
  const tools = picked.filter(offer => offer.kind === 'tools').map(offer => `- ${offer.row}`)
  const skills = picked.filter(offer => offer.kind === 'skills').map(offer => `- ${offer.row}`)
  const notes: string[] = []
  if (tools.length > 0) {
    notes.push(`context-scope: this prompt may need tools hidden at session start. Load them with ToolSearch ("select:<name>" or keywords):\n${tools.join('\n')}`)
  }
  if (skills.length > 0) {
    notes.push(`context-scope: this prompt may need skills hidden from the skill list. Call Skill with the name:\n${skills.join('\n')}`)
  }
  return notes
}

async function isSkipped($: EngineInterface): Promise<boolean> {
  return (await read($, isOff)) || (await read($, prompt)) === null
}

async function trimmed($: EngineInterface, text: string): Promise<string> {
  const choice = await read($, tools)
  if ((await read($, isOff)) || choice === null) return text
  return trimMcpInstructions(text, new Set(choice.hidden))
}

// Classifies only the groups not seen before, so a later delta (an MCP server
// that connected late) gets a decision of its own and earlier ones stay.
async function decide($: EngineInterface, kind: Kind, listing: Listing): Promise<Choice> {
  const before: Choice = (await readChoice($, kind)) ?? { kept: [], hidden: [] }
  const seen = new Set([...before.kept, ...before.hidden])
  const unseen = groupsOf(listing, kind).filter(group => !seen.has(group))
  if (unseen.length === 0) return before

  const catalog = (kind === 'tools' ? toolCatalog(listing) : skillCatalog(listing)).filter(row =>
    unseen.includes(row.group),
  )
  const rows = catalog.map(row => row.row)
  const kept = await classify($, kind, (await read($, prompt)) ?? '', rows, unseen)
  const dropped = catalog
    .filter(row => !kept.includes(row.group))
    .map(row => ({ kind, group: row.group, row: row.row }))
  await update($, offers, list => [...list, ...dropped])
  const choice: Choice = {
    kept: [...before.kept, ...kept],
    hidden: [...before.hidden, ...unseen.filter(group => !kept.includes(group))],
  }
  await writeChoice($, kind, choice)
  const [t, s] = [await read($, tools), await read($, skills)]
  $.ui.status(`scope: hid ${t?.hidden.length ?? 0} tool groups, ${s?.hidden.length ?? 0} skills`)
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
  if (await read($, isOff)) return 'context-scope is off for this session.'
  const [t, s] = [await read($, tools), await read($, skills)]
  if (t === null && s === null) return 'context-scope has not scoped this session yet.'
  return [
    `Tool groups kept: ${t?.kept.join(', ') || 'none'}`,
    `Tool groups hidden: ${t?.hidden.join(', ') || 'none'}`,
    `Skills kept: ${s?.kept.join(', ') || 'none'}`,
    `Skills hidden: ${s?.hidden.length ?? 0}`,
    `Named to later prompts: ${(await read($, surfaced)).join(', ') || 'none'}`,
  ].join('\n')
}
