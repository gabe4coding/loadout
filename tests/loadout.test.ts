import type { On, SessionUsage, ToolInfo } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { parseTools } from '../hooks/scope'
import type { CommandWord } from '../hooks/scope'
import { USAGE, answer, attach, breakdown, command, failed, firstQuestion, listed, quiet, submit } from './kit'

const TOOLS = [
  'The following deferred tools are now available via ToolSearch:',
  'CronCreate',
  'WebFetch',
  'mcp__datadog__search_logs',
  'mcp__datadog__get_trace',
  'mcp__slack__send_message',
  'mcp__claude-in-chrome__navigate',
].join('\n')

const SKILLS = [
  'The following skills are available for use with the Skill tool:',
  '- local-tools:dep-scan: Use for dependency and vulnerability questions',
  '- riff:title: Generate title options for an essay',
  '  across three length categories',
  '- update-config: Use this skill to configure the Claude Code harness',
].join('\n')

const MCP = [
  'Intro.',
  '# MCP Server Instructions',
  '',
  '## datadog',
  'Datadog rules.',
  '',
  '## claude-in-chrome',
  'Chrome rules.',
].join('\n')

// The MCP instructions as an attachment: the blocks, with no header.
const BLOCKS = MCP.slice(MCP.indexOf('## datadog'))

// The MCP tools of TOOLS as $.tool.list() gives them.
const LISTED: ToolInfo[] = parseTools(TOOLS)
  .entries.map(entry => entry.name)
  .filter(name => name.startsWith('mcp__'))
  .map(name => ({ name, description: '', mcp: true }))

const SEARCH: ToolInfo = { name: 'ToolSearch', description: 'Load deferred tools', mcp: false }

// The tools of a session with tool search on.
const ALL = [SEARCH, ...LISTED]

// The plugin's store across sessions. Returns what it holds, for checks.
function fakeStore(on: On, held: Record<string, unknown> = {}): Record<string, unknown> {
  on('store.get', ($, e) => ({ value: held[e.key] }))
  on('store.set', ($, e) => {
    held[e.key] = e.value
    return { value: undefined }
  })
  return held
}

// The always-keep picker on a surface that draws an Input.
const pane = <S extends 'terminal' | 'desktop'>(surface: S) => ({
  plugin: 'loadout',
  surface,
  component: 'Pane' as const,
  requestId: 'loadout-keep',
  props: { title: 'loadout', isFocused: true, bodyColumns: 80, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
})

test('keeps only what the classifier picks, and says what it hid', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('prompt.section', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  on('model.complete', ($, e) =>
    answer(String(e.prompt).includes('dep-scan') ? 'local-tools:dep-scan\nnot-a-skill' : 'claude_in_chrome'),
  )

  await submit($, 'Check the login page in the browser for a CVE')

  const tools = await attach($, 'deferred_tools_delta', TOOLS)
  expect(tools.text).toContain('CronCreate')
  expect(tools.text).toContain('mcp__claude-in-chrome__navigate')
  expect(tools.text).not.toContain('mcp__datadog__search_logs')
  expect(tools.text).toContain('datadog (2), slack (1)')

  const skills = await attach($, 'skill_listing', SKILLS)
  expect(skills.text).toContain('local-tools:dep-scan')
  expect(skills.text).not.toContain('riff:title')
  expect(skills.text).not.toContain('three length categories')
  expect(skills.text).toContain('hid 2 more skills')

  const section = await $.prompt.section({ name: 'mcp_instructions', text: MCP })
  expect(section.text).toContain('Chrome rules.')
  expect(section.text).not.toContain('Datadog rules.')
})

test('keeps everything when the classifier fails', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  on('model.complete', () => failed())

  await submit($, 'Anything')
  const tools = await attach($, 'deferred_tools_delta', TOOLS)
  expect(tools.text).toBe(TOOLS)
})

