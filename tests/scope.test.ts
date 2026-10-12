import { expect, test } from 'claude-code/testing'

import { flipKeep, isAlwaysKept, mcpTools, parseKeep, parseKept, parseSkills, parseTools, rebuild, trimMcpInstructions, unseenGroups } from '../hooks/scope'

test('reads only known ids from a loose classifier reply', () => {
  const kept = parseKept('- `datadog`\n"slack", unknown\n\n  github  ', ['datadog', 'slack', 'github'])
  expect(kept).toEqual(['datadog', 'slack', 'github'])
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
