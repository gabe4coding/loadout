import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { parseTools } from '../hooks/scope'

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

const ENGINE = { kind: 'engine' } as const

// The MCP instructions as an attachment: the blocks, with no header.
const BLOCKS = MCP.slice(MCP.indexOf('## datadog'))

// The MCP tools of TOOLS as $.tool.list() gives them.
const LISTED = parseTools(TOOLS)
  .entries.map(entry => entry.name)
  .filter(name => name.startsWith('mcp__'))
  .map(name => ({ name, description: '', mcp: true }))

const SEARCH = { name: 'ToolSearch', description: 'Load deferred tools', mcp: false }

// $.tool.list() as the engine answers it: with tool search on unless `tools`
// says otherwise.
function listed(on: On, tools: object[] = [SEARCH, ...LISTED]): void {
  on('tool.list', () => ({ value: tools }) as never)
}

// A classifier that replies `text`.
function answer(text: string) {
  return { value: { isAnswered: true, text, usage: { inputTokens: 1, outputTokens: 1 } } } as never
}

// The engine's own ui.status, ui.invalidate and ui.toast, which the kit
// leaves out. Each toast text goes into `toasts`.
function quiet(on: On, toasts: string[] = []): void {
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
}

// The plugin's store across sessions. Returns what it holds, for checks.
function fakeStore(on: On, held: Record<string, unknown> = {}): Record<string, unknown> {
  on('store.get', ($, e) => ({ value: held[e.key] }) as never)
  on('store.set', ($, e) => {
    held[e.key] = e.value
    return { value: undefined }
  })
  return held
}

// The MCP tools of the session, as $.tool.list() answers.
const COMPOSER = { kind: 'composer' } as const
const run = (args: string) => ({ command: 'loadout', args, origin: COMPOSER, presentation: { isFullscreen: false, columns: 80 } }) as never
// The always-keep picker on a surface that draws an Input.
const pane = <S extends 'terminal' | 'desktop'>(surface: S) => ({
  plugin: 'loadout',
  surface,
  component: 'Pane' as const,
  requestId: 'loadout-keep',
  props: { title: 'loadout', isFocused: true, bodyColumns: 80, placement: 'inline' } as never,
})

test('keeps only what the classifier picks, and says what it hid', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('prompt.section', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  on('model.complete', ($, e) =>
    answer(String(e.prompt).includes('dep-scan') ? 'local-tools:dep-scan\nnot-a-skill' : 'claude_in_chrome'),
  )

  await $.prompt.submit({ text: 'Check the login page in the browser for a CVE', wait: false } as never)

  const tools = await $.prompt.attachment({ type: 'deferred_tools_delta', text: TOOLS, origin: ENGINE } as never)
  expect(tools.text).toContain('CronCreate')
  expect(tools.text).toContain('mcp__claude-in-chrome__navigate')
  expect(tools.text).not.toContain('mcp__datadog__search_logs')
  expect(tools.text).toContain('datadog (2), slack (1)')

  const skills = await $.prompt.attachment({ type: 'skill_listing', text: SKILLS, origin: ENGINE } as never)
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
  listed(on)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: 500, error: 'x' } }) as never)

  await $.prompt.submit({ text: 'Anything', wait: false } as never)
  const tools = await $.prompt.attachment({ type: 'deferred_tools_delta', text: TOOLS, origin: ENGINE } as never)
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
  listed(on)
  const clock = mock.clock(on)
  on('model.complete', ($, e) =>
    String(e.prompt).includes('dep-scan')
      ? ({ value: { isAnswered: false, reason: 'api-error', status: 500, error: 'x' } } as never)
      : answer('claude_in_chrome'),
  )

  await $.prompt.submit({ text: 'Check the login page in the browser', wait: false, origin: COMPOSER } as never)
  await $.prompt.attachment({ type: 'deferred_tools_delta', text: TOOLS, origin: ENGINE } as never)
  await $.prompt.attachment({ type: 'skill_listing', text: SKILLS, origin: ENGINE } as never)

  // Trace lines are written one after the other: let them settle.
  await clock.advance(0)
  const calls = written.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(line => line.event === 'classifier')
  expect(calls).toEqual([
    { event: 'classifier', purpose: 'tools', model: 'haiku', isAnswered: true, usage: { inputTokens: 1, outputTokens: 1 } },
    { event: 'classifier', purpose: 'skills', model: 'haiku', isAnswered: false, usage: null },
  ])
})

