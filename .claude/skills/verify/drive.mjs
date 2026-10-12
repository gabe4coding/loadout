#!/usr/bin/env node
// Drives this plugin in real Claude Code against the fake MCP servers, for
// /verify. One run is one headless session: each prompt goes in after the
// result of the one before. A prompt that starts with "/" runs a command
// (`/loadout`, `/loadout off`). `run` prints the evidence as JSON and keeps
// the run folder (its path is `dir`). Usage: USAGE below.

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { runSession } from '../../../tests/session.mjs'

const USAGE = `usage:
  node drive.mjs run "<prompt>" ["<prompt>" ...] [--allow t1,t2]
                     [--settings <json>] [--model haiku] [--base <dir>]
                     [--no-tool-search]
  node drive.mjs clean <dir>`
const PREFIX = 'loadout-verify-'

const die = msg => {
  console.error(msg)
  process.exit(2)
}
let parsed
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      allow: { type: 'string' },
      settings: { type: 'string' },
      model: { type: 'string' },
      base: { type: 'string' },
      'no-tool-search': { type: 'boolean' },
    },
  })
} catch (err) {
  die(`${err.message}\n${USAGE}`)
}
const { values: flags, positionals: [cmd, ...prompts] } = parsed
const cut = (text, n = 800) => (text.length > n ? `${text.slice(0, n)}… (${text.length} chars)` : text)

// What the run shows at its surfaces: the reply or command output of each
// prompt, the plugin's decisions, the notes Claude read, the tool calls, what
// reached the servers, and each request's token use (a cache read that grows
// from request to request shows that the listings did not change).
function evidence(run) {
  const blocks = run.rows.flatMap(r => (Array.isArray(r.message?.content) ? r.message.content : []))
  const requests = new Map()
  for (const r of run.rows) {
    const u = r.message?.usage
    if (r.type === 'assistant' && u) requests.set(r.message.id, { input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens })
  }
  const debug = path.join(run.dir, 'debug.log')
  return {
    dir: run.dir,
    exit: run.exit,
    turns: run.results.map((r, i) => ({ prompt: prompts[i], isError: r.is_error, result: cut(String(r.result ?? '')), totalCostUsd: r.total_cost_usd })),
    trace: run.trace,
    notes: run.rows.filter(r => r.attachment?.type === 'hook_additional_context' && r.attachment.hookName === 'prompt.submit').flatMap(r => r.attachment.content),
    toolUses: blocks.filter(b => b.type === 'tool_use').map(b => ({ name: b.name, input: b.input })),
    toolResults: blocks.filter(b => b.type === 'tool_result').map(b => cut(typeof b.content === 'string' ? b.content : (b.content ?? []).map(c => c.text ?? '').join('\n'))),
    calls: run.calls,
    requests: [...requests.values()],
    // What the engine said about the plugin: a skipped or bypassed hook, a
    // module that did not load. Each line once, without its time stamp.
    pluginLog: fs.existsSync(debug)
      ? [...new Set(fs.readFileSync(debug, 'utf8').split('\n').filter(l => /\bloadout: /.test(l)).map(l => l.replace(/^\S+ /, '')))]
      : [],
  }
}

if (cmd === 'run') {
  if (prompts.length === 0) die('run needs at least one prompt')
  const run = await runSession({
    prompts,
    allow: flags.allow ? flags.allow.split(',') : [],
    settings: flags.settings ? JSON.parse(flags.settings) : {},
    model: flags.model,
    base: flags.base,
    prefix: PREFIX,
    toolSearch: !flags['no-tool-search'],
  })
  console.log(JSON.stringify(evidence(run), null, 2))
} else if (cmd === 'clean') {
  const dir = prompts[0] ?? die('clean needs the run folder')
  if (!path.basename(dir).startsWith(PREFIX)) die(`not a run folder: ${dir}`)
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`removed ${dir}`)
} else {
  die(USAGE)
}
