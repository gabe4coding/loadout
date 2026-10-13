import { expect, test } from 'claude-code/testing'

import {
  EFFORTS,
  MODEL_ID,
  MODELS,
  OPTION_DEFAULTS,
  capEffort,
  flipKeep,
  groupsWith,
  isAlwaysKept,
  isEffort,
  keptGroups,
  readOptions,
  wordList,
  isLoginOnly,
  isNewTask,
  listedSkillFacts,
  mcpTools,
  parseKeep,
  parseEffort,
  parseKept,
  parseSkills,
  parseTools,
  rebuild,
  serverDetail,
  serverFacts,
  serverLabel,
  skillDetail,
  splitMcpName,
  statusOf,
  takesTurnEffort,
  trimMcpInstructions,
  unseenGroups,
} from '../hooks/scope'

test('reads only known ids from a loose classifier reply', () => {
  const kept = parseKept('- `datadog`\n"slack", unknown\n\n  github  ', ['datadog', 'slack', 'github'])
  expect(kept).toEqual(['datadog', 'slack', 'github'])
})

test('reads the new-task verdict from the first line of a reply only', () => {
  expect(isNewTask('NEW TASK\ndatadog')).toBe(true)
  expect(isNewTask('\n- `New task.`')).toBe(true)
  expect(isNewTask('SAME TASK\nnone')).toBe(false)
  expect(isNewTask('datadog\nNEW TASK')).toBe(false)
  expect(isNewTask('not a new task')).toBe(false)
})

test('keeps core deferred tools whatever the classifier keeps', () => {
  const listing = parseTools('Head:\nWebFetch\nmcp__datadog__get_trace')
  const { text, hidden } = rebuild(listing, [], 'tools')
  expect(text).toContain('WebFetch')
  expect(hidden).toEqual(['mcp__datadog__get_trace'])
})

test('keeps the continuation lines of a skill with the skill', () => {
  const listing = parseSkills('Skills:\n- a: one\n  more of a\n- b: two')
  expect(listing.entries.map(entry => entry.lines.length)).toEqual([2, 1])
  expect(rebuild(listing, ['b'], 'skills').text).not.toContain('more of a')
})

test('keeps the MCP instructions of a server it does not know', () => {
  const text = '# MCP Server Instructions\n\n## datadog\nA\n\n## other\nB'
  const out = trimMcpInstructions(text, new Set(['datadog']))
  expect(out).not.toContain('A')
  expect(out).toContain('B')
})

test('trims MCP instructions that come as blocks with no header', () => {
  const out = trimMcpInstructions('## datadog\nA\n\n## other\nB', new Set(['datadog']))
  expect(out).toBe('## other\nB')
})

test('reads the alwaysKeep option with commas or spaces, each name once', () => {
  expect(parseKeep(' retro, kb-search  how-i-work,,retro\n')).toEqual(['retro', 'kb-search', 'how-i-work'])
  expect(parseKeep('')).toEqual([])
})

test('an always-keep name covers a server in any spelling, a skill or all skills of a plugin', () => {
  expect(isAlwaysKept('claude_in_chrome', 'tools', ['claude-in-chrome'])).toBe(true)
  expect(isAlwaysKept('retro:recall', 'skills', ['retro'])).toBe(true)
  expect(isAlwaysKept('retro:recall', 'skills', ['retro:recall'])).toBe(true)
  expect(isAlwaysKept('retro:recall', 'skills', ['recall'])).toBe(true)
  expect(isAlwaysKept('retro:recall', 'skills', ['other:recall'])).toBe(false)
  expect(isAlwaysKept('retroactive', 'skills', ['retro'])).toBe(false)
  expect(isAlwaysKept('slack', 'tools', ['retro'])).toBe(false)
})

test('setting a mark adds the group once, clearing it removes each name that covers it', () => {
  expect(flipKeep(['retro'], 'kb-search', 'skills', true)).toEqual(['retro', 'kb-search'])
  expect(flipKeep(['retro'], 'retro:recall', 'skills', true)).toEqual(['retro'])
  expect(flipKeep(['retro', 'kb-search'], 'retro:recall', 'skills', false)).toEqual(['kb-search'])
  expect(flipKeep(['Claude-In-Chrome'], 'claude_in_chrome', 'tools', false)).toEqual([])
})

test('groups only the MCP tools of the tool list, and finds the groups no decision covers', () => {
  const listing = mcpTools([
    { name: 'ToolSearch', mcp: false },
    { name: 'mcp__datadog__search_logs', mcp: true },
    { name: 'mcp__slack__send_message', mcp: true },
  ])
  expect(listing.entries.map(entry => entry.group)).toEqual(['datadog', 'slack'])
  expect(unseenGroups(listing, 'tools', { datadog: 'kept' })).toEqual(['slack'])
  expect(unseenGroups(listing, 'tools', { slack: 'hidden', datadog: 'always' })).toEqual([])
  expect(unseenGroups(listing, 'tools', null)).toEqual(['datadog', 'slack'])
})

test('a group with the name of an object key is unseen until a decision has it', () => {
  const listing = parseSkills('Skills:\n- constructor: Build things\n- toString: Print things')
  expect(unseenGroups(listing, 'skills', {})).toEqual(['constructor', 'toString'])
  expect(statusOf({}, 'constructor')).toBeUndefined()
  expect(statusOf(JSON.parse('{"__proto__":"hidden"}'), '__proto__')).toBe('hidden')
})

