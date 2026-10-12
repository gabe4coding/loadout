import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

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

// The engine's own ui.status, ui.invalidate and ui.toast, which the kit
// leaves out.
function quiet(on: On): void {
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
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
function fakeTools(on: On): void {
  const names = parseTools(TOOLS).entries.map(entry => entry.name).filter(name => name.startsWith('mcp__'))
  on('tool.list', () => ({ value: names.map(name => ({ name, mcp: true })) }) as never)
}

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
  on('model.complete', ($, e) => ({
    value: {
      isAnswered: true,
      text: String(e.prompt).includes('dep-scan') ? 'local-tools:dep-scan\nnot-a-skill' : 'claude_in_chrome',
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  }) as never)

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
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: 500, error: 'x' } }) as never)

  await $.prompt.submit({ text: 'Anything', wait: false } as never)
  const tools = await $.prompt.attachment({ type: 'deferred_tools_delta', text: TOOLS, origin: ENGINE } as never)
  expect(tools.text).toBe(TOOLS)
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
  on('model.complete', ($, e) => {
    const asked = String(e.prompt)
    const newest = /<prompt>([\s\S]*)<\/prompt>/.exec(asked)?.[1]
    const text = newest === undefined ? 'claude_in_chrome' : newest.includes('logs') ? 'datadog' : 'none'
    return { value: { isAnswered: true, text, usage: { inputTokens: 1, outputTokens: 1 } } } as never
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

test('never hides an always-kept item, and the classifier does not see it', { options: { alwaysKeep: 'local-tools update-config' } }, async ($, on) => {
  fakeStore(on, { alwaysKeep: ['slack'] })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  quiet(on)
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
  fakeTools(on)
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
  fakeTools(on)
  const store = fakeStore(on, { alwaysKeep: ['riff'] })
  await $.prompt.attachment({ type: 'skill_listing', text: SKILLS, origin: ENGINE } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    await ui.input({ key: 'filter', text: '', kind: 'change' })
    expect(JSON.stringify(await ui.drawn())).toContain('update-config')
    await ui.input({ key: 'filter', text: 'riff', kind: 'change' })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('[x] ')
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
