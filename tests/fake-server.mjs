// A fake MCP server (stdio, JSON-RPC lines) for the smoke test. FAKE_KIND
// picks its tools: `tracker` (the task of the first prompt) or `weather` (not
// related to it, so the plugin must hide it). Every tools/call is appended to
// $FAKE_LOG as one JSON line.
//
//   FAKE_KIND=tracker FAKE_LOG=/tmp/calls.jsonl node tests/fake-server.mjs

import fs from 'node:fs'
import readline from 'node:readline'

const KIND = process.env.FAKE_KIND
const LOG = process.env.FAKE_LOG

const obj = (properties, required = []) => ({ type: 'object', properties, required })
const SERVERS = {
  tracker: {
    instructions: 'Tracker rules: project keys are upper case.',
    tools: [
      { name: 'list_issues', description: 'List the open issues of a project in the issue tracker.', inputSchema: obj({ project: { type: 'string', description: 'Project key, for example "OPS".' } }, ['project']) },
      { name: 'create_ticket', description: 'Create an incident ticket.', inputSchema: obj({ title: { type: 'string' } }, ['title']) },
    ],
    handlers: {
      list_issues: ({ project }) => ({ project, total: 2, issues: [{ key: `${project}-1`, title: 'Login fails' }, { key: `${project}-2`, title: 'Slow search' }] }),
      create_ticket: ({ title }) => ({ key: 'INC-1', title }),
    },
  },
  weather: {
    instructions: 'Weather rules: give city names in English.',
    tools: [
      { name: 'get_forecast', description: 'Get the weather forecast of a city for the next days.', inputSchema: obj({ city: { type: 'string' } }, ['city']) },
      { name: 'get_alerts', description: 'List the weather alerts of a region.', inputSchema: obj({ region: { type: 'string' } }, ['region']) },
    ],
    handlers: {
      get_forecast: ({ city }) => ({ city, days: [{ day: 'tomorrow', sky: 'sunny', maxC: 21 }] }),
      get_alerts: ({ region }) => ({ region, alerts: [] }),
    },
  },
}
// FAKE_SERVERS names a module with other kinds, for the eval (evals/fixture.mjs).
const kinds = process.env.FAKE_SERVERS ? (await import(process.env.FAKE_SERVERS)).SERVERS : SERVERS
const server = kinds[KIND]
if (!server) throw new Error(`FAKE_KIND must be one of ${Object.keys(kinds).join(', ')}`)

const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)

readline.createInterface({ input: process.stdin }).on('line', line => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return // a notification
  const reply = result => send({ jsonrpc: '2.0', id: msg.id, result })
  if (msg.method === 'initialize') {
    return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: KIND, version: '1.0.0' }, instructions: server.instructions })
  }
  if (msg.method === 'ping') return reply({})
  if (msg.method === 'tools/list') return reply({ tools: server.tools })
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params ?? {}
    const handler = server.handlers[name]
    const result = handler
      ? { content: [{ type: 'text', text: JSON.stringify(handler(args)) }] }
      : { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
    if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ server: KIND, tool: name, args })}\n`)
    return reply(result)
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
})
