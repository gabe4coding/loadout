#!/usr/bin/env node
// @ts-check
// Measures what the plugin changes in cost, speed and quality. Each task of
// evals/tasks.mjs runs as a real headless Claude Code session once per arm:
//
//   baseline  no plugin
//   loadout   the plugin with its defaults (listings only)
//   effort    + effortPerPrompt
//   model     + modelForSession (the question is answered "use the smaller model")
//   all       + both
//
// Cost is the session's own cost plus the classifier calls, which the session
// leaves out (the plugin traces their token use). Speed is the wall time from
// each prompt to its result. Quality is the task's checks on facts. The report
// compares each arm with the baseline per task, then takes the geometric mean
// over the tasks, so a long task does not outweigh a short one.
//
// It costs API usage: each session is one `claude -p` run. Usage: USAGE below.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import { readLines, runSession } from '../tests/session.mjs'
import { setup } from './fixture.mjs'
import { TASKS } from './tasks.mjs'

/** @typedef {import('../types').TraceLine} TraceLine */
/** @typedef {import('../types').Usage} Usage */
/** @typedef {{ id: string, about?: string, prompts: string[], check: (input: { calls: any[], answers: string[], cwd: string }) => string[] | Promise<string[]> }} Task */
/** @typedef {{ date: string, claude: string, model: string, effort: string, env: string, runs: number, arms: string[], tasks: string[] }} Meta */
// One line of results.jsonl: a session that ran (`error` says if it ended
// badly), or a session that threw, with only the fields that the progress line
// and the report read.
/** @typedef {Awaited<ReturnType<typeof runOne>>} Measured */
/** @typedef {Measured | Pick<Measured, 'task' | 'arm' | 'run' | 'failed' | 'totalUsd' | 'wallMs'> & { error: string }} Outcome */
/** @typedef {{ [K in keyof Measured]: Measured[K] extends number ? K : never }[keyof Measured]} NumberKey */

const HERE = path.dirname(fileURLToPath(import.meta.url))

const USAGE = `usage:
  node evals/impact.mjs [--arms baseline,loadout,effort,model,all] [--tasks id,id]
                        [--runs 2] [--jobs 4] [--model sonnet] [--effort high]
                        [--env fixed|real] [--budget 1] [--out <dir>] [--keep] [--dry-run]
  node evals/impact.mjs --report <dir>     write the report of a run folder again

  --env fixed   (default) only the fixture servers and skills, and no user settings.
                Policy settings of your organization still apply.
  --env real    also your own settings, plugins, skills and MCP servers.`

/** @type {Record<string, Partial<import('../types').Options> | null>} */
const ARMS = {
  baseline: null,
  loadout: {},
  effort: { effortPerPrompt: true },
  model: { modelForSession: true },
  all: { effortPerPrompt: true, modelForSession: true },
}

// USD per million tokens of the classifier's model (Haiku 5.5), by the alias
// that the plugin asks for.
/** @type {Record<string, Usage>} */
const CLASSIFIER_PRICES = { haiku: { input_tokens: 0.1, output_tokens: 0.5, cache_read_input_tokens: 0.01, cache_creation_input_tokens: 0.125 } }

/** @type {(msg: string) => never} */
const die = msg => {
  console.error(msg)
  process.exit(2)
}

