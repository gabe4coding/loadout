// The tasks of the eval. Each task is one session: its prompts go in one after
// the other. `check` judges the outcome by facts only: the calls that reached
// the fake servers, the files in the working folder and the final answers.
// It returns the failed checks; an empty list is a pass.
//
// The mix: tasks that need a tool group or a skill from the first prompt, a
// later prompt that needs a tool group the first prompt did not name (the
// plugin must point to it), and tasks that need no tool at all (where the
// model and effort switches save the most).

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const called = (calls, tool, match = () => true) => calls.some(c => c.tool === tool && match(c.args ?? {}))
const has = (text, pattern) => pattern.test(String(text ?? ''))

// Each rule is [what it checks, whether it holds].
const failed = rules => rules.filter(([, ok]) => !ok).map(([name]) => name)

export const TASKS = [
  {
    id: 'issue-count',
    about: 'One tool group, named by the prompt',
    prompts: ['How many open issues does project OPS have in the issue tracker? Reply with the number only.'],
    check: ({ calls, answers }) =>
      failed([
        ['list_issues called for OPS', called(calls, 'list_issues', a => /^ops$/i.test(a.project))],
        ['answer is 3', has(answers.at(-1), /\b3\b/)],
      ]),
  },
  {
    id: 'latency',
    about: 'One tool group, not named by the prompt',
    prompts: ['What is the current p95 latency of the checkout service according to our metrics? Reply with the number in ms.'],
    check: ({ calls, answers }) =>
      failed([
        ['query_metric called for checkout', called(calls, 'query_metric', a => /checkout/i.test(`${a.service} ${a.metric}`))],
        ['answer is 412', has(answers.at(-1), /412/)],
      ]),
  },
  {
    id: 'oncall-message',
    about: 'Two tool groups in one prompt',
    prompts: ['Find who is on call for the payments service and send them a direct chat message: "Deploy of payments at 17:00 today."'],
    check: ({ calls }) =>
      failed([
        ['get_oncall called for payments', called(calls, 'get_oncall', a => /payments/i.test(a.service))],
        ['message sent to @dana with the time', called(calls, 'send_message', a => /dana/i.test(a.to) && /17:00/.test(a.text))],
      ]),
  },
  {
    id: 'weather-later',
    about: 'A later prompt needs a tool group that the first prompt did not name',
    prompts: [
      'List the open issues of project OPS in the issue tracker. Reply with the keys only.',
      'Now give me the weather forecast for Milan for tomorrow: the sky and the highest temperature.',
    ],
    check: ({ calls, answers }) =>
      failed([
        ['list_issues called', called(calls, 'list_issues')],
        ['get_forecast called for Milan', called(calls, 'get_forecast', a => /milan/i.test(a.city))],
        ['answer has 21', has(answers.at(-1), /21/)],
      ]),
  },
  {
    id: 'incident-ticket',
    about: 'Two prompts, the second changes the tool group',
    prompts: [
      'What is the current p95 latency of the checkout service according to our metrics?',
      'Open an incident ticket in the issue tracker titled "Checkout p95 above 400ms" with priority high. Reply with its key.',
    ],
    check: ({ calls, answers }) =>
      failed([
        ['query_metric called', called(calls, 'query_metric')],
        ['create_ticket called with the title and high', called(calls, 'create_ticket', a => /checkout/i.test(a.title) && /high/i.test(a.priority))],
        ['answer has INC-7', has(answers.at(-1), /INC-7/)],
      ]),
  },
  {
    id: 'release-notes',
    about: 'Needs a project skill that the prompt does not name',
    prompts: ['Write the release notes for version 2.3.0 into RELEASE_NOTES.md, from CHANGES.txt.'],
    check: ({ cwd }) => {
      const file = path.join(cwd, 'RELEASE_NOTES.md')
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      return failed([
        ['RELEASE_NOTES.md written', text !== ''],
        ['first line is the house marker (from the skill)', text.split('\n')[0].trim() === '<!-- release-notes:v4 -->'],
        ['groups Added, Fixed and Changed', /### Added/.test(text) && /### Fixed/.test(text) && /### Changed/.test(text)],
      ])
    },
  },
  {
    id: 'fix-sum',
    about: 'A small code fix, no tool group or skill',
    prompts: ['The function sum in utils.js skips the first value. Fix it.'],
    check: async ({ cwd }) => {
      let result = null
      try {
        // A fresh URL each time, so the import does not come from the cache.
        const mod = await import(`${pathToFileURL(path.join(cwd, 'utils.js')).href}?t=${Date.now()}`)
        result = [mod.sum([1, 2, 3]), mod.sum([]), mod.sum([5])]
      } catch {}
      return failed([['sum([1,2,3]) = 6, sum([]) = 0, sum([5]) = 5', JSON.stringify(result) === '[6,0,5]']])
    },
  },
  {
    id: 'http-429',
    about: 'A short question, no tool',
    prompts: ['In one sentence: what does the HTTP status code 429 mean?'],
    check: ({ answers }) => failed([['answer says too many requests', has(answers.at(-1), /too many requests/i)]]),
  },
]
