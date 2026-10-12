// Runs one real headless Claude Code session with this plugin and the fake MCP
// servers of tests/fake-server.mjs, for the smoke test and the /verify recipe.
// Each prompt goes in after the result of the one before, so a second prompt
// is a later prompt of an idle session. A prompt that starts with "/" runs a
// command. The plugin writes its trace (option traceFile) into the run folder.
//
// The run folder keeps out.jsonl (stream-json), stderr.txt, debug.log,
// trace.jsonl, calls.jsonl, transcript.jsonl and session/ (the subagent
// transcripts and tool results, when there are some). They move there from
// ~/.claude/projects, so a run leaves nothing else behind.

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// The fake servers. Their tools are in tests/fake-server.mjs (FAKE_KIND).
export const TRACKER = 'fake_tracker'
export const WEATHER = 'fake_weather'
const SERVERS = { [TRACKER]: 'tracker', [WEATHER]: 'weather' }
export const tool = (server, name) => `mcp__${server}__${name}`

const readLines = file =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []

export async function runSession({
  prompts,
  allow = [],
  settings = {},
  model = 'haiku',
  base = os.tmpdir(),
  prefix,
  toolSearch = true,
  timeoutMs = 300_000,
}) {
  const dir = fs.mkdtempSync(path.join(base, prefix))
  const cwd = path.join(dir, 'cwd')
  fs.mkdirSync(cwd)
  const file = name => path.join(dir, name)
  const sessionId = crypto.randomUUID()

  const servers = Object.fromEntries(
    Object.entries(SERVERS).map(([name, kind]) => [
      name,
      { command: 'node', args: [path.join(ROOT, 'tests', 'fake-server.mjs')], env: { FAKE_KIND: kind, FAKE_LOG: file('calls.jsonl') } },
    ]),
  )
  fs.writeFileSync(file('mcp.json'), JSON.stringify({ mcpServers: servers }))
  const options = { ...settings.pluginConfigs?.loadout?.options, traceFile: file('trace.jsonl') }
  const merged = { ...settings, pluginConfigs: { ...settings.pluginConfigs, loadout: { ...settings.pluginConfigs?.loadout, options } } }

  const argv = [
    '-p',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--restricted', '--strict-mcp-config', '--mcp-config', file('mcp.json'),
    '--plugin-dir', ROOT,
    '--settings', JSON.stringify(merged),
    '--allowedTools', ['ToolSearch', ...allow].join(','),
    '--debug-file', file('debug.log'),
    '--session-id', sessionId, '--max-budget-usd', '0.5',
    '--model', model,
  ]
  // MCP tools go behind ToolSearch only when tool search is on: with two small
  // servers, the automatic rule keeps them in the prompt.
  const env = { ...process.env, ENABLE_TOOL_SEARCH: toolSearch ? 'true' : 'false' }

  const results = []
  const out = fs.createWriteStream(file('out.jsonl'))
  const exit = await new Promise(resolve => {
    const child = spawn('claude', argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env })
    child.stderr.pipe(fs.createWriteStream(file('stderr.txt')))
    // A child that did not start fails the stdin write too: 'error' below
    // gives the reason.
    child.stdin.on('error', () => {})
    const timer = setTimeout(() => child.kill(), timeoutMs)
    const ask = text => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`)
    readline.createInterface({ input: child.stdout }).on('line', line => {
      out.write(`${line}\n`)
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.type !== 'result') return
      results.push(msg)
      if (results.length < prompts.length) ask(prompts[results.length])
      else child.stdin.end()
    })
    child.on('error', err => resolve(err.message))
    child.on('close', code => {
      clearTimeout(timer)
      out.end()
      resolve(code)
    })
    ask(prompts[0])
  })

  const projectDir = path.join(os.homedir(), '.claude', 'projects', fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'))
  const transcript = path.join(projectDir, `${sessionId}.jsonl`)
  if (fs.existsSync(transcript)) fs.copyFileSync(transcript, file('transcript.jsonl'))
  const sessionDir = path.join(projectDir, sessionId)
  if (fs.existsSync(sessionDir)) fs.cpSync(sessionDir, file('session'), { recursive: true })
  fs.rmSync(projectDir, { recursive: true, force: true })

  return {
    dir,
    exit,
    results,
    rows: readLines(file('transcript.jsonl')),
    trace: readLines(file('trace.jsonl')),
    calls: readLines(file('calls.jsonl')),
  }
}