test('traces the token use of each classifier call, also a failed one', { options: { traceFile: '/trace.jsonl' } }, async ($, on) => {
  let written = ''
  on('fs.read', () => ({ value: written }))
  on('fs.write', ($, e) => {
    written = e.text
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  const clock = mock.clock(on)
  on('model.complete', ($, e) =>
    String(e.prompt).includes('dep-scan')
      ? failed()
      : answer('claude_in_chrome'),
  )

  await submit($, 'Check the login page in the browser')
  await attach($, 'deferred_tools_delta', TOOLS)
  await attach($, 'skill_listing', SKILLS)

  // Trace lines are written one after the other: let them settle.
  await clock.advance(0)
  const calls = written.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(line => line.event === 'classifier')
  expect(calls).toEqual([
    { event: 'classifier', purpose: 'tools', model: 'haiku', isAnswered: true, usage: USAGE },
    { event: 'classifier', purpose: 'skills', model: 'haiku', isAnswered: false, usage: null },
  ])
})

test('passes listings through before the first prompt', async ($, on) => {
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  const skills = await attach($, 'skill_listing', SKILLS)
  expect(skills.text).toBe(SKILLS)
})

test('names hidden tools a later prompt needs, once, without changing the lists', async ($, on) => {
  const seen: string[][] = []
  on('prompt.submit', ($, e) => {
    seen.push([...(e.context ?? [])])
    return { text: e.text }
  })
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  on('model.complete', ($, e) => {
    const asked = String(e.prompt)
    const newest = /<prompt>([\s\S]*)<\/prompt>/.exec(asked)?.[1]
    const text = newest === undefined ? 'claude_in_chrome' : newest.includes('logs') ? 'datadog' : 'none'
    return answer(text)
  })

  await submit($, 'Check the login page in the browser')
  const first = await attach($, 'deferred_tools_delta', TOOLS)
  expect(first.text).not.toContain('mcp__datadog__search_logs')

  await submit($, 'Rename this variable')
  await submit($, 'Now look at the error logs for it')
  await submit($, 'And the logs from yesterday')

  expect(seen[1]).toEqual([])
  expect(seen[2]?.join('\n')).toContain('datadog (2 tools): search_logs, get_trace')
  expect(seen[2]?.join('\n')).toContain('ToolSearch')
  expect(seen[3]).toEqual([])
})

// Each word of /loadout but off, as a person types it. The type makes a new
// word fail the type check until it has a line here.
const TYPED: Record<Exclude<CommandWord, 'off'>, readonly string[]> = {
  list: ['list'],
  pick: ['pick'],
  keep: ['keep datadog', 'keep riff'],
  unkeep: ['unkeep datadog'],
  effort: ['effort off', 'effort on'],
  model: ['model on', 'model off'],
  on: ['on'],
}

// The rule of AGENTS.md: the listings sit in the first message, so a change
// after the first request spends the prompt cache of the whole conversation.
// Each listing raised again after later prompts, commands, requests and a
// classifier that now keeps everything must come back as the first time.
test('never changes a listing after the first request, whatever comes later', { options: { effortPerPrompt: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('prompt.section', ($, e) => ({ text: e.text }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  quiet(on)
  listed(on, ALL)
  fakeStore(on)
  requests(on)
  let keep = 'claude_in_chrome\nlocal-tools:dep-scan'
  picks(on, () => 'low', 'reasoning effort', () => keep)
  const raise = async () => [
    (await attach($, 'deferred_tools_delta', TOOLS)).text,
    (await attach($, 'skill_listing', SKILLS)).text,
    (await attach($, 'mcp_instructions_delta', BLOCKS)).text,
    (await $.prompt.section({ name: 'mcp_instructions', text: MCP })).text,
  ]

  await submit($, 'Check the login page in the browser')
  const first = await raise()
  expect(first[0]).not.toContain('mcp__datadog__search_logs')
  await step($, 't1')

  keep = 'claude_in_chrome\ndatadog\nslack\nlocal-tools:dep-scan\nriff:title\nupdate-config'
  await submit($, 'Now look at the error logs and the riff titles')
  await step($, 't2')
  for (const args of ['', ...Object.values(TYPED).flat()]) {
    await command($, args)
    expect(await raise()).toEqual(first)
  }
  await submit($, 'And the logs from yesterday')
  await step($, 't3')
  expect(await raise()).toEqual(first)

  // /loadout off is the one change the person asks for. On again brings back the same listings.
  await command($, 'off')
  expect((await raise())[0]).toBe(TOOLS)
  await command($, 'on')
  expect(await raise()).toEqual(first)
})

test('tells the person when a later prompt starts a new task, and leaves the prompt as it is', async ($, on) => {
  const seen: string[][] = []
  const asked: string[] = []
  const toasts: string[] = []
  on('prompt.submit', ($, e) => {
    seen.push([...(e.context ?? [])])
    return { text: e.text }
  })
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on, toasts)
  listed(on, ALL)
  on('model.complete', ($, e) => {
    const prompt = String(e.prompt)
    asked.push(prompt)
    const newest = /<prompt>([\s\S]*)<\/prompt>/.exec(prompt)?.[1]
    return answer(newest === undefined ? 'claude_in_chrome' : newest.includes('invoice') ? 'NEW TASK' : 'none')
  })

  await submit($, 'Check the login page in the browser')
  await attach($, 'deferred_tools_delta', TOOLS)
  await submit($, 'Now fix the button color')
  await submit($, 'Write a script that totals the invoice files')

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('new task')
  expect(seen[2]).toEqual([])
  const last = asked.at(-1) ?? ''
  expect(last).toContain('<earlier>\nCheck the login page in the browser\n</earlier>')
  expect(last).toContain('<earlier>\nNow fix the button color\n</earlier>')
})

test('with nothing left to name, checks the task without holding the prompt', async ($, on) => {
  const seen: string[][] = []
  const toasts: string[] = []
  on('prompt.submit', ($, e) => {
    seen.push([...(e.context ?? [])])
    return { text: e.text }
  })
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on, toasts)
  listed(on, ALL)
  const clock = mock.clock(on)
  on('model.complete', ($, e) =>
    answer(String(e.prompt).includes('<prompt>') ? 'NEW TASK' : 'claude_in_chrome\ndatadog\nslack'),
  )

  await submit($, 'Check the login page in the browser')
  await attach($, 'deferred_tools_delta', TOOLS)
  await submit($, 'Write a script that totals the invoice files')
  // The check runs after the prompt: let it settle.
  await clock.advance(0)

  expect(seen[1]).toEqual([])
  expect(toasts).toHaveLength(1)
})

test('with newTaskNote off, checks no task and asks nothing when nothing is hidden', { options: { newTaskNote: false } }, async ($, on) => {
  const asked: string[] = []
  const toasts: string[] = []
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on, toasts)
  listed(on, ALL)
  on('model.complete', ($, e) => {
    asked.push(String(e.prompt))
    return answer('NEW TASK')
  })

  await submit($, 'Check the login page in the browser')
  await submit($, 'Write a script that totals the invoice files')

  expect(asked).toEqual([])
  expect(toasts).toEqual([])
})

// The engine's request beneath turn.step: records what `of` reads from each
// request (its effort by default), and answers with the cache use that
// `cache` gives.
function requests(
  on: On,
  cache: () => { read: number; written: number } = () => ({ read: 1000, written: 100 }),
  of: (e: { model: string; effort?: unknown }) => unknown = e => e.effort,
): unknown[] {
  const sent: unknown[] = []
  on('turn.step', async function* ($, e) {
    sent.push(of(e))
    const { read, written } = cache()
    const usage = { ...USAGE, model: e.model, cache_read_input_tokens: read, cache_creation_input_tokens: written }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  return sent
}

// One main request (or a subagent's, with `agentId`), read to its end.
async function step($: Engine, turnId: string, more: Record<string, unknown> = {}): Promise<void> {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 3, ...more })
  for await (const _ of stream);
}

// The classifier: `level` for the pick whose system names `marker` (the
// effort by default), `rest` (the first group by default) for the others.
function picks(on: On, level: () => string, marker = 'reasoning effort', rest: () => string = () => 'claude_in_chrome'): void {
  on('model.complete', ($, e) => answer(String(e.system).includes(marker) ? level() : rest()))
}

test('sets the picked effort on the main requests only, never above the session effort', { options: { effortPerPrompt: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  const sent = requests(on)
  let level = 'low'
  picks(on, () => level)

  await submit($, 'What does this function return?')
  await step($, 't1')
  await step($, 't1', { agentId: 'sub' })
  await step($, 't1', { model: 'claude-sonnet-5' })
  level = 'max'
  await submit($, 'Redesign the storage layer')
  await step($, 't2')

  expect(sent).toEqual(['low', 'high', 'high', 'high'])
})

test('keeps the effort for the session once a change lost the cache', { options: { effortPerPrompt: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  mock.clock(on)
  let cache = { read: 1000, written: 100 }
  const sent = requests(on, () => cache)
  let level = 'low'
  picks(on, () => level)

  await submit($, 'What does this function return?')
  await step($, 't1')
  level = 'medium'
  cache = { read: 0, written: 1200 }
  await submit($, 'Fix the failing test')
  await step($, 't2')
  level = 'low'
  cache = { read: 1200, written: 50 }
  await submit($, 'And rename it')
  await step($, 't3')

  await command($, 'effort off')
  await step($, 't4')

  expect(sent).toEqual(['low', 'medium', 'medium', 'medium'])
  expect((await command($, '')).text).toContain('Effort: medium (fixed')
})

test('does not keep the effort when the cache was lost to a pause or a change of model', { options: { effortPerPrompt: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  const clock = mock.clock(on)
  let cache = { read: 1000, written: 100 }
  const sent = requests(on, () => cache)
  let level = 'low'
  picks(on, () => level)

  await submit($, 'What does this function return?')
  await step($, 't1')
  await clock.advance(10 * 60 * 1000)
  level = 'medium'
  cache = { read: 0, written: 1200 }
  await submit($, 'Fix the failing test')
  await step($, 't2')
  level = 'low'
  await submit($, 'Now on the other model')
  await step($, 't3', { model: 'claude-opus-5-5' })
  level = 'medium'
  cache = { read: 1200, written: 50 }
  await submit($, 'And rename it')
  await step($, 't4', { model: 'claude-opus-5-5' })

  expect(sent).toEqual(['low', 'medium', 'low', 'medium'])
  expect((await command($, '')).text).not.toContain('(fixed')
})

// The classifier picks `tier` for the model; the session runs `session`; the
// person answers the model question with the option that starts with `pick`.
// Returns the questions asked.
function routed(on: On, tier: string, pick: 'Use' | 'Keep', session: () => string = () => 'claude-opus-5-5'): string[] {
  const asked: string[] = []
  on('session.model', () => ({ value: session() }))
  picks(on, () => tier, 'choose the model')
  on('tool.call', ($, e, next) => {
    if (e.tool !== 'AskUserQuestion') return next(e)
    const question = firstQuestion(e)
    asked.push(question?.question ?? '')
    const label = question?.options.find(option => option.label.startsWith(pick))?.label ?? ''
    return { result: { questions: [question], answers: { [question?.question ?? '']: label } } }
  })
  return asked
}

// The footer's mode labels as the engine gets them from the plugin: `draw`
// renders the footer with the label `focus` and returns them.
function footer(on: On): ($: Engine) => Promise<readonly string[]> {
  let modes: readonly string[] = []
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    modes = e.props.modes
    return { type: 'Text', children: [] }
  })
  return async $ => {
    await $.ui.render({ surface: 'terminal', component: 'SessionMode', requestId: 'mode', props: { modes: ['focus'] } })
    return modes
  }
}

test('sends the session to the model the person approved, until they change it', { options: { modelForSession: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  const asked = routed(on, 'sonnet', 'Use')
  const draw = footer(on)
  const models = requests(on, undefined, e => e.model)

  await submit($, 'Add a test for the parser')
  await step($, 't1', { model: 'claude-opus-5-5' })
  await step($, 't1', { model: 'claude-opus-5-5', agentId: 'sub' })
  await submit($, 'Now run it')
  await step($, 't2', { model: 'claude-opus-5-5' })
  expect((await command($, '')).text).toContain('Model: claude-sonnet-5-5')
  expect(await draw($)).toEqual(['focus', 'sonnet-5-5 (loadout)'])
  await step($, 't3', { model: 'claude-fable-5-1' })
  await step($, 't4', { model: 'claude-opus-5-5' })
  expect(await draw($)).toEqual(['focus'])

  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('claude-sonnet-5-5')
  expect(models).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-5-5'])
})

test('/model ends the model change at once', { options: { modelForSession: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  let session = 'claude-opus-5-5'
  routed(on, 'haiku', 'Use', () => session)
  const draw = footer(on)
  on('command.run', { command: 'model' }, ($, e) => {
    session = 'claude-sonnet-5-5'
    return { text: 'Set model to Sonnet 5.5' }
  })

  await submit($, 'What is 2+2?')
  expect(await draw($)).toEqual(['focus', 'haiku-5-5 (loadout)'])
  await command($, 'sonnet', 'model')

  expect(await draw($)).toEqual(['focus'])
  expect((await command($, '')).text).not.toContain('Model:')
})

test('/loadout off sends the next requests to the session model', { options: { modelForSession: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  routed(on, 'haiku', 'Use')
  const models = requests(on, undefined, e => e.model)

  await submit($, 'What is 2+2?')
  await step($, 't1', { model: 'claude-opus-5-5' })
  await command($, 'off')
  await step($, 't2', { model: 'claude-opus-5-5' })
  await command($, 'on')
  await step($, 't3', { model: 'claude-opus-5-5' })

  expect(models).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
})

test('answers /loadout under its plugin name too', async ($, on) => {
  quiet(on)
  const { text } = await command($, 'off', 'loadout:loadout')
  expect(text).toContain('loadout is off')
})

test('keeps the session model when the person says no, or the pick is not smaller', { options: { modelForSession: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  const asked = routed(on, 'haiku', 'Keep', () => 'claude-sonnet-5-5')
  const models = requests(on, undefined, e => e.model)

  await submit($, 'What does this function return?')
  await step($, 't1', { model: 'claude-sonnet-5-5' })

  expect(asked.length).toBe(1)
  expect(models).toEqual(['claude-sonnet-5-5'])
})

test('asks nothing when the picked model is not smaller than the session model', { options: { modelForSession: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  const asked = routed(on, 'opus', 'Use', () => 'claude-sonnet-5-5')

  await submit($, 'Redesign the storage layer')

  expect(asked).toEqual([])
})

test('/loadout effort on and off switch the effort for this session', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  const sent = requests(on)
  picks(on, () => 'low')

  expect((await command($, '')).text).toContain('Effort for each prompt: off, Model for the session: off')
  expect((await command($, 'effort on')).text).toContain('is on')
  await submit($, 'What does this function return?')
  await step($, 't1')
  await command($, 'effort off')
  await submit($, 'And this one?')
  await step($, 't2')

  expect(sent).toEqual(['low', 'high'])
  expect((await command($, '')).text).not.toContain('Effort: low')
  expect((await command($, 'effort')).text).toContain('Type "/loadout effort on"')
})

test('/loadout model on before the first prompt, and off later', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  const asked = routed(on, 'haiku', 'Use')
  const draw = footer(on)
  const models = requests(on, undefined, e => e.model)

  await command($, 'model on')
  await submit($, 'What is 2+2?')
  await step($, 't1', { model: 'claude-opus-5-5' })
  expect((await command($, 'model off')).text).toContain('is off')
  expect(await draw($)).toEqual(['focus'])
  await step($, 't2', { model: 'claude-opus-5-5' })
  expect((await command($, 'model on')).text).toContain('first prompt only')
  await step($, 't3', { model: 'claude-opus-5-5' })

  expect(asked.length).toBe(1)
  expect(models).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
})

test('leaves the effort alone when effortPerPrompt is off', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  const sent = requests(on)
  picks(on, () => 'low')

  await submit($, 'What does this function return?')
  await step($, 't1')

  expect(sent).toEqual(['high'])
})

// With tool search off, Claude Code puts every MCP tool in the prompt and
// sends no tool listing. Claude sees each server's tools, so no tool group is
// hidden: the instructions stay, and no later prompt gets a tool note.
test('hides no tool group when tool search is off', async ($, on) => {
  const seen: string[][] = []
  const asked: string[] = []
  on('prompt.submit', ($, e) => {
    seen.push([...(e.context ?? [])])
    return { text: e.text }
  })
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, LISTED)
  on('model.complete', ($, e) => {
    asked.push(String(e.prompt))
    return answer('claude_in_chrome')
  })

  await submit($, 'Check the login page in the browser')
  const delta = await attach($, 'mcp_instructions_delta', BLOCKS)
  expect(delta.text).toBe(BLOCKS)
  await submit($, 'Now look at the error logs')

  expect(asked.some(prompt => prompt.includes('tool groups'))).toBe(false)
  expect(seen[1]).toEqual([])
})

// With tool search on, the instructions can come before the tool listing.
// The plugin then classifies the tool groups from the tool list.
test('classifies from the tool list when the instructions come first', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  on('model.complete', () => answer('claude_in_chrome'))

  await submit($, 'Check the login page in the browser')
  const delta = await attach($, 'mcp_instructions_delta', BLOCKS)
  expect(delta.text).toContain('Chrome rules.')
  expect(delta.text).not.toContain('Datadog rules.')

  const tools = await attach($, 'deferred_tools_delta', TOOLS)
  expect(tools.text).not.toContain('mcp__datadog__search_logs')
})

// The engine can raise the MCP instructions and the tool listing together.
// The decision that waits for the other one must reuse it, not classify again.
test('two listings raised together classify the tool groups once, and agree', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  const replies = ['claude_in_chrome', 'datadog\nslack']
  on('model.complete', () => answer(replies.shift() ?? 'none'))

  await submit($, 'Check the login page in the browser')
  const [delta, tools] = await Promise.all([attach($, 'mcp_instructions_delta', BLOCKS), attach($, 'deferred_tools_delta', TOOLS)])
  expect(replies).toHaveLength(1)
  expect(delta.text).not.toContain('Datadog rules.')
  expect(tools.text).not.toContain('mcp__datadog__search_logs')
  expect(tools.text).toContain('mcp__claude-in-chrome__navigate')
})

// A server that connects late can raise its instructions before its tool
// listing. Its group gets a decision of its own there, and the earlier ones stay.
test('classifies a server that connects late from its instructions', async ($, on) => {
  const asked: string[] = []
  const tools = [SEARCH, ...LISTED.filter(tool => !tool.name.includes('slack'))]
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, tools)
  on('model.complete', ($, e) => {
    asked.push(String(e.prompt))
    return answer('claude_in_chrome')
  })

  await submit($, 'Check the login page in the browser')
  await attach($, 'mcp_instructions_delta', BLOCKS)
  tools.push({ name: 'mcp__slack__send_message', description: 'Send a message', mcp: true })
  const late = '## slack\nSlack rules.'
  const delta = await attach($, 'mcp_instructions_delta', late)

  expect(delta.text).not.toContain('Slack rules.')
  expect(asked).toHaveLength(2)
  expect(asked[1]).toContain('slack (1 tools)')
  expect(asked[1]).not.toContain('datadog')
})

// A deny rule takes ToolSearch out of the tool list. Claude then cannot load a
// hidden tool, so the plugin hides none.
test('keeps the tool listing when ToolSearch is denied', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, LISTED)
  on('model.complete', () => answer('claude_in_chrome'))

  await submit($, 'Check the login page in the browser')
  const tools = await attach($, 'deferred_tools_delta', TOOLS)
  expect(tools.text).toBe(TOOLS)
})

