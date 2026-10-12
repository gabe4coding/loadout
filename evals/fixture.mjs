// The fixed setup of the eval: twelve fake MCP servers (80 tools) with
// server instructions, and 40 project skills. A real setup of a team has
// listings of this size; the plugin saves in proportion to them. The servers
// run through tests/fake-server.mjs (FAKE_SERVERS points here); the skills and
// task files go into the working folder of each session (`setup`).
//
// The data that a task checks is in the replies here: keep them in step with
// evals/tasks.mjs.

import fs from 'node:fs'
import path from 'node:path'

const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required })
const str = description => ({ type: 'string', description })

// One server: rules for its instructions, then its tools as
// [name, description, properties, reply]. A tool with no reply answers ok.
function server(rules, tools) {
  const guide = tools.map(([name, description]) => `- ${name}: ${description} Prefer it over a manual search when the user asks for this.`)
  return {
    instructions: [...rules, '', 'Tool guide:', ...guide, '', 'Answer with the data the tools return. Never invent ids, names or numbers.'].join('\n'),
    tools: tools.map(([name, description, properties = {}]) => ({ name, description, inputSchema: obj(properties) })),
    handlers: Object.fromEntries(tools.map(([name, , , reply]) => [name, reply ?? (args => ({ ok: true, ...args }))])),
  }
}