test('passes listings through before the first prompt', async ($, on) => {
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  const skills = await $.prompt.attachment({ type: 'skill_listing', text: SKILLS, origin: ENGINE } as never)
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
  listed(on)
  on('model.complete', ($, e) => {
    const asked = String(e.prompt)
    const newest = /<prompt>([\s\S]*)<\/prompt>/.exec(asked)?.[1]
    const text = newest === undefined ? 'claude_in_chrome' : newest.includes('logs') ? 'datadog' : 'none'
    return answer(text)
  })

  await $.prompt.submit({ text: 'Check the login page in the browser', wait: false, origin: COMPOSER } as never)
  const first = await $.prompt.attachment({ type: 'deferred_tools_delta', text: TOOLS, origin: ENGINE } as never)
  expect(first.text).not.toContain('mcp__datadog__search_logs')

  await $.prompt.submit({ text: 'Rename this variable', wait: false, origin: COMPOSER } as never)
  await $.prompt.submit({ text: 'Now look at the error logs for it', wait: false, origin: COMPOSER } as never)
  await $.prompt.submit({ text: 'And the logs from yesterday', wait: false, origin: COMPOSER } as never)

  expect(seen[1]).toEqual([])
  expect(seen[2]?.join('\n')).toContain('datadog (2 tools): search_logs, get_trace')
  expect(seen[2]?.join('\n')).toContain('ToolSearch')
  expect(seen[3]).toEqual([])
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
  listed(on)
  on('model.complete', ($, e) => {
    const prompt = String(e.prompt)
    asked.push(prompt)
    const newest = /<prompt>([\s\S]*)<\/prompt>/.exec(prompt)?.[1]
    return answer(newest === undefined ? 'claude_in_chrome' : newest.includes('invoice') ? 'NEW TASK' : 'none')
  })

  await $.prompt.submit({ text: 'Check the login page in the browser', wait: false, origin: COMPOSER } as never)
  await $.prompt.attachment({ type: 'deferred_tools_delta', text: TOOLS, origin: ENGINE } as never)
  await $.prompt.submit({ text: 'Now fix the button color', wait: false, origin: COMPOSER } as never)
  await $.prompt.submit({ text: 'Write a script that totals the invoice files', wait: false, origin: COMPOSER } as never)

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
  listed(on)
  const clock = mock.clock(on)
  on('model.complete', ($, e) =>
    answer(String(e.prompt).includes('<prompt>') ? 'NEW TASK' : 'claude_in_chrome\ndatadog\nslack'),
  )

  await $.prompt.submit({ text: 'Check the login page in the browser', wait: false, origin: COMPOSER } as never)
  await $.prompt.attachment({ type: 'deferred_tools_delta', text: TOOLS, origin: ENGINE } as never)
  await $.prompt.submit({ text: 'Write a script that totals the invoice files', wait: false, origin: COMPOSER } as never)
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
  listed(on)
  on('model.complete', ($, e) => {
    asked.push(String(e.prompt))
    return answer('NEW TASK')
  })

  await $.prompt.submit({ text: 'Check the login page in the browser', wait: false, origin: COMPOSER } as never)
  await $.prompt.submit({ text: 'Write a script that totals the invoice files', wait: false, origin: COMPOSER } as never)

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
    const usage = { model: e.model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: written }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  return sent
}

// One main request (or a subagent's, with `agentId`), read to its end.
async function step($: Engine, turnId: string, more: Record<string, unknown> = {}): Promise<void> {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 3, ...more } as never)
  for await (const _ of stream);
}

