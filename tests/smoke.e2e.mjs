// End-to-end smoke test: real headless Claude Code, this plugin and two fake
// MCP servers. The hooks tests fake Claude Code and the classifier. This test
// runs them all together: one session with two prompts, and one session with
// tool search off.
//
//   node tests/smoke.e2e.mjs                   one run with Haiku
//   node tests/smoke.e2e.mjs --model sonnet --keep
//
// It needs a logged-in Claude Code and costs API usage, so CI does not run it.
// The checks read the trace file of the plugin and the calls that the fake
// servers got, never the words of the model. The transcript keeps a listing as
// Claude Code made it, not as the plugin answered it, hence the trace. If a
// check says that the model or the classifier did not do a step, run the test
// again: both are models. --keep keeps the run folder; a failed run always
// keeps it. tests/session.mjs starts the session.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { runSession, tool, TRACKER, WEATHER } from './session.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}
const model = arg('--model', 'haiku')
const keep = process.argv.includes('--keep')

// The first prompt names the tracker and nothing about weather. The second
// does not name a server: the note of the plugin points Claude to it.
const PROMPTS = [
  `List the open issues of project OPS in the issue tracker. Load ${tool(TRACKER, 'list_issues')} with ToolSearch, call it, and reply with the number of issues.`,
  'Now give me the weather forecast for Milan for tomorrow.',
]

// A second session with tool search off: Claude Code puts the MCP tools in
// the prompt and builds no tool listing. Claude sees every server's tools, so
// the plugin must keep every instruction block.
console.log(`claude -p with ${model}, two sessions`)
const [{ dir: out, exit, results, trace, calls: served }, off] = await Promise.all([
  runSession({
    prompts: PROMPTS,
    allow: [tool(TRACKER, 'list_issues'), tool(WEATHER, 'get_forecast')],
    model,
    prefix: 'loadout-smoke-',
  }),
  runSession({
    prompts: ['List the open issues of project OPS in the issue tracker.'],
    allow: [tool(TRACKER, 'list_issues')],
    model,
    prefix: 'loadout-smoke-off-',
    toolSearch: false,
  }),
])
const toolListings = trace.filter(t => t.event === 'listing' && t.type === 'deferred_tools_delta')
const scoped = toolListings.find(t => t.isScoped)
const shown = value => JSON.stringify(value)

const cases = {
  'claude -p ends with no error, after two prompts': () => {
    assert.equal(exit, 0, `exit ${exit}, see stderr.txt`)
    assert.equal(results.length, PROMPTS.length, `results: ${results.length}`)
    for (const result of results) assert.equal(result.is_error, false, result.result)
  },

  // The open question of the design: does the first prompt reach the plugin
  // before Claude Code builds the first tool listing?
  'the plugin changes the first tool listing': () => {
    assert.ok(toolListings.length > 0, `no tool listing in the trace (is ToolSearch on?): ${shown(trace)}`)
    assert.equal(toolListings[0].isScoped, true, `Claude Code built the first tool listing before the first prompt reached the plugin: ${shown(toolListings)}`)
  },

  'the classifier keeps the tracker and hides the weather tools': () => {
    assert.ok(scoped, `no scoped tool listing: ${shown(toolListings)}`)
    assert.ok(scoped.kept.includes(TRACKER), `kept: ${shown(scoped.kept)}`)
    assert.ok(scoped.hidden.includes(tool(WEATHER, 'get_forecast')), `hidden: ${shown(scoped.hidden)}`)
  },

  'the first task reaches the tracker server': () => {
    assert.deepEqual(served.filter(c => c.tool === 'list_issues').map(c => c.args), [{ project: 'OPS' }])
  },

  'the instructions of the hidden server are removed': () => {
    const events = trace.filter(t => t.event === 'mcp_instructions')
    assert.ok(events.some(t => t.removed.includes(WEATHER)), `mcp_instructions: ${shown(events)}`)
    assert.ok(!events.some(t => t.removed.includes(TRACKER)), `mcp_instructions: ${shown(events)}`)
  },

  'the later prompt gets a note for the weather tools': () => {
    const recalls = trace.filter(t => t.event === 'recall')
    assert.ok(recalls.some(t => t.named.includes(WEATHER)), `recall: ${shown(recalls)}`)
    for (const t of recalls) assert.equal(new Set(t.named).size, t.named.length, `a group named twice: ${shown(t)}`)
  },

  'Claude loads the hidden tool and calls it': () => {
    assert.ok(served.some(c => c.tool === 'get_forecast'), `calls: ${shown(served)}`)
  },

  'with tool search off, all instruction blocks stay': () => {
    assert.equal(off.exit, 0, `exit ${off.exit}, see ${off.dir}/stderr.txt`)
    assert.ok(!off.trace.some(t => t.type === 'deferred_tools_delta'), `a tool listing with tool search off: ${shown(off.trace)}`)
    const events = off.trace.filter(t => t.event === 'mcp_instructions')
    assert.ok(events.length > 0, `no mcp_instructions in the trace: ${shown(off.trace)}`)
    for (const t of events) assert.deepEqual(t.removed, [], `mcp_instructions: ${shown(events)}`)
  },
}

let failed = 0
for (const [name, fn] of Object.entries(cases)) {
  try {
    await fn()
    console.log(`pass  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`)
  }
}

for (const dir of [out, off.dir]) {
  if (failed === 0 && !keep) fs.rmSync(dir, { recursive: true, force: true })
  else console.log(`run folder: ${dir}`)
}
console.log(failed === 0 ? 'all passed' : `${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