export const SERVERS = {
  tracker: server(
    ['Issue tracker rules: project keys are upper case (OPS, WEB, PAY).', 'An incident ticket needs a title and a priority: low, medium or high.'],
    [
      ['list_issues', 'List the open issues of a project.', { project: str('Project key, for example "OPS".') },
        ({ project }) => ({ project, total: 3, issues: [1, 2, 3].map(n => ({ key: `${project}-${n}`, title: ['Login fails', 'Slow search', 'Broken export'][n - 1] })) })],
      ['get_issue', 'Get one issue with its comments.', { key: str('Issue key.') }],
      ['create_ticket', 'Create an incident ticket.', { title: str('Title.'), priority: str('low, medium or high.') },
        ({ title, priority }) => ({ key: 'INC-7', title, priority })],
      ['update_issue', 'Change the status or the assignee of an issue.', { key: str('Issue key.'), status: str('New status.') }],
      ['add_comment', 'Add a comment to an issue.', { key: str('Issue key.'), text: str('Comment.') }],
      ['search_issues', 'Search issues with a query.', { query: str('Query text.') }],
      ['list_sprints', 'List the sprints of a board.', { board: str('Board name.') }],
      ['link_issues', 'Link two issues.', { from: str('Issue key.'), to: str('Issue key.') }],
    ],
  ),
  weather: server(
    ['Weather rules: give city names in English. Temperatures are in Celsius.'],
    [
      ['get_forecast', 'Get the weather forecast of a city for the next days.', { city: str('City name.') },
        ({ city }) => ({ city, days: [{ day: 'tomorrow', sky: 'sunny', maxC: 21, minC: 12 }] })],
      ['get_alerts', 'List the weather alerts of a region.', { region: str('Region name.') }, ({ region }) => ({ region, alerts: [] })],
      ['get_history', 'Get past weather of a city for a date.', { city: str('City name.'), date: str('ISO date.') }],
      ['get_air_quality', 'Get the air quality index of a city.', { city: str('City name.') }],
    ],
  ),
  metrics: server(
    ['Metrics rules: metric names are dotted, for example checkout.latency.p95.', 'Latency values are in milliseconds. A query covers the last 15 minutes unless the user names a range.'],
    [
      ['query_metric', 'Get the current value of a metric for a service.', { metric: str('Metric name.'), service: str('Service name.') },
        ({ metric, service }) => ({ metric, service, value: /p95|latency/.test(String(metric)) ? 412 : 0, unit: 'ms', window: '15m' })],
      ['list_metrics', 'List the metrics of a service.', { service: str('Service name.') },
        ({ service }) => ({ service, metrics: ['checkout.latency.p95', 'checkout.latency.p50', 'checkout.errors.rate'] })],
      ['list_monitors', 'List the monitors and their state.', { service: str('Service name.') }],
      ['mute_monitor', 'Mute a monitor for a time.', { id: str('Monitor id.'), minutes: str('Minutes.') }],
      ['search_logs', 'Search the logs of a service.', { service: str('Service name.'), query: str('Query.') }],
      ['get_trace', 'Get one distributed trace.', { id: str('Trace id.') }],
      ['list_dashboards', 'List the dashboards.', { team: str('Team name.') }],
      ['get_slo', 'Get the SLO status of a service.', { service: str('Service name.') }],
    ],
  ),
  chat: server(
    ['Chat rules: a direct message goes to a user handle that starts with @. A channel name starts with #.', 'Do not send a message the user did not ask for.'],
    [
      ['send_message', 'Send a message to a channel or a user.', { to: str('Channel (#name) or user handle (@name).'), text: str('Message text.') },
        ({ to, text }) => ({ ok: true, to, text, ts: '1700000000.0001' })],
      ['read_channel', 'Read the last messages of a channel.', { channel: str('Channel name.') }],
      ['search_messages', 'Search messages.', { query: str('Query.') }],
      ['list_channels', 'List the channels.', {}],
      ['set_status', 'Set the status of the user.', { text: str('Status.') }],
      ['add_reaction', 'Add a reaction to a message.', { ts: str('Message id.'), emoji: str('Emoji name.') }],
    ],
  ),
  pager: server(
    ['On-call rules: each service has one primary engineer on call. The handle works in the chat server.'],
    [
      ['get_oncall', 'Get the engineer on call for a service.', { service: str('Service name.') },
        ({ service }) => ({ service, engineer: 'Dana Rossi', handle: '@dana' })],
      ['list_incidents', 'List the open incidents.', { service: str('Service name.') }],
      ['ack_incident', 'Acknowledge an incident.', { id: str('Incident id.') }],
      ['resolve_incident', 'Resolve an incident.', { id: str('Incident id.') }],
      ['list_schedules', 'List the on-call schedules.', {}],
      ['override_shift', 'Override an on-call shift.', { schedule: str('Schedule.'), user: str('User.') }],
    ],
  ),
  crm: server(
    ['CRM rules: an account id starts with ACC-. Do not change an account without the user asking.'],
    [
      ['find_account', 'Find a customer account by name.', { name: str('Account name.') }],
      ['get_account', 'Get one account.', { id: str('Account id.') }],
      ['list_contacts', 'List the contacts of an account.', { id: str('Account id.') }],
      ['log_activity', 'Log a call or a meeting.', { id: str('Account id.'), text: str('Notes.') }],
      ['list_deals', 'List the open deals.', { owner: str('Owner.') }],
      ['update_deal', 'Update the stage of a deal.', { id: str('Deal id.'), stage: str('Stage.') }],
      ['create_lead', 'Create a lead.', { name: str('Name.') }],
      ['merge_accounts', 'Merge two accounts.', { from: str('Account id.'), to: str('Account id.') }],
    ],
  ),
  billing: server(
    ['Billing rules: amounts are in cents. Never refund more than the invoice total.'],
    [
      ['get_invoice', 'Get one invoice.', { id: str('Invoice id.') }],
      ['list_invoices', 'List the invoices of a customer.', { customer: str('Customer id.') }],
      ['refund', 'Refund an invoice.', { id: str('Invoice id.'), cents: str('Amount.') }],
      ['list_subscriptions', 'List the subscriptions of a customer.', { customer: str('Customer id.') }],
      ['cancel_subscription', 'Cancel a subscription.', { id: str('Subscription id.') }],
      ['get_balance', 'Get the balance of a customer.', { customer: str('Customer id.') }],
      ['create_coupon', 'Create a coupon.', { code: str('Code.'), percent: str('Percent off.') }],
    ],
  ),
  calendar: server(
    ['Calendar rules: times are in the user time zone. A meeting needs at least one guest.'],
    [
      ['list_events', 'List the events of a day.', { date: str('ISO date.') }],
      ['create_event', 'Create an event.', { title: str('Title.'), start: str('ISO time.') }],
      ['find_free_time', 'Find free time for a group.', { people: str('Comma list.') }],
      ['cancel_event', 'Cancel an event.', { id: str('Event id.') }],
      ['update_event', 'Move an event.', { id: str('Event id.'), start: str('ISO time.') }],
      ['list_rooms', 'List the meeting rooms.', {}],
    ],
  ),
  wiki: server(
    ['Wiki rules: page paths use slashes, for example eng/runbooks/payments. Link pages by path.'],
    [
      ['search_pages', 'Search the wiki.', { query: str('Query.') }],
      ['get_page', 'Read one page.', { path: str('Page path.') }],
      ['create_page', 'Create a page.', { path: str('Page path.'), text: str('Markdown.') }],
      ['update_page', 'Change a page.', { path: str('Page path.'), text: str('Markdown.') }],
      ['list_children', 'List the child pages of a page.', { path: str('Page path.') }],
      ['get_history', 'Get the change history of a page.', { path: str('Page path.') }],
      ['add_label', 'Add a label to a page.', { path: str('Page path.'), label: str('Label.') }],
    ],
  ),
  ci: server(
    ['CI rules: a pipeline id is a number. Retry a failed job at most two times.'],
    [
      ['list_pipelines', 'List the last pipelines of a repo.', { repo: str('Repo name.') }],
      ['get_pipeline', 'Get one pipeline with its jobs.', { id: str('Pipeline id.') }],
      ['retry_job', 'Retry a failed job.', { id: str('Job id.') }],
      ['get_job_log', 'Get the log of a job.', { id: str('Job id.') }],
      ['cancel_pipeline', 'Cancel a pipeline.', { id: str('Pipeline id.') }],
      ['list_artifacts', 'List the artifacts of a pipeline.', { id: str('Pipeline id.') }],
      ['trigger_pipeline', 'Start a pipeline on a branch.', { repo: str('Repo name.'), branch: str('Branch.') }],
      ['list_runners', 'List the CI runners.', {}],
    ],
  ),
  storage: server(
    ['Storage rules: bucket names are lower case. Never delete a bucket.'],
    [
      ['list_buckets', 'List the buckets.', {}],
      ['list_objects', 'List the objects of a bucket.', { bucket: str('Bucket.'), prefix: str('Prefix.') }],
      ['get_object', 'Read one object.', { bucket: str('Bucket.'), key: str('Key.') }],
      ['put_object', 'Write one object.', { bucket: str('Bucket.'), key: str('Key.'), text: str('Content.') }],
      ['sign_url', 'Make a signed URL for an object.', { bucket: str('Bucket.'), key: str('Key.') }],
      ['get_usage', 'Get the storage use of a bucket.', { bucket: str('Bucket.') }],
    ],
  ),
  flags: server(
    ['Feature flag rules: flag keys use kebab case. A change in production needs a reason.'],
    [
      ['list_flags', 'List the feature flags of a project.', { project: str('Project.') }],
      ['get_flag', 'Get one flag with its rules.', { key: str('Flag key.') }],
      ['toggle_flag', 'Turn a flag on or off in an environment.', { key: str('Flag key.'), env: str('Environment.'), on: str('true or false.') }],
      ['create_flag', 'Create a flag.', { key: str('Flag key.') }],
      ['list_stale_flags', 'List flags with no change for 90 days.', { project: str('Project.') }],
      ['get_flag_history', 'Get the change history of a flag.', { key: str('Flag key.') }],
    ],
  ),
}

