// End-to-end smoke test: real headless Claude Code, this plugin and two fake
// MCP servers. The hooks tests fake Claude Code and the classifier. This test
// runs them all together, in one session with two prompts.
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
// keeps it.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}
const model = arg('--model', 'haiku')
const keep = process.argv.includes('--keep')
const TIMEOUT_MS = 300_000

const TRACKER = 'smoke_tracker'
const WEATHER = 'smoke_weather'
const tool = (server, name) => `mcp__${server}__${name}`
const sessionId = crypto.randomUUID()
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'context-scope-smoke-'))
const cwd = path.join(out, 'cwd')
fs.mkdirSync(cwd)
const calls = path.join(out, 'calls.jsonl')
const traceFile = path.join(out, 'trace.jsonl')
const mcp = path.join(out, 'mcp.json')
const fake = kind => ({ command: 'node', args: [path.join(ROOT, 'tests', 'fake-server.mjs')], env: { FAKE_KIND: kind, FAKE_LOG: calls } })
fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { [TRACKER]: fake('tracker'), [WEATHER]: fake('weather') } }))

// The first prompt names the tracker and nothing about weather. The second
// does not name a server: the note of the plugin points Claude to it.
const PROMPTS = [
  `List the open issues of project OPS in the issue tracker. Load ${tool(TRACKER, 'list_issues')} with ToolSearch, call it, and reply with the number of issues.`,
  'Now give me the weather forecast for Milan for tomorrow.',
]

const settings = { pluginConfigs: { 'context-scope': { options: { traceFile } } } }
const argv = [
  '-p',
  '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--restricted', '--strict-mcp-config', '--mcp-config', mcp,
  '--plugin-dir', ROOT,
  '--settings', JSON.stringify(settings),
  '--allowedTools', ['ToolSearch', tool(TRACKER, 'list_issues'), tool(WEATHER, 'get_forecast')].join(','),
  '--session-id', sessionId, '--max-budget-usd', '0.5',
  '--model', model,
]

// Sends each prompt after the result of the one before, so the second one is
// a later prompt of an idle session and not a message queued into a turn.
console.log(`claude -p with ${model}, into ${out}`)
const results = []
const exit = await new Promise(resolve => {
  // MCP tools go behind ToolSearch only when tool search is on: with two small
  // servers, the automatic rule keeps them in the prompt.
  const child = spawn('claude', argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ENABLE_TOOL_SEARCH: 'true' } })
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
  const ask = text => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`)
  readline.createInterface({ input: child.stdout }).on('line', line => {
    fs.appendFileSync(path.join(out, 'out.jsonl'), `${line}\n`)
    const msg = JSON.parse(line)
    if (msg.type !== 'result') return
    results.push(msg)
    if (results.length < PROMPTS.length) ask(PROMPTS[results.length])
    else child.stdin.end()
  })
  child.stderr.on('data', d => fs.appendFileSync(path.join(out, 'stderr.txt'), d))
  child.on('error', err => resolve(err.message))
  child.on('close', code => {
    clearTimeout(timer)
    resolve(code)
  })
  ask(PROMPTS[0])
})

const readLines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
const trace = readLines(traceFile)
const served = readLines(calls)
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
  'the plugin scopes the first tool listing': () => {
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

// Remove what the run saved outside its folder.
const projectDir = path.join(os.homedir(), '.claude', 'projects', fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'))
if (failed === 0 && !keep) {
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(out, { recursive: true, force: true })
} else {
  if (fs.existsSync(projectDir)) fs.cpSync(projectDir, path.join(out, 'transcript'), { recursive: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
  console.log(`run folder: ${out}`)
}
console.log(failed === 0 ? 'all passed' : `${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
