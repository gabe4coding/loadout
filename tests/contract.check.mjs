// The contracts that the type check cannot see, and the ratchets that keep
// out the patterns it cannot forbid. Each message says what to use instead,
// where a good example is, and why.
//
// Checked here:
// - The options of .claude-plugin/plugin.json are the options the hooks read
//   (OPTION_DEFAULTS in hooks/scope.ts), with the same defaults and types.
// - register reads its raw options only through readOptions.
// - commands/loadout.md shows the words of COMMANDS in hooks/scope.ts.
// - No `as never` or `as unknown as` in hooks/, and no cast but `as const` in
//   tests/.
// - No module-level `let`, or `const` Set, Map or array, in hooks/ outside
//   the allowed ones, exported or not.
// - No two-way branch on a kind (`kind === 'tools'`): use a Record<Kind, ...>.
//
//   node tests/contract.check.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')
const filesIn = (dir, pattern) =>
  fs.readdirSync(path.join(ROOT, dir)).filter(f => pattern.test(f)).sort().map(f => `${dir}/${f}`)

const MANIFEST = '.claude-plugin/plugin.json'
const REGISTER = 'hooks/register.tsx'
const COMMAND_DOC = 'commands/loadout.md'
const HOOKS = filesIn('hooks', /\.tsx?$/)
const TESTS = filesIn('tests', /\.tsx?$/)
const TYPED = [...HOOKS, ...TESTS]
// The module-level state that each hooks file may have. register: the
// per-session state, and the queue of the trace file, which all sessions share.
const ALLOWED_STATE = { [REGISTER]: ['local', 'traceQueue'] }

const lineOf = (text, index) => text.slice(0, index).split('\n').length

function optionProblems(manifest, defaults) {
  const options = manifest.userConfig ?? {}
  const problems = []
  const fix = 'Change OPTION_DEFAULTS in hooks/scope.ts and "userConfig" in .claude-plugin/plugin.json together'
  for (const [key, spec] of Object.entries(options)) {
    if (!(key in defaults)) problems.push(`option "${key}" is in ${MANIFEST} but not in OPTION_DEFAULTS. ${fix}. Why: the hooks would not read it.`)
    else if (spec.default !== defaults[key] || spec.type !== typeof defaults[key]) {
      problems.push(`option "${key}": ${MANIFEST} has ${spec.type} ${JSON.stringify(spec.default)}, OPTION_DEFAULTS has ${typeof defaults[key]} ${JSON.stringify(defaults[key])}. ${fix}. Why: a missing setting must act as the manifest says.`)
    }
  }
  for (const key of Object.keys(defaults)) {
    if (!(key in options)) problems.push(`option "${key}" is in OPTION_DEFAULTS but not in ${MANIFEST}. ${fix}. Why: a person cannot set it.`)
  }
  return problems
}

// The text with each comment line blanked, so an index is still that of `text`.
const codeOf = text => text.replace(/^\s*\/\/.*$/gm, line => ' '.repeat(line.length))

// register names its raw options in `(on, <name>)` and reads them on one line
// only, with readOptions(<name>).
function optionReadProblems(file, text) {
  const name = /: Register = \(on, (\w+)\)/.exec(text)?.[1]
  if (name === undefined) return [`${file}: no "register: Register = (on, <options>)" found. Why: the check must know the name of the raw options.`]
  const rest = codeOf(text).replace(new RegExp(`\\(on, ${name}\\)|readOptions\\(${name}\\)`, 'g'), allowed => ' '.repeat(allowed.length))
  return [...rest.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].map(
    m => `${file}:${lineOf(text, m.index)}: reads the raw options. Read them with readOptions(${name}) from hooks/scope.ts, as register does. Why: it gives each option the type and the default of the manifest.`,
  )
}

// The front matter of commands/loadout.md shows each word of COMMANDS, as the
// command that register adds does.
function commandDocProblems(doc, commands) {
  const field = key => new RegExp(`^${key}: (.*)$`, 'm').exec(doc)?.[1]
  const want = {
    description: `Show the loadout of this session. Also: ${Object.values(commands).join(', ')}`,
    'argument-hint': JSON.stringify(`[${Object.keys(commands).join('|')}]`),
  }
  return Object.entries(want)
    .filter(([key, text]) => field(key) !== text)
    .map(([key, text]) => `${COMMAND_DOC}: ${key} is ${JSON.stringify(field(key))}, want ${JSON.stringify(text)}. Change it with COMMANDS in hooks/scope.ts. Why: the typeahead shows this file before the plugin adds its own command.`)
}