// The classifier: `level` for the pick whose system names `marker` (the
// effort by default), the first group for the rest.
function picks(on: On, level: () => string, marker = 'reasoning effort'): void {
  on('model.complete', ($, e) => answer(String(e.system).includes(marker) ? level() : 'claude_in_chrome'))
}

test('sets the picked effort on the main requests only, never above the session effort', { options: { effortPerPrompt: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  const sent = requests(on)
  let level = 'low'
  picks(on, () => level)

  await $.prompt.submit({ text: 'What does this function return?', wait: false, origin: COMPOSER } as never)
  await step($, 't1')
  await step($, 't1', { agentId: 'sub' })
  await step($, 't1', { model: 'claude-sonnet-5' })
  level = 'max'
  await $.prompt.submit({ text: 'Redesign the storage layer', wait: false, origin: COMPOSER } as never)
  await step($, 't2')

  expect(sent).toEqual(['low', 'high', 'high', 'high'])
})

test('keeps the effort for the session once a change lost the cache', { options: { effortPerPrompt: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  mock.clock(on)
  let cache = { read: 1000, written: 100 }
  const sent = requests(on, () => cache)
  let level = 'low'
  picks(on, () => level)

  await $.prompt.submit({ text: 'What does this function return?', wait: false, origin: COMPOSER } as never)
  await step($, 't1')
  level = 'medium'
  cache = { read: 0, written: 1200 }
  await $.prompt.submit({ text: 'Fix the failing test', wait: false, origin: COMPOSER } as never)
  await step($, 't2')
  level = 'low'
  cache = { read: 1200, written: 50 }
  await $.prompt.submit({ text: 'And rename it', wait: false, origin: COMPOSER } as never)
  await step($, 't3')

  await $.command.run(run('effort off'))
  await step($, 't4')

  expect(sent).toEqual(['low', 'medium', 'medium', 'medium'])
  expect((await $.command.run(run(''))).text).toContain('Effort: medium (fixed')
})

test('does not keep the effort when the cache was lost to a pause or a change of model', { options: { effortPerPrompt: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  const clock = mock.clock(on)
  let cache = { read: 1000, written: 100 }
  const sent = requests(on, () => cache)
  let level = 'low'
  picks(on, () => level)

  await $.prompt.submit({ text: 'What does this function return?', wait: false, origin: COMPOSER } as never)
  await step($, 't1')
  await clock.advance(10 * 60 * 1000)
  level = 'medium'
  cache = { read: 0, written: 1200 }
  await $.prompt.submit({ text: 'Fix the failing test', wait: false, origin: COMPOSER } as never)
  await step($, 't2')
  level = 'low'
  await $.prompt.submit({ text: 'Now on the other model', wait: false, origin: COMPOSER } as never)
  await step($, 't3', { model: 'claude-opus-5-5' })
  level = 'medium'
  cache = { read: 1200, written: 50 }
  await $.prompt.submit({ text: 'And rename it', wait: false, origin: COMPOSER } as never)
  await step($, 't4', { model: 'claude-opus-5-5' })

  expect(sent).toEqual(['low', 'medium', 'low', 'medium'])
  expect((await $.command.run(run(''))).text).not.toContain('(fixed')
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
    const question = (e as never as { questions: { question: string; options: { label: string }[] }[] }).questions[0]
    asked.push(question?.question ?? '')
    const label = question?.options.find(option => option.label.startsWith(pick))?.label ?? ''
    return { result: { questions: [question], answers: { [question?.question ?? '']: label } } } as never
  })
  return asked
}

// The footer's mode labels as the engine gets them from the plugin: `draw`
// renders the footer with the label `focus` and returns them.
function footer(on: On): ($: Engine) => Promise<readonly string[]> {
  let modes: readonly string[] = []
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    modes = e.props.modes
    return { type: 'Text', children: [] } as never
  })
  return async $ => {
    await $.ui.render({ surface: 'terminal', component: 'SessionMode', requestId: 'mode', props: { modes: ['focus'] } } as never)
    return modes
  }
}

