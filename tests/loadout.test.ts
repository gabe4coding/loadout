import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

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

// The MCP tools as $.tool.list() gives them.
const LISTED = [
  { name: 'mcp__datadog__search_logs', description: 'Search logs', mcp: true },
  { name: 'mcp__claude-in-chrome__navigate', description: 'Open a page', mcp: true },
]

// The engine's own ui.status and ui.invalidate, which the kit leaves out.
function quiet(on: On): void {
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
}

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
  const composer = { kind: 'composer' } as const

  await $.prompt.submit({ text: 'Check the login page in the browser', wait: false, origin: composer } as never)
  const first = await $.prompt.attachment({ type: 'deferred_tools_delta', text: TOOLS, origin: ENGINE } as never)
  expect(first.text).not.toContain('mcp__datadog__search_logs')

  await $.prompt.submit({ text: 'Rename this variable', wait: false, origin: composer } as never)
  await $.prompt.submit({ text: 'Now look at the error logs for it', wait: false, origin: composer } as never)
  await $.prompt.submit({ text: 'And the logs from yesterday', wait: false, origin: composer } as never)

  expect(seen[1]).toEqual([])
  expect(seen[2]?.join('\n')).toContain('datadog (2 tools): search_logs, get_trace')
  expect(seen[2]?.join('\n')).toContain('ToolSearch')
  expect(seen[3]).toEqual([])
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
  on('tool.list', () => ({ value: [{ name: 'Read', description: 'Read a file', mcp: false }, ...LISTED] }))
  on('model.complete', ($, e) => {
    asked.push(String(e.prompt))
    return { value: { isAnswered: true, text: 'claude_in_chrome', usage: { inputTokens: 1, outputTokens: 1 } } } as never
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
  on('tool.list', () => ({ value: [{ name: 'ToolSearch', description: 'Load deferred tools', mcp: false }, ...LISTED] }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'claude_in_chrome', usage: { inputTokens: 1, outputTokens: 1 } },
  }) as never)

  await $.prompt.submit({ text: 'Check the login page in the browser', wait: false } as never)
  const delta = await $.prompt.attachment({ type: 'mcp_instructions_delta', text: BLOCKS, origin: ENGINE } as never)
  expect(delta.text).toContain('Chrome rules.')
  expect(delta.text).not.toContain('Datadog rules.')

  const tools = await $.prompt.attachment({ type: 'deferred_tools_delta', text: TOOLS, origin: ENGINE } as never)
  expect(tools.text).not.toContain('mcp__datadog__search_logs')
})