test('/loadout says that no tool group is hidden when the session has no ToolSearch', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, LISTED)
  on('model.complete', () => answer('local-tools:dep-scan'))

  await submit($, 'Check the dependencies for a CVE')
  await attach($, 'skill_listing', SKILLS)
  const out = await command($, '')
  expect(out.text).toContain('Tool groups hidden: none')
  expect(out.text).not.toContain('Tool groups kept: none')
})

test('never hides an always-kept item, and the classifier does not see it', { options: { alwaysKeep: 'local-tools update-config' } }, async ($, on) => {
  fakeStore(on, { alwaysKeep: ['slack'] })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  const asked: string[] = []
  on('model.complete', ($, e) => {
    asked.push(String(e.prompt))
    return answer('none')
  })

  await submit($, 'Rename this variable')
  const tools = await attach($, 'deferred_tools_delta', TOOLS)
  expect(tools.text).toContain('mcp__slack__send_message')
  expect(tools.text).not.toContain('mcp__datadog__search_logs')

  const skills = await attach($, 'skill_listing', SKILLS)
  expect(skills.text).toContain('local-tools:dep-scan')
  expect(skills.text).toContain('update-config')
  expect(skills.text).not.toContain('riff:title')

  expect(asked.join('\n')).not.toContain('slack (')
  expect(asked.join('\n')).not.toContain('dep-scan')
  expect((await command($, '')).text).toContain('Always kept: slack, local-tools:dep-scan, update-config')
})

