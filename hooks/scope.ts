// Pure text work: parse the listings the engine injects, group their entries,
// and rebuild them with only the groups the classifier kept.

// A deferred tool line is one bare name; an MCP tool is mcp__<server>__<tool>.
const TOOL_LINE = /^[A-Za-z0-9_.:-]+$/
const SKILL_LINE = /^- ([^\s:]+(?::[^\s:]+)?)(?::\s|$)/

export const CORE = 'core'

export function toolGroup(name: string): string {
  const match = /^mcp__(.+?)__/.exec(name)
  return match?.[1] ? normalize(match[1]) : CORE
}

export function normalize(server: string): string {
  return server.toLowerCase().replace(/[^a-z0-9]+/g, '_')
}

export type Entry = { name: string; group: string; lines: string[] }
export type Listing = { head: string[]; entries: Entry[]; tail: string[] }

export function parseTools(text: string): Listing {
  const head: string[] = []
  const entries: Entry[] = []
  const tail: string[] = []
  for (const line of text.split('\n')) {
    const name = line.trim()
    if (TOOL_LINE.test(name)) {
      entries.push({ name, group: toolGroup(name), lines: [line] })
    } else if (entries.length === 0) {
      head.push(line)
    } else {
      tail.push(line)
    }
  }
  return { head, entries, tail }
}

// Each skill is its own group: unprefixed user skills would otherwise be one
// group that is always kept.
export function parseSkills(text: string): Listing {
  const head: string[] = []
  const entries: Entry[] = []
  for (const line of text.split('\n')) {
    const name = SKILL_LINE.exec(line)?.[1]
    const last = entries[entries.length - 1]
    if (name) {
      entries.push({ name, group: name, lines: [line] })
    } else if (last) {
      last.lines.push(line)
    } else {
      head.push(line)
    }
  }
  return { head, entries, tail: [] }
}

// One catalog row per group the classifier may drop. `core` tools are never
// offered: they are few and cheap.
export type Row = { group: string; row: string }

export function toolCatalog(listing: Listing): Row[] {
  const byGroup = new Map<string, string[]>()
  for (const entry of listing.entries) {
    if (entry.group === CORE) continue
    const short = entry.name.replace(/^mcp__.+?__/, '')
    byGroup.set(entry.group, [...(byGroup.get(entry.group) ?? []), short])
  }
  return [...byGroup].map(([group, tools]) => ({
    group,
    row: `${group} (${tools.length} tools): ${tools.slice(0, 10).join(', ')}`,
  }))
}

export function skillCatalog(listing: Listing): Row[] {
  return listing.entries.map(entry => ({
    group: entry.group,
    row: entry.lines.join(' ').slice(2, 160).replace(/\s+/g, ' '),
  }))
}

export function groupsOf(listing: Listing, kind: 'tools' | 'skills'): string[] {
  const groups = new Set(listing.entries.map(entry => entry.group))
  if (kind === 'tools') groups.delete(CORE)
  return [...groups]
}

// Reads the classifier's reply: one group id per line, anything else ignored.
export function parseKept(reply: string, groups: readonly string[]): string[] {
  const known = new Set(groups)
  return reply
    .split(/[\n,]/)
    .map(part => part.trim().replace(/^[-*\s`"]+|[`"\s]+$/g, ''))
    .filter(part => known.has(part))
}

export function rebuild(
  listing: Listing,
  kept: readonly string[],
  kind: 'tools' | 'skills',
): { text: string; hidden: string[] } {
  const keep = new Set(kept)
  if (kind === 'tools') keep.add(CORE)
  const shown = listing.entries.filter(entry => keep.has(entry.group))
  const dropped = listing.entries.filter(entry => !keep.has(entry.group))
  const lines = [...listing.head, ...shown.flatMap(entry => entry.lines)]
  if (dropped.length > 0) lines.push(note(dropped, kind))
  lines.push(...listing.tail)
  return { text: lines.join('\n'), hidden: dropped.map(entry => entry.name) }
}

function note(dropped: Entry[], kind: 'tools' | 'skills'): string {
  if (kind === 'skills') {
    return `(context-scope hid ${dropped.length} more skills that look unrelated to this task. They still work: find one with SearchSkills or ListSkills, or call Skill with its name.)`
  }
  const counts = new Map<string, number>()
  for (const entry of dropped) counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1)
  const groups = [...counts].map(([group, n]) => `${group} (${n})`).join(', ')
  return `(context-scope hid ${dropped.length} more deferred tools that look unrelated to this task, from: ${groups}. They still work: ToolSearch finds them by keyword.)`
}

// Drops the "## <server>" blocks of the MCP instructions for the hidden
// servers. A server it does not know stays.
export function trimMcpInstructions(text: string, hiddenGroups: ReadonlySet<string>): string {
  // The system prompt section has this header. An attachment has the blocks
  // alone.
  const start = Math.max(0, text.indexOf('# MCP Server Instructions'))
  if (hiddenGroups.size === 0) return text
  const before = text.slice(0, start)
  const blocks = text.slice(start).split(/\n(?=## )/)
  const kept = blocks.filter(block => {
    const match = /^## (.+)$/m.exec(block)
    return !(block.startsWith('## ') && match?.[1] && hiddenGroups.has(normalize(match[1])))
  })
  return before + kept.join('\n')
}

// The "## <server>" headers of `before` that `after` lacks.
export function removedServers(before: string, after: string): string[] {
  const headers = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map(match => match[1] ?? '')
  const kept = new Set(headers(after))
  return headers(before).filter(header => !kept.has(header))
}