test('sends the session to the model the person approved, until they change it', { options: { modelForSession: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  const asked = routed(on, 'sonnet', 'Use')
  const draw = footer(on)
  const models = requests(on, undefined, e => e.model)

  await $.prompt.submit({ text: 'Add a test for the parser', wait: false, origin: COMPOSER } as never)
  await step($, 't1', { model: 'claude-opus-5-5' })
  await step($, 't1', { model: 'claude-opus-5-5', agentId: 'sub' })
  await $.prompt.submit({ text: 'Now run it', wait: false, origin: COMPOSER } as never)
  await step($, 't2', { model: 'claude-opus-5-5' })
  expect((await $.command.run(run(''))).text).toContain('Model: claude-sonnet-5-5')
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
  listed(on)
  let session = 'claude-opus-5-5'
  routed(on, 'haiku', 'Use', () => session)
  const draw = footer(on)
  on('command.run', { command: 'model' }, ($, e) => {
    session = 'claude-sonnet-5-5'
    return { text: 'Set model to Sonnet 5.5' } as never
  })

  await $.prompt.submit({ text: 'What is 2+2?', wait: false, origin: COMPOSER } as never)
  expect(await draw($)).toEqual(['focus', 'haiku-5-5 (loadout)'])
  await $.command.run({ command: 'model', args: 'sonnet', origin: COMPOSER } as never)

  expect(await draw($)).toEqual(['focus'])
  expect((await $.command.run(run(''))).text).not.toContain('Model:')
})

test('/loadout off sends the next requests to the session model', { options: { modelForSession: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  routed(on, 'haiku', 'Use')
  const models = requests(on, undefined, e => e.model)

  await $.prompt.submit({ text: 'What is 2+2?', wait: false, origin: COMPOSER } as never)
  await step($, 't1', { model: 'claude-opus-5-5' })
  await $.command.run(run('off'))
  await step($, 't2', { model: 'claude-opus-5-5' })
  await $.command.run(run('on'))
  await step($, 't3', { model: 'claude-opus-5-5' })

  expect(models).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
})

test('keeps the session model when the person says no, or the pick is not smaller', { options: { modelForSession: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  const asked = routed(on, 'haiku', 'Keep', () => 'claude-sonnet-5-5')
  const models = requests(on, undefined, e => e.model)

  await $.prompt.submit({ text: 'What does this function return?', wait: false, origin: COMPOSER } as never)
  await step($, 't1', { model: 'claude-sonnet-5-5' })

  expect(asked.length).toBe(1)
  expect(models).toEqual(['claude-sonnet-5-5'])
})

test('asks nothing when the picked model is not smaller than the session model', { options: { modelForSession: true } }, async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  const asked = routed(on, 'opus', 'Use', () => 'claude-sonnet-5-5')

  await $.prompt.submit({ text: 'Redesign the storage layer', wait: false, origin: COMPOSER } as never)

  expect(asked).toEqual([])
})

test('/loadout effort on and off switch the effort for this session', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  const sent = requests(on)
  picks(on, () => 'low')

  expect((await $.command.run(run(''))).text).toContain('Effort for each prompt: off, Model for the session: off')
  expect((await $.command.run(run('effort on'))).text).toContain('is on')
  await $.prompt.submit({ text: 'What does this function return?', wait: false, origin: COMPOSER } as never)
  await step($, 't1')
  await $.command.run(run('effort off'))
  await $.prompt.submit({ text: 'And this one?', wait: false, origin: COMPOSER } as never)
  await step($, 't2')

  expect(sent).toEqual(['low', 'high'])
  expect((await $.command.run(run(''))).text).not.toContain('Effort: low')
  expect((await $.command.run(run('effort'))).text).toContain('Type "/loadout effort on"')
})

test('/loadout model on before the first prompt, and off later', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  const asked = routed(on, 'haiku', 'Use')
  const draw = footer(on)
  const models = requests(on, undefined, e => e.model)

  await $.command.run(run('model on'))
  await $.prompt.submit({ text: 'What is 2+2?', wait: false, origin: COMPOSER } as never)
  await step($, 't1', { model: 'claude-opus-5-5' })
  expect((await $.command.run(run('model off'))).text).toContain('is off')
  expect(await draw($)).toEqual(['focus'])
  await step($, 't2', { model: 'claude-opus-5-5' })
  expect((await $.command.run(run('model on'))).text).toContain('first prompt only')
  await step($, 't3', { model: 'claude-opus-5-5' })

  expect(asked.length).toBe(1)
  expect(models).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
})