test('/loadout keep and unkeep save the marks, and leave the option as it is', { options: { alwaysKeep: 'base' } }, async ($, on) => {
  const store = fakeStore(on, { alwaysKeep: ['retro'] })
  const say = async (args: string) => (await command($, args)).text

  expect(await say('keep kb-search')).toContain('Always keep: base, retro, kb-search.')
  expect(await say('keep kb-search')).toContain('already')
  expect(await say('keep base')).toContain('already')
  expect(await say('unkeep retro')).toContain('Always keep: base, kb-search.')
  expect(await say('unkeep base')).toContain('the option alwaysKeep in your settings covers it')
  expect(await say('unkeep nothing')).toContain('not on the always-keep list')
  expect(await say('keep a,b')).toContain('one skill, plugin or server name')
  expect(store.alwaysKeep).toEqual(['kb-search'])
})

test('/loadout list shows every item with its mark and its state', { options: { alwaysKeep: 'riff' } }, async ($, on) => {
  fakeStore(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  on('model.complete', () => answer('datadog'))

  await submit($, 'Look at the error logs')
  await attach($, 'deferred_tools_delta', TOOLS)
  await attach($, 'skill_listing', SKILLS)

  const text = (await command($, 'list')).text
  expect(text).toContain('[ ] datadog  (kept)')
  expect(text).toContain('[ ] slack  (hidden)')
  expect(text).toContain('[x] riff:title  (kept)')
})

test('the picker lists the skills and flips a mark on a press', async ($, on) => {
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, ALL)
  const store = fakeStore(on, { alwaysKeep: ['riff'] })
  await attach($, 'skill_listing', SKILLS)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    await ui.input({ key: 'filter', text: '', kind: 'change' })
    expect(JSON.stringify(await ui.drawn())).toContain('update-config')
    await ui.input({ key: 'filter', text: 'riff', kind: 'change' })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('● ')
    expect(drawn).not.toContain('update-config')
    await ui.unmount()
  }
  const ui = await $.ui.mount(pane('terminal'))
  await ui.input({ key: 'filter', text: '', kind: 'change' })
  expect(JSON.stringify(await ui.drawn())).toContain('tools:datadog')
  await ui.press({ key: 'skills:update-config' })
  expect(store.alwaysKeep).toEqual(['riff', 'update-config'])
  await ui.press({ key: 'skills:riff:title' })
  expect(store.alwaysKeep).toEqual(['update-config'])
  expect(JSON.stringify(await ui.drawn())).toContain('Always keep: update-config')
})