// The skill that a task needs. Its body holds a rule that only the skill
// gives, so a check can see if Claude read it.
const RELEASE_NOTES = {
  description: 'Use when you write release notes or a changelog entry: the house format that the release tooling parses.',
  body: [
    'Write release notes in the house format. The release tooling rejects other formats.',
    '',
    '1. The first line of the file is exactly `<!-- release-notes:v4 -->`.',
    '2. Then a heading `## <version>`.',
    '3. Group the changes under `### Added`, `### Fixed` and `### Changed`. Leave out an empty group.',
    '4. One bullet per change, in the past tense.',
  ].join('\n'),
}

// Other skills of a team: none helps with a task of the eval.
const OTHER_SKILLS = {
  'api-design': 'Use when you design a REST endpoint: naming, status codes, pagination and error bodies.',
  'db-migration': 'Use when you write a database migration: safe column changes, backfills and rollbacks.',
  'perf-profiling': 'Use when a service is slow: how to take a CPU profile and read a flame graph.',
  'i18n-strings': 'Use when you add or change text that users see: translation keys and plural rules.',
  'accessibility-audit': 'Use when you review a web page for accessibility: contrast, labels and keyboard use.',
  'docker-compose': 'Use when you change the local development stack in docker compose files.',
  'terraform-plan': 'Use when you change infrastructure code: plan, review and apply with Terraform.',
  'k8s-rollout': 'Use when you deploy to Kubernetes: rollout checks, readiness probes and rollbacks.',
  'incident-postmortem': 'Use when you write a postmortem after an incident: timeline, impact and actions.',
  'sql-review': 'Use when you review an SQL query for speed: indexes, joins and query plans.',
  'security-headers': 'Use when you set HTTP security headers: CSP, HSTS and frame options.',
  'dependency-upgrade': 'Use when you upgrade a library: read the changelog, run the tests, check breaking changes.',
  'flaky-test-triage': 'Use when a test fails sometimes: find the cause, quarantine it and open a ticket.',
  'feature-flag-cleanup': 'Use when you remove an old feature flag from the code and from the flag service.',
  'design-tokens': 'Use when you change colors, spacing or fonts of the design system.',
  'storybook-stories': 'Use when you add a Storybook story for a UI component.',
  'graphql-schema': 'Use when you change a GraphQL schema: deprecations, nullability and breaking changes.',
  'openapi-lint': 'Use when you change an OpenAPI file: lint rules and version bumps.',
  'cron-jobs': 'Use when you add or change a scheduled job: time zones, locks and retries.',
  'email-templates': 'Use when you change an email template: layout rules and preview tests.',
  'pdf-reports': 'Use when you generate a PDF report from data.',
  'csv-import': 'Use when you import a CSV file into the database: validation and error reports.',
  'data-backfill': 'Use when you backfill data in production: batches, throttling and checks.',
  'cache-invalidation': 'Use when you change cache keys or the time to live of cached data.',
  'rate-limits': 'Use when you add or tune rate limits of an API.',
  'oauth-setup': 'Use when you add an OAuth login provider to an application.',
  'mobile-release': 'Use when you release the mobile apps: version codes, store notes and phased rollout.',
  'android-build': 'Use when an Android build fails: Gradle cache, SDK versions and signing.',
  'ios-signing': 'Use when iOS code signing fails: profiles, certificates and entitlements.',
  'ab-test-analysis': 'Use when you analyse an A/B test: sample size, significance and guardrail metrics.',
  'sprint-report': 'Use when you write the report at the end of a sprint.',
  'onboarding-guide': 'Use when you write a guide for a new team member.',
  'code-owners': 'Use when you change the CODEOWNERS file or the review rules of a repo.',
  'commit-style': 'Use when you write a commit message: the format of the subject and the body.',
  'pr-description': 'Use when you write a pull request description: summary, tests and risks.',
  'test-data-factory': 'Use when you need test data: factories, fixtures and seeds.',
  'load-test': 'Use when you run a load test: scenarios, ramp up and how to read the results.',
  'error-budget': 'Use when you check the error budget of a service and decide on a release freeze.',
  'runbook-writer': 'Use when you write a runbook for an alert: checks, actions and escalation.',
}

export const SKILLS = {
  'release-notes': RELEASE_NOTES,
  ...Object.fromEntries(Object.entries(OTHER_SKILLS).map(([name, description]) => [name, { description, body: `${description}\n\nFollow the team guide for this task.` }])),
}

// The files of the tasks, in the working folder.
export const FILES = {
  'CHANGES.txt': ['2.3.0', '- add CSV export of the order list', '- fix the crash when the cart is empty', '- change the default page size from 20 to 50'].join('\n'),
  'utils.js': [
    'export function sum(values) {',
    '  let total = 0',
    '  for (let i = 1; i < values.length; i++) total += values[i]',
    '  return total',
    '}',
    '',
  ].join('\n'),
}

export function setup(cwd) {
  for (const [name, { description, body }] of Object.entries(SKILLS)) {
    const dir = path.join(cwd, '.claude', 'skills', name)
    fs.mkdirSync(dir, { recursive: true })
    // JSON quotes the description: a ": " in it breaks plain YAML.
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`)
  }
  for (const [name, text] of Object.entries(FILES)) fs.writeFileSync(path.join(cwd, name), text)
}