test('lists the groups of a decision by status, in the order seen', () => {
  const decision = { slack: 'hidden', datadog: 'always', github: 'kept', jira: 'hidden' } as const
  expect(keptGroups(decision)).toEqual(['datadog', 'github'])
  expect(groupsWith(decision, 'hidden')).toEqual(['slack', 'jira'])
  expect(groupsWith(null, 'hidden')).toEqual([])
})

test('names a claude.ai connector as the connector list does, and leaves other servers as they are', () => {
  expect(serverLabel('claude_ai_Google_Drive')).toBe('claude.ai Google Drive')
  expect(serverLabel('claude.ai Datadog')).toBe('claude.ai Datadog')
  expect(serverLabel('plugin_plain_plain')).toBe('plugin_plain_plain')
})

test('splits an MCP tool name into its server and tool', () => {
  expect(splitMcpName('mcp__claude_ai_Slack__send_message')).toEqual({ server: 'claude_ai_Slack', tool: 'send_message' })
  expect(splitMcpName('WebFetch')).toBeNull()
})

test('builds one fact per server, with the /mcp name and the tokens of its tools', () => {
  const facts = serverFacts(
    [
      { name: 'ToolSearch', mcp: false },
      { name: 'mcp__claude_ai_Slack__send_message', mcp: true },
      { name: 'mcp__claude_ai_Slack__read_channel', mcp: true },
      { name: 'mcp__plain__ask', mcp: true },
    ],
    [
      { name: 'mcp__claude_ai_Slack__send_message', serverName: 'claude_ai_Slack', tokens: 700 },
      { name: 'mcp__claude_ai_Slack__read_channel', serverName: 'claude_ai_Slack', tokens: 800 },
    ],
  )
  expect(facts).toEqual([
    { group: 'claude_ai_slack', label: 'claude.ai Slack', tools: ['send_message', 'read_channel'], tokens: 1500 },
    { group: 'plain', label: 'plain', tools: ['ask'], tokens: 0 },
  ])
})

test('describes a server by size and first tools, or as not logged in, and a skill by tokens and description', () => {
  const fact = { group: 'jira', label: 'Jira', tools: ['a', 'b', 'c', 'd'], tokens: 1234 }
  expect(serverDetail(fact)).toBe('4 tools · 1.2k tokens · a, b, c, …')
  expect(serverDetail({ ...fact, tools: ['complete_authentication', 'authenticate'], tokens: 0 })).toBe('2 tools · not logged in')
  expect(isLoginOnly(['authenticate'])).toBe(false)
  expect(skillDetail(40, 'Configure the harness')).toBe('40 tokens · Configure the harness')
  expect(skillDetail(0, '')).toBe('')
})

test('gives a skill fact the listed name that adds its plugin, when one name fits', () => {
  const fact = (name: string) => ({ name, tokens: 1, about: '' })
  const listed = ['anthropic-skills:docx', 'skill-creator:skill-creator', 'anthropic-skills:skill-creator', 'update-config']
  expect(listedSkillFacts([fact('docx'), fact('skill-creator:skill-creator'), fact('update-config'), fact('pdf')], listed).map(f => f.name)).toEqual([
    'anthropic-skills:docx',
    'skill-creator:skill-creator',
    'update-config',
    'pdf',
  ])
  expect(listedSkillFacts([fact('skill-creator')], listed).map(f => f.name)).toEqual(['skill-creator'])
})

test('reads one effort level from a reply, and caps it at the session level', () => {
  expect(parseEffort('high')).toBe('high')
  expect(parseEffort('`xhigh`.')).toBe('xhigh')
  expect(parseEffort('low or high')).toBe(null)
  expect(parseEffort('hard')).toBe(null)
  expect(capEffort('max', 'medium')).toBe('medium')
  expect(capEffort('low', 'high')).toBe('low')
  expect(capEffort('low', 5000)).toBe(null)
})

test('names each model and effort of a classifier reply in the prompt word list', () => {
  expect(wordList(EFFORTS)).toBe('low, medium, high, xhigh or max')
  expect(wordList(MODELS)).toBe('haiku, sonnet, opus or fable')
  expect(isEffort('xhigh')).toBe(true)
  expect(isEffort(3)).toBe(false)
})

test('every model the plugin routes to takes the effort in a message', () => {
  for (const id of Object.values(MODEL_ID)) expect(takesTurnEffort(id)).toBe(true)
})

test('reads each option with the type of its default, else the default', () => {
  expect(readOptions({})).toEqual(OPTION_DEFAULTS)
  expect(readOptions({ newTaskNote: 'no', effortPerPrompt: true, alwaysKeep: 'retro', traceFile: 3 })).toEqual({
    ...OPTION_DEFAULTS,
    effortPerPrompt: true,
    alwaysKeep: 'retro',
  })
})

test('changes the effort only on models that take it in a message', () => {
  expect(takesTurnEffort('claude-sonnet-5-5')).toBe(true)
  expect(takesTurnEffort('claude-opus-5-5[1m]')).toBe(true)
  expect(takesTurnEffort('claude-opus-5')).toBe(true)
  expect(takesTurnEffort('claude-sonnet-5')).toBe(false)
  expect(takesTurnEffort('claude-opus-4-8')).toBe(false)
  expect(takesTurnEffort('claude-opus-5-1')).toBe(false)
})