test('the picker names each server as /mcp does, with its size, and each skill with its description', async ($, on) => {
  quiet(on)
  listed(on, ALL)
  fakeStore(on)
  // The engine names a claude.ai connector in the tool-name spelling.
  const tool = (name: string, tokens: number) => ({ name, serverName: 'claude_ai_Datadog', tokens, isLoaded: false })
  const usage: SessionUsage = {
    startedAt: 0,
    rateLimits: [],
    context: {
      window: 200_000,
      breakdown: breakdown({
        mcpTools: [tool('mcp__datadog__search_logs', 900), tool('mcp__datadog__get_trace', 600)],
        skills: { totalSkills: 1, includedSkills: 1, tokens: 40, skillFrontmatter: [{ name: 'update-config', source: 'built-in', tokens: 40 }] },
      }),
    },
  }
  on('session.usage', () => ({ value: usage }))
  on('command.list', () => ({ value: [{ name: 'update-config', description: 'Configure the harness', source: 'builtin' }] }))

  const ui = await $.ui.mount(pane('terminal'))
  await ui.input({ key: 'filter', text: '', kind: 'change' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('claude.ai Datadog')
  expect(drawn).toContain('2 tools · 1.5k tokens · search_logs, get_trace')
  expect(drawn).toContain('1 tool · send_message')
  expect(drawn).toContain('40 tokens · Configure the harness')
  expect(drawn).toContain('Tool servers')
})

test('the picker says when a connector is not logged in', async ($, on) => {
  quiet(on)
  fakeStore(on)
  listed(on, [
    { name: 'mcp__claude_ai_Figma__authenticate', description: '', mcp: true },
    { name: 'mcp__claude_ai_Figma__complete_authentication', description: '', mcp: true },
  ])
  const ui = await $.ui.mount(pane('terminal'))
  await ui.input({ key: 'filter', text: '', kind: 'change' })
  expect(JSON.stringify(await ui.drawn())).toContain('2 tools · not logged in')
})

test('the picker reads the facts once when it opens, not on each key of the filter', async ($, on) => {
  quiet(on)
  listed(on, ALL)
  fakeStore(on)
  let reads = 0
  on('session.usage', () => {
    reads++
    return { value: { startedAt: 0, rateLimits: [], context: { window: 200_000 } } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await command($, 'pick')
  const ui = await $.ui.mount(pane('terminal'))
  for (const text of ['d', 'da', 'dat']) await ui.input({ key: 'filter', text, kind: 'change' })
  expect(JSON.stringify(await ui.drawn())).toContain('datadog')
  expect(reads).toBe(1)
})

test('a mark keeps the marks that another session saved after the picker opened', async ($, on) => {
  quiet(on)
  listed(on, ALL)
  const store = fakeStore(on, { alwaysKeep: ['riff'] })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await command($, 'pick')
  store.alwaysKeep = ['riff', 'slack']
  await command($, 'keep datadog')
  expect(store.alwaysKeep).toEqual(['riff', 'slack', 'datadog'])
})
