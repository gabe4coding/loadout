// Runs one real headless Claude Code session with this plugin and the fake MCP
// servers of tests/fake-server.mjs, for the smoke test and the /verify recipe.
// Each prompt goes in after the result of the one before, so a second prompt
// is a later prompt of an idle session. A prompt that starts with "/" runs a
// command. The plugin writes its trace (option traceFile) into the run folder.
//
// The eval (evals/impact.mjs) also starts sessions here: with no plugin or
// other servers, isolated from the user's settings, and with `answer` on, which
// answers each permission ask, and each question with `pick` (the first option
// by default). Without it a question of the plugin fails in a -p run.
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
const FAKE_SERVER = path.join(ROOT, 'tests', 'fake-server.mjs')
export const tool = (server, name) => `mcp__${server}__${name}`

export const readLines = file =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []

// Answers a permission ask of the session: it allows each tool, and answers
// each question with the label that `pick` chooses from its option labels.
function allowTool({ tool_name: name, input = {} }, pick) {
  if (name !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input }
  const answers = Object.fromEntries((input.questions ?? []).map(q => [q.question, pick((q.options ?? []).map(o => o.label)) ?? '']))
  return { behavior: 'allow', updatedInput: { ...input, answers } }
}

export async function runSession({
  prompts,
  allow = [],
  settings = {},
  model = 'haiku',
  effort,
  base = os.tmpdir(),
  prefix,
  toolSearch = true,
  timeoutMs = 300_000,
  budgetUsd = 0.5,
  // false: the session runs without this plugin.
  plugin = true,
  // The module that defines other fake servers, one per kind. Without it,
  // the two servers of tests/fake-server.mjs.
  serverModule,
  // Fills the working folder before the session starts.
  setup = () => {},
  // Load only the project and local settings, not the user's.
  isolate = false,
  // Only the fake servers, not the user's MCP servers.
  strictMcp = true,
  answer = false,
  pick = labels => labels[0],
  // --restricted removes Bash, and also the project skills.
  restricted = true,
  disallow = [],
}) {
  const dir = fs.mkdtempSync(path.join(base, prefix))
  const cwd = path.join(dir, 'cwd')
  fs.mkdirSync(cwd)
  setup(cwd)
  const file = name => path.join(dir, name)
  const sessionId = crypto.randomUUID()

  const fakeEnv = { FAKE_LOG: file('calls.jsonl'), ...(serverModule ? { FAKE_SERVERS: serverModule } : {}) }
  const servers = serverModule ? Object.fromEntries(Object.keys((await import(serverModule)).SERVERS).map(kind => [kind, kind])) : SERVERS
  const mcpServers = Object.fromEntries(
    Object.entries(servers).map(([name, kind]) => [name, { command: 'node', args: [FAKE_SERVER], env: { ...fakeEnv, FAKE_KIND: kind } }]),
  )
  fs.writeFileSync(file('mcp.json'), JSON.stringify({ mcpServers }))
  const options = { ...settings.pluginConfigs?.loadout?.options, traceFile: file('trace.jsonl') }
  const merged = { ...settings, pluginConfigs: { ...settings.pluginConfigs, loadout: { ...settings.pluginConfigs?.loadout, options } } }

  const argv = [
    '-p',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ...(restricted ? ['--restricted'] : []),
    ...(disallow.length > 0 ? ['--disallowedTools', disallow.join(',')] : []),
    ...(strictMcp ? ['--strict-mcp-config'] : []), '--mcp-config', file('mcp.json'),
    ...(plugin ? ['--plugin-dir', ROOT] : []),
    ...(isolate ? ['--setting-sources', 'project,local'] : []),
    ...(answer ? ['--permission-prompt-tool', 'stdio'] : []),
    '--settings', JSON.stringify(merged),
    '--allowedTools', ['ToolSearch', ...allow].join(','),
    '--debug-file', file('debug.log'),
    '--session-id', sessionId, '--max-budget-usd', String(budgetUsd),
    '--model', model,
    ...(effort ? ['--effort', effort] : []),
  ]
  // MCP tools go behind ToolSearch only when tool search is on: with two small
  // servers, the automatic rule keeps them in the prompt.
  const env = { ...process.env, ENABLE_TOOL_SEARCH: toolSearch ? 'true' : 'false' }

  const results = []
  const stream = []
  const out = fs.createWriteStream(file('out.jsonl'))
  const exit = await new Promise(resolve => {
    const child = spawn('claude', argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env })
    child.stderr.pipe(fs.createWriteStream(file('stderr.txt')))
    // A child that did not start fails the stdin write too: 'error' below
    // gives the reason.
    child.stdin.on('error', () => {})
    const timer = setTimeout(() => child.kill(), timeoutMs)
    const send = msg => child.stdin.write(`${JSON.stringify(msg)}\n`)
    let sentAt = 0
    const ask = text => {
      sentAt = Date.now()
      send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
    }
    readline.createInterface({ input: child.stdout }).on('line', line => {
      out.write(`${line}\n`)
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      stream.push(msg)
      if (msg.type === 'control_request') {
        const { request_id, request } = msg
        const response = request.subtype === 'can_use_tool'
          ? { subtype: 'success', request_id, response: allowTool(request, pick) }
          : { subtype: 'error', request_id, error: `not handled: ${request.subtype}` }
        send({ type: 'control_response', response })
        return
      }
      if (msg.type !== 'result') return
      results.push({ ...msg, wallMs: Date.now() - sentAt })
      if (results.length < prompts.length) ask(prompts[results.length])
      else child.stdin.end()
    })
    child.on('error', err => resolve(err.message))
    child.on('close', code => {
      clearTimeout(timer)
      out.end()
      resolve(code)
    })
    // The control channel starts with a handshake.
    if (answer) send({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })
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
    out: stream,
    rows: readLines(file('transcript.jsonl')),
    trace: readLines(file('trace.jsonl')),
    calls: readLines(file('calls.jsonl')),
  }
}
