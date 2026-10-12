import { expect, test } from 'claude-code/testing'

import {
  flipKeep,
  isAlwaysKept,
  isLoginOnly,
  isNewTask,
  listedSkillFacts,
  mcpTools,
  parseKeep,
  parseKept,
  parseSkills,
  parseTools,
  rebuild,
  serverDetail,
  serverFacts,
  serverLabel,
  skillDetail,
  splitMcpName,
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
  expect(unseenGroups(listing, 'tools', { kept: ['datadog'], hidden: [] })).toEqual(['slack'])
  expect(unseenGroups(listing, 'tools', null)).toEqual(['datadog', 'slack'])
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