let parsed
try {
  parsed = parseArgs({
    options: {
      arms: { type: 'string', default: Object.keys(ARMS).join(',') },
      tasks: { type: 'string' },
      runs: { type: 'string', default: '2' },
      jobs: { type: 'string', default: '4' },
      model: { type: 'string', default: 'sonnet' },
      effort: { type: 'string', default: 'high' },
      env: { type: 'string', default: 'fixed' },
      budget: { type: 'string', default: '1' },
      out: { type: 'string' },
      report: { type: 'string' },
      keep: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
} catch (err) {
  die(`${err instanceof Error ? err.message : err}\n${USAGE}`)
}
const flags = parsed.values
if (flags.help) die(USAGE)

if (flags.report) {
  const dir = path.resolve(flags.report)
  writeReport(dir, JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')), readLines(path.join(dir, 'results.jsonl')))
  process.exit(0)
}

const arms = flags.arms.split(',')
for (const arm of arms) if (!(arm in ARMS)) die(`unknown arm: ${arm}\n${USAGE}`)
const tasks = flags.tasks ? flags.tasks.split(',').map(id => TASKS.find(one => one.id === id) ?? die(`unknown task: ${id}`)) : TASKS
if (!['fixed', 'real'].includes(flags.env)) die(`--env must be fixed or real\n${USAGE}`)
const runs = Number(flags.runs)
const jobs = Number(flags.jobs)

// The baseline runs first in the list, but the order is shuffled: a slow
// minute of the API then hits all arms alike.
const plan = shuffle(tasks.flatMap(task => arms.flatMap(arm => Array.from({ length: runs }, (_, run) => ({ task, arm, run })))))
const sessions = plan.length
console.log(`${sessions} sessions: ${tasks.length} tasks x ${arms.length} arms x ${runs} runs, --model ${flags.model} --effort ${flags.effort}, env ${flags.env}`)
if (flags['dry-run']) process.exit(0)

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const out = path.resolve(flags.out ?? path.join(HERE, 'results', stamp))
fs.mkdirSync(path.join(out, 'sessions'), { recursive: true })
const meta = {
  date: new Date().toISOString(),
  claude: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
  model: flags.model,
  effort: flags.effort,
  env: flags.env,
  runs,
  arms,
  tasks: tasks.map(one => one.id),
}
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2))
console.log(`results: ${out}`)

// In the real setup, an installed copy of the plugin would run in every arm:
// turn it off, so only --plugin-dir decides.
const installed = flags.env === 'real' ? installedLoadout() : []

// The system prompt and the tools are the same in each session of an arm. The
// first session to send them pays to write them to the prompt cache, the
// others read them. One session per arm writes them before the measured runs,
// so the order of the runs does not decide which arm pays.
console.log('warm up: one session per arm')
await Promise.all(arms.map(arm => runOne({ task: { id: 'warmup', prompts: ['Reply with the word ready.'], check: () => [] }, arm, run: 0 })))

/** @type {Outcome[]} */
const records = []
await pool(plan, jobs, async job => {
  // A failed session is one error record, not the end of the run.
  /** @type {Outcome} */
  const record = await runOne(job).catch(err => ({ task: job.task.id, arm: job.arm, run: job.run, error: err.message, failed: [], totalUsd: 0, wallMs: 0 }))
  records.push(record)
  fs.appendFileSync(path.join(out, 'results.jsonl'), `${JSON.stringify(record)}\n`)
  const verdict = record.error ? `ERROR ${record.error}` : record.failed.length === 0 ? 'pass' : `FAIL ${record.failed.join('; ')}`
  console.log(`[${records.length}/${sessions}] ${job.task.id} ${job.arm} #${job.run}: $${record.totalUsd.toFixed(4)} ${(record.wallMs / 1000).toFixed(1)}s ${verdict}`)
})

writeReport(out, meta, records)

/** @param {{ task: Task, arm: string, run: number }} job */
async function runOne({ task, arm, run }) {
  const options = ARMS[arm]
  const settings = {
    ...(installed.length > 0 ? { enabledPlugins: Object.fromEntries(installed.map(name => [name, false])) } : {}),
    ...(options ? { pluginConfigs: { loadout: { options } } } : {}),
  }
  const session = await runSession({
    prompts: task.prompts,
    settings,
    model: flags.model,
    effort: flags.effort,
    base: path.join(out, 'sessions'),
    prefix: `${task.id}-${arm}-${run}-`,
    plugin: options !== null,
    serverModule: path.join(HERE, 'fixture.mjs'),
    setup,
    isolate: flags.env === 'fixed',
    strictMcp: flags.env === 'fixed',
    answer: true,
    // The model question: take the smaller model, whatever the order of the options.
    pick: labels => labels.find(label => label.startsWith('Use ')) ?? labels[0],
    // The project skills need a session without --restricted. No Bash still.
    restricted: false,
    disallow: ['Bash'],
    budgetUsd: Number(flags.budget),
    timeoutMs: 600_000,
  })
  const measured = measure(session)
  const cwd = path.join(session.dir, 'cwd')
  const error =
    session.exit !== 0 ? `exit ${session.exit}` : session.results.length < task.prompts.length ? `${session.results.length} of ${task.prompts.length} results` : null
  const failed = await task.check({ calls: session.calls, answers: measured.answers, cwd })
  if (!flags.keep && !error && failed.length === 0) fs.rmSync(session.dir, { recursive: true, force: true })
  return { task: task.id, arm, run, dir: session.dir, ...measured, error, failed }
}

// What one session cost, how long it took, and what the plugin did.
/** @param {Awaited<ReturnType<typeof runSession>>} session */
function measure({ results, out, trace }) {
  // Each result of a session reports the cost of the session so far.
  const sessionUsd = Math.max(0, ...results.map(r => r.total_cost_usd ?? 0))
  const classifier = trace.filter(t => t.event === 'classifier')
  const classifierUsd = classifier.reduce((sum, t) => sum + usd(t), 0)

  // The main requests, by message id: a reply spans one line per block.
  const main = out.filter(m => m.type === 'assistant' && m.message?.usage && m.parent_tool_use_id == null)
  const requests = new Map()
  for (const m of main) requests.set(m.message.id, { model: m.message.model, ...m.message.usage })
  const list = [...requests.values()]
  /** @type {(key: keyof Usage) => number} */
  const sum = key => list.reduce((s, u) => s + (u[key] ?? 0), 0)
  const first = list[0] ?? {}
  const toolUses = main.flatMap(m => m.message.content ?? []).filter(b => b.type === 'tool_use')
  const listings = trace.filter(t => t.event === 'listing' && t.isScoped)
  const init = out.find(m => m.type === 'system' && m.subtype === 'init')

  return {
    answers: results.map(r => String(r.result ?? '')),
    sessionUsd,
    classifierUsd,
    totalUsd: sessionUsd + classifierUsd,
    wallMs: results.reduce((s, r) => s + (r.wallMs ?? 0), 0),
    apiMs: results.reduce((s, r) => s + (r.duration_api_ms ?? 0), 0),
    requests: list.length,
    // The prompt of the first request: system prompt, tools and listings.
    firstPromptTokens: (first.input_tokens ?? 0) + (first.cache_read_input_tokens ?? 0) + (first.cache_creation_input_tokens ?? 0),
    inputTokens: sum('input_tokens'),
    cacheReadTokens: sum('cache_read_input_tokens'),
    cacheWriteTokens: sum('cache_creation_input_tokens'),
    outputTokens: sum('output_tokens'),
    models: [...new Set(list.map(u => u.model))],
    searches: toolUses.filter(b => ['ToolSearch', 'SearchSkills'].includes(b.name)).length,
    toolCalls: toolUses.length,
    hidden: listings.reduce((s, t) => s + (t.hidden?.length ?? 0), 0),
    efforts: trace.filter(t => t.event === 'effort_pick').map(t => t.picked),
    route: trace.find(t => t.event === 'model_route') ?? null,
    recalled: trace.filter(t => t.event === 'recall').flatMap(t => t.named),
    classifierCalls: classifier.length,
    plugins: init?.plugins?.map((/** @type {{ name: string }} */ p) => p.name) ?? [],
    skills: init?.skills?.length ?? 0,
    mcpServers: init?.mcp_servers?.length ?? 0,
  }
}

/** @param {Extract<TraceLine, { event: 'classifier' }>} line */
function usd({ model, usage }) {
  if (!usage) return 0
  const price = CLASSIFIER_PRICES[model]
  if (!price) throw new Error(`no price for the classifier model ${model}: add it to CLASSIFIER_PRICES`)
  const prices = /** @type {[keyof Usage, number][]} */ (Object.entries(price))
  return prices.reduce((s, [key, perMillion]) => s + ((usage[key] ?? 0) * perMillion) / 1e6, 0)
}

function installedLoadout() {
  const file = path.join(os.homedir(), '.claude', 'settings.json')
  try {
    return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).enabledPlugins ?? {}).filter(name => name.startsWith('loadout@'))
  } catch {
    return []
  }
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @param {(item: T) => Promise<void>} fn
 */
async function pool(items, size, fn) {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
  }))
}