function castProblems(file, text) {
  // In tests/ every cast is out but `as const`. The hooks need a few narrow
  // ones (`as ModelTier[]`), but never the two that turn off the check.
  const pattern = file.startsWith('tests/') ? /\bas (?!const\b)(?:[A-Z{[]|never\b|unknown\b|any\b|string\b|number\b|boolean\b)\S*/g : /\bas never\b|\bas unknown as\b/g
  return [...codeOf(text).matchAll(pattern)].map(
    m => `${file}:${lineOf(text, m.index)}: "${m[0]}". Build the value with its engine type: use the builders in tests/kit.ts (submit, attach, command, answer, breakdown) or add one there, and \`satisfies\` for a literal. Why: a cast hides a field that the engine renamed, and the test then passes on a wrong shape.`,
  )
}

function moduleStateProblems(file, text) {
  return [...text.matchAll(/^(?:export )?(?:let (\w+)|const (\w+)(?::[^=]+)? = (?:new (?:Set|Map|WeakMap|WeakSet|Array)\b|\[\]))/gm)]
    .filter(m => !(ALLOWED_STATE[file] ?? []).includes(m[1] ?? m[2]))
    .map(
      m => `${file}:${lineOf(text, m.index)}: module-level state "${m[0]}". Put session state in the Local type and freshLocal() of hooks/register.tsx, or in a $.state atom. Why: session.start resets only those, so a module variable keeps the state of an earlier session.`,
    )
}

function kindBranchProblems(file, text) {
  return [...codeOf(text).matchAll(/\bkind\s*[!=]==?\s*['"](?:tools|skills)['"]|['"](?:tools|skills)['"]\s*[!=]==?\s*[\w.]*\bkind\b/g)].map(
    m => `${file}:${lineOf(text, m.index)}: "${m[0]}". Use a Record<Kind, ...> map (CATALOG in hooks/scope.ts), or a switch with \`default: return kind satisfies never\` (readDecision in hooks/register.tsx). Why: a two-way branch sends a new kind to the wrong side with no error.`,
  )
}

const all = (files, scan) => files.flatMap(file => scan(file, read(file)))

const tests = {
  'the checks catch each mistake, and pass the good form': async () => {
    const bad = [
      ...castProblems('x.ts', "submit({ text: 'a' } as never)\nconst y = z as unknown as Y"),
      ...castProblems('tests/x.ts', "const e = { text: 'a' } as SubmitInput"),
      ...moduleStateProblems(REGISTER, 'let picking = null\nexport const front = new Set<string>()\nlet local = freshLocal()'),
      ...moduleStateProblems('hooks/scope.ts', 'let traceQueue = null'),
      ...optionReadProblems('x.ts', "export const register: Register = (on, options) => {\n  const file = typeof options.traceFile === 'string'"),
      ...commandDocProblems('---\ndescription: Show the loadout of this session. Also: list\nargument-hint: "[list]"\n---', { list: 'list', keep: 'keep <name>' }),
      ...kindBranchProblems('x.ts', "const rows = kind === 'tools' ? a : b\nif ('skills' !== item.kind) {}"),
      ...optionProblems({ userConfig: { a: { type: 'boolean', default: true } } }, { a: false, b: '' }),
    ].join('\n')
    for (const message of ['"as never"', '"as unknown as"', '"as SubmitInput"', 'tests/kit.ts', 'let picking', 'const front', 'let traceQueue', 'readOptions(options)', 'description is', 'argument-hint is', `"kind === 'tools'"`, `"'skills' !== item.kind"`, 'option "a"', 'option "b"']) {
      assert.ok(bad.includes(message), `no message with ${message} in:\n${bad}`)
    }
    assert.ok(!bad.includes('let local'))
    const good = [
      ...castProblems('x.ts', "submit($, 'a')\nconst m = Object.keys(x) as ModelTier[]"),
      ...castProblems('tests/x.ts', "const pane = { component: 'Pane' as const }\n// built as the engine raises it"),
      ...moduleStateProblems('x.ts', "const byName = new Intl.Collator()\nconst CATALOG = { tools: a }"),
      ...optionReadProblems('x.ts', 'export const register: Register = (on, raw) => {\n  // the raw options\n  const { traceFile } = readOptions(raw)'),
      ...commandDocProblems('---\ndescription: Show the loadout of this session. Also: list, keep <name>\nargument-hint: "[list|keep]"\n---', { list: 'list', keep: 'keep <name>' }),
      ...kindBranchProblems('x.ts', "const rows = CATALOG[kind](listing)\nfunction f(kind: Kind) {}"),
      ...optionProblems({ userConfig: { a: { type: 'boolean', default: true } } }, { a: true }),
    ]
    assert.deepEqual(good, [])
  },
  'the manifest options are the options the hooks read': async () => {
    const { OPTION_DEFAULTS } = await import('../hooks/scope.ts')
    const problems = [...optionProblems(JSON.parse(read(MANIFEST)), OPTION_DEFAULTS), ...optionReadProblems(REGISTER, read(REGISTER))]
    assert.deepEqual(problems, [], problems.join('\n'))
  },
  'the command doc shows the words of COMMANDS': async () => {
    const { COMMANDS } = await import('../hooks/scope.ts')
    const problems = commandDocProblems(read(COMMAND_DOC), COMMANDS)
    assert.deepEqual(problems, [], problems.join('\n'))
  },
  'no cast hides an engine shape': () => {
    const problems = all(TYPED, castProblems)
    assert.deepEqual(problems, [], problems.join('\n'))
  },
  'no session state outside Local and $.state': () => {
    const problems = all(HOOKS, moduleStateProblems)
    assert.deepEqual(problems, [], problems.join('\n'))
  },
  'no two-way branch on a kind': () => {
    const problems = all(TYPED, kindBranchProblems)
    assert.deepEqual(problems, [], problems.join('\n'))
  },
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn()
    console.log(`pass  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n${err.message}`)
  }
}
console.log(failed === 0 ? 'all passed' : `${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
