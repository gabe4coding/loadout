import { expect, test } from 'claude-code/testing'

import { parseKept, parseSkills, parseTools, rebuild, trimMcpInstructions } from '../hooks/scope'

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