/**
 * @template T
 * @param {T[]} list
 */
function shuffle(list) {
  const rest = [...list]
  const out = []
  while (rest.length > 0) out.push(...rest.splice(Math.floor(Math.random() * rest.length), 1))
  return out
}

// ---- report ----

/** @param {number[]} xs */
function mean(xs) {
  return xs.length === 0 ? NaN : xs.reduce((s, x) => s + x, 0) / xs.length
}

/** @param {number} x */
function pct(x) {
  return Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%` : 'n/a'
}

// The geometric mean over tasks of mean(arm) / mean(baseline): -20% means the
// arm costs a fifth less on a typical task.
/**
 * @param {Measured[]} done
 * @param {string} arm
 * @param {NumberKey} key
 */
function pairedChange(done, arm, key) {
  const ratios = []
  for (const task of new Set(done.map(r => r.task))) {
    /** @type {(name: string) => number[]} */
    const of = name => done.filter(r => r.task === task && r.arm === name).map(r => r[key])
    const [a, b] = [mean(of(arm)), mean(of('baseline'))]
    if (a > 0 && b > 0) ratios.push(Math.log(a / b))
  }
  return ratios.length === 0 ? NaN : Math.exp(mean(ratios)) - 1
}

/**
 * @param {string} dir
 * @param {Meta} meta
 * @param {Outcome[]} records
 */
function writeReport(dir, meta, records) {
  const arms = meta.arms.filter(arm => records.some(r => r.arm === arm))
  const tasks = meta.tasks.filter(task => records.some(r => r.task === task))
  const hasBase = arms.includes('baseline')
  const ran = records.filter(r => 'dir' in r)
  const done = ran.filter(r => !r.error)
  const lines = [
    '# loadout impact eval',
    '',
    `${meta.date} · ${meta.claude} · --model ${meta.model} --effort ${meta.effort} · env ${meta.env} · ${meta.runs} runs per task and arm`,
    '',
  ]
  const sample = done.find(r => r.arm === 'baseline') ?? done[0]
  if (sample) lines.push(`Session setup (baseline): ${sample.mcpServers} MCP servers, ${sample.skills} skills, plugins: ${sample.plugins.join(', ') || 'none'}.`, '')

  lines.push(
    '## Per arm',
    '',
    'Cost and time changes compare each task with its baseline, then take the geometric mean over the tasks. Before the runs, one session per arm wrote the shared prompt cache. Cost includes the classifier calls.',
    '',
    '| Arm | Sessions | Checks passed | Mean cost | Cost vs baseline | Classifier share | Mean time | Time vs baseline | First prompt tokens | Cache write tokens | Output tokens | Searches | Errors |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const arm of arms) {
    const all = records.filter(r => r.arm === arm)
    const rs = done.filter(r => r.arm === arm)
    const passed = rs.filter(r => r.failed.length === 0).length
    /** @type {(key: NumberKey) => number} */
    const avg = key => mean(rs.map(r => r[key]))
    const cost = avg('totalUsd')
    const share = avg('classifierUsd') / cost
    /** @type {(key: NumberKey) => string} */
    const vs = key => (arm === 'baseline' || !hasBase ? '' : pct(pairedChange(done, arm, key)))
    lines.push(
      `| ${arm} | ${all.length} | ${passed}/${rs.length} | $${cost.toFixed(4)} | ${vs('totalUsd')} | ${arm === 'baseline' ? '' : `${(share * 100).toFixed(1)}%`} | ${(avg('wallMs') / 1000).toFixed(1)}s | ${vs('wallMs')} | ${Math.round(avg('firstPromptTokens'))} | ${Math.round(avg('cacheWriteTokens'))} | ${Math.round(avg('outputTokens'))} | ${avg('searches').toFixed(1)} | ${all.length - rs.length} |`,
    )
  }

  lines.push('', '## Per task', '', 'Each cell: checks passed / sessions, mean cost, mean time.', '', `| Task | What it tests | ${arms.join(' | ')} |`, `| --- | --- | ${arms.map(() => '---').join(' | ')} |`)
  for (const task of tasks) {
    const cells = arms.map(arm => {
      const rs = done.filter(r => r.task === task && r.arm === arm)
      if (rs.length === 0) return 'n/a'
      return `${rs.filter(r => r.failed.length === 0).length}/${rs.length} · $${mean(rs.map(r => r.totalUsd)).toFixed(4)} · ${(mean(rs.map(r => r.wallMs)) / 1000).toFixed(0)}s`
    })
    lines.push(`| ${task} | ${TASKS.find(one => one.id === task)?.about ?? ''} | ${cells.join(' | ')} |`)
  }

  const switches = ran.filter(r => r.efforts.length > 0 || r.route)
  if (switches.length > 0) {
    lines.push('', '## Effort and model picks', '', '| Task | Arm | Run | Effort picks | Model | Models that answered |', '| --- | --- | --- | --- | --- | --- |')
    for (const r of switches) {
      const route = r.route ? `${r.route.from} → ${r.route.to}${r.route.isUsed ? '' : ' (not used)'}` : ''
      lines.push(`| ${r.task} | ${r.arm} | ${r.run} | ${r.efforts.join(', ')} | ${route} | ${r.models.join(', ')} |`)
    }
  }

  const bad = records.filter(r => r.error || r.failed.length > 0)
  if (bad.length > 0) {
    lines.push('', '## Failed checks and errors', '')
    for (const r of bad) lines.push(`- ${r.task} · ${r.arm} · run ${r.run}: ${r.error ?? r.failed.join('; ')}${'dir' in r ? ` (${r.dir})` : ''}`)
  }

  const text = `${lines.join('\n')}\n`
  fs.writeFileSync(path.join(dir, 'report.md'), text)
  console.log(`\n${text}`)
}