test('leaves the effort alone when effortPerPrompt is off', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  const sent = requests(on)
  picks(on, () => 'low')

  await $.prompt.submit({ text: 'What does this function return?', wait: false, origin: COMPOSER } as never)
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
  const composer = { kind: 'composer' } as const

  await $.prompt.submit({ text: 'Check the login page in the browser', wait: false, origin: composer } as never)
  const delta = await $.prompt.attachment({ type: 'mcp_instructions_delta', text: BLOCKS, origin: ENGINE } as never)
  expect(delta.text).toBe(BLOCKS)
  await $.prompt.submit({ text: 'Now look at the error logs', wait: false, origin: composer } as never)

  expect(asked.some(prompt => prompt.includes('tool groups'))).toBe(false)
  expect(seen[1]).toEqual([])
})

// With tool search on, the instructions can come before the tool listing.
// The plugin then classifies the tool groups from the tool list.
test('classifies from the tool list when the instructions come first', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  on('model.complete', () => answer('claude_in_chrome'))

  await $.prompt.submit({ text: 'Check the login page in the browser', wait: false } as never)
  const delta = await $.prompt.attachment({ type: 'mcp_instructions_delta', text: BLOCKS, origin: ENGINE } as never)
  expect(delta.text).toContain('Chrome rules.')
  expect(delta.text).not.toContain('Datadog rules.')

  const tools = await $.prompt.attachment({ type: 'deferred_tools_delta', text: TOOLS, origin: ENGINE } as never)
  expect(tools.text).not.toContain('mcp__datadog__search_logs')
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

  await $.prompt.submit({ text: 'Check the login page in the browser', wait: false } as never)
  await $.prompt.attachment({ type: 'mcp_instructions_delta', text: BLOCKS, origin: ENGINE } as never)
  tools.push({ name: 'mcp__slack__send_message', description: 'Send a message', mcp: true })
  const late = '## slack\nSlack rules.'
  const delta = await $.prompt.attachment({ type: 'mcp_instructions_delta', text: late, origin: ENGINE } as never)

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

  await $.prompt.submit({ text: 'Check the login page in the browser', wait: false } as never)
  const tools = await $.prompt.attachment({ type: 'deferred_tools_delta', text: TOOLS, origin: ENGINE } as never)
  expect(tools.text).toBe(TOOLS)
})

test('/loadout says that no tool group is hidden when the session has no ToolSearch', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on, LISTED)
  on('model.complete', () => answer('local-tools:dep-scan'))

  await $.prompt.submit({ text: 'Check the dependencies for a CVE', wait: false } as never)
  await $.prompt.attachment({ type: 'skill_listing', text: SKILLS, origin: ENGINE } as never)
  const out = await $.command.run(run(''))
  expect(out.text).toContain('Tool groups hidden: none')
  expect(out.text).not.toContain('Tool groups kept: none')
})

