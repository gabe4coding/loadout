// Typed builders for the engine inputs and fake answers that the hook tests
// use. Build each input here, never inline with a cast (`as never`, `as X`):
// a cast hides a field that the engine renamed, and the test then passes on a
// wrong shape. tests/contract.check.mjs fails on a cast in tests/.

import type { ModelCompleteResult, On, PromptOrigin, SessionContextBreakdown, ToolInfo } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { Usage } from '../types'

// A prompt that the person typed.
const COMPOSER: PromptOrigin = { kind: 'composer' }

// The token use of each fake classifier reply.
export const USAGE: Usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// A prompt as the engine raises it: from the person, unless `origin` says otherwise.
export function submit($: Engine, text: string, origin: PromptOrigin = COMPOSER) {
  return $.prompt.submit({ text, wait: false, origin })
}

// A listing or another attachment as the engine raises it.
export function attach($: Engine, type: string, text: string) {
  return $.prompt.attachment({ type, text, origin: { kind: 'engine' } })
}

// A command that the person typed: `/loadout <args>` unless `command` names another.
export function command($: Engine, args: string, name = 'loadout') {
  return $.command.run({ command: name, args, origin: COMPOSER, presentation: { isFullscreen: false, columns: 80 } })
}

// A classifier that replies `text`.
export function answer(text: string): { value: ModelCompleteResult } {
  return { value: { isAnswered: true, text, usage: USAGE } }
}

// A classifier call that fails.
export function failed(): { value: ModelCompleteResult } {
  return { value: { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: USAGE } }
}

// $.tool.list() as the engine answers it.
export function listed(on: On, tools: readonly ToolInfo[]): void {
  on('tool.list', () => ({ value: [...tools] }))
}

// The engine's own ui.status, ui.invalidate and ui.toast, which the kit
// leaves out. Each toast text goes into `toasts`.
export function quiet(on: On, toasts: string[] = []): void {
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
}

// The context breakdown of $.session.usage(): the parts a test gives, the
// rest empty.
export function breakdown(parts: Partial<SessionContextBreakdown>): SessionContextBreakdown {
  return {
    categories: [],
    totalTokens: 0,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    autocompactSource: 'model-default',
    percentage: 0,
    gridRows: [],
    model: 'claude-sonnet-5-5',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: false,
    apiUsage: null,
    ...parts,
  }
}

type Question = { question: string; options: { label: string }[] }

// The first question of an AskUserQuestion call. The tests load no built-in
// tool types, so the input is read with a guard, not a cast.
export function firstQuestion(e: object): Question | undefined {
  const questions: unknown[] = 'questions' in e && Array.isArray(e.questions) ? e.questions : []
  const [first] = questions
  const isQuestion = (value: unknown): value is Question =>
    typeof value === 'object' && value !== null && 'question' in value && 'options' in value && Array.isArray(value.options)
  return isQuestion(first) ? first : undefined
}