test('never hides an always-kept item, and the classifier does not see it', { options: { alwaysKeep: 'local-tools update-config' } }, async ($, on) => {
  fakeStore(on, { alwaysKeep: ['slack'] })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  const asked: string[] = []
  on('model.complete', ($, e) => {
    asked.push(String(e.prompt))
    return { value: { isAnswered: true, text: 'none', usage: { inputTokens: 1, outputTokens: 1 } } } as never
  })

  await $.prompt.submit({ text: 'Rename this variable', wait: false } as never)
  const tools = await $.prompt.attachment({ type: 'deferred_tools_delta', text: TOOLS, origin: ENGINE } as never)
  expect(tools.text).toContain('mcp__slack__send_message')
  expect(tools.text).not.toContain('mcp__datadog__search_logs')

  const skills = await $.prompt.attachment({ type: 'skill_listing', text: SKILLS, origin: ENGINE } as never)
  expect(skills.text).toContain('local-tools:dep-scan')
  expect(skills.text).toContain('update-config')
  expect(skills.text).not.toContain('riff:title')

  expect(asked.join('\n')).not.toContain('slack (')
  expect(asked.join('\n')).not.toContain('dep-scan')
  expect((await $.command.run(run(''))).text).toContain('Always kept: slack, local-tools:dep-scan, update-config')
})

test('/loadout keep and unkeep save the marks, and leave the option as it is', { options: { alwaysKeep: 'base' } }, async ($, on) => {
  const store = fakeStore(on, { alwaysKeep: ['retro'] })
  const say = async (args: string) => (await $.command.run(run(args))).text

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
  listed(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'datadog', usage: { inputTokens: 1, outputTokens: 1 } } }) as never)

  await $.prompt.submit({ text: 'Look at the error logs', wait: false } as never)
  await $.prompt.attachment({ type: 'deferred_tools_delta', text: TOOLS, origin: ENGINE } as never)
  await $.prompt.attachment({ type: 'skill_listing', text: SKILLS, origin: ENGINE } as never)

  const text = (await $.command.run(run('list'))).text
  expect(text).toContain('[ ] datadog  (kept)')
  expect(text).toContain('[ ] slack  (hidden)')
  expect(text).toContain('[x] riff:title  (kept)')
})

test('the picker lists the skills and flips a mark on a press', async ($, on) => {
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
  listed(on)
  const store = fakeStore(on, { alwaysKeep: ['riff'] })
  await $.prompt.attachment({ type: 'skill_listing', text: SKILLS, origin: ENGINE } as never)

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
  listed(on)
  fakeStore(on)
  // The engine names a claude.ai connector in the tool-name spelling.
  const tool = (name: string, tokens: number) => ({ name, serverName: 'claude_ai_Datadog', tokens, isLoaded: false })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        window: 200_000,
        breakdown: {
          mcpTools: [tool('mcp__datadog__search_logs', 900), tool('mcp__datadog__get_trace', 600)],
          skills: { totalSkills: 1, includedSkills: 1, tokens: 40, skillFrontmatter: [{ name: 'update-config', source: 'built-in', tokens: 40 }] },
        },
      },
    },
  }) as never)
  on('command.list', () => ({ value: [{ name: 'update-config', description: 'Configure the harness', source: 'builtin' }] }) as never)

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
  listed(on)
  fakeStore(on)
  let reads = 0
  on('session.usage', () => {
    reads++
    return { value: { startedAt: 0, rateLimits: [], context: { window: 200_000 } } } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  await $.command.run(run('pick'))
  const ui = await $.ui.mount(pane('terminal'))
  for (const text of ['d', 'da', 'dat']) await ui.input({ key: 'filter', text, kind: 'change' })
  expect(JSON.stringify(await ui.drawn())).toContain('datadog')
  expect(reads).toBe(1)
})

test('a mark keeps the marks that another session saved after the picker opened', async ($, on) => {
  quiet(on)
  listed(on)
  const store = fakeStore(on, { alwaysKeep: ['riff'] })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  await $.command.run(run('pick'))
  store.alwaysKeep = ['riff', 'slack']
  await $.command.run(run('keep datadog'))
  expect(store.alwaysKeep).toEqual(['riff', 'slack', 'datadog'])
})
