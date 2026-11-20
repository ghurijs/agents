// @ghuri/agents/evals: measure how well an agent does its job with a given model, so a cheaper model can be
// compared with an expensive one on your own tasks. Runs inside your tests (`ghuri eval` / `ghuri test`), against
// the test database.

import { generateText, type LanguageModel, type LanguageModelUsage } from 'ai'
import type { Agent, AgentRunResult, RunOptions, ToolCallRecord } from '../agent'
import { resolveModel } from '../providers'
import { modelLabel } from '../trace'

// ---------------------------------------------------------------------------------------------------------------
// Types

/** One task the agent should handle. */
export interface EvalCase {
  name: string
  /** The user's message. */
  input: string
  /** What a good run looks like. Every check must pass for the case to pass. */
  checks: EvalCheck[]
  /** Extra run options for this case (`context`, …). `user` usually comes from the suite's `setup`. */
  options?: Omit<RunOptions, 'memory'>
}

/** What a check sees after a run. */
export interface CheckContext {
  case: EvalCase
  /** `'<provider>:<model-id>'` the run used. */
  model: string
  result: AgentRunResult
  /** The suite's judge model, for checks that ask a model. */
  judgeModel?: string | LanguageModel
}

export interface CheckResult {
  pass: boolean
  /** Why it failed (or passed, for judges). */
  reason?: string
}

export interface EvalCheck {
  /** Short label shown in reports (`calledTool(product_create)`). */
  name: string
  run(ctx: CheckContext): CheckResult | boolean | Promise<CheckResult | boolean>
}

/** Price of a model in US dollars per million tokens. */
export interface ModelPrice {
  input: number
  output: number
  /** Cache reads; defaults to `input`. */
  cachedInput?: number
}

export interface EvalSuite<A extends Agent = Agent> {
  name: string
  /** The agent class (or a factory) under test. */
  agent: (new () => A) | (() => A)
  cases: EvalCase[]
  /** Models to compare; default: the agent's own model. `GHURI_EVAL_MODELS` (comma separated) overrides both. */
  models?: Array<string | LanguageModel>
  /** Runs per case and model (default 1; `GHURI_EVAL_REPEAT` overrides). More runs give steadier pass rates. */
  repeat?: number
  /** Before each run: create the data the case needs and return the run options (usually `{ user }`). */
  setup?: (c: EvalCase) => Promise<Partial<RunOptions> | undefined> | Partial<RunOptions> | undefined
  /** Model for `judge()` checks. */
  judgeModel?: string | LanguageModel
  /** `{ 'anthropic:claude-haiku-5-5': { input: 0.1, output: 0.5 } }` to report cost. */
  prices?: Record<string, ModelPrice>
}

export interface EvalFailure {
  check: string
  reason: string
}

export interface EvalAttempt {
  case: string
  model: string
  attempt: number
  pass: boolean
  failures: EvalFailure[]
  /** Set when the run itself failed (provider error, …). */
  error?: string
  text: string
  toolCalls: Array<{ toolName: string; input: unknown; error?: string }>
  steps: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  /** US dollars, when `prices` has the model. */
  cost: number | null
  durationMs: number
}

export interface EvalModelSummary {
  model: string
  passed: number
  total: number
  passRate: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  /** Total US dollars, `null` without a price for the model. */
  cost: number | null
  /** Dollars per passed attempt (`null` without a price or when nothing passed). */
  costPerPass: number | null
  avgDurationMs: number
}

export interface EvalReport {
  suite: string
  startedAt: string
  models: EvalModelSummary[]
  /** Summaries by model label. */
  byModel: Record<string, EvalModelSummary>
  attempts: EvalAttempt[]
}

export interface RunEvalOptions {
  models?: Array<string | LanguageModel>
  repeat?: number
  /** Before every attempt, e.g. `() => db.flush()` so each run starts from a clean database. */
  beforeEach?: () => unknown | Promise<unknown>
  /** Only cases whose name contains this text (`GHURI_EVAL_CASE` overrides). */
  filter?: string
  /** Called after every attempt (progress output). */
  onAttempt?: (attempt: EvalAttempt) => void
}

/** Typed helper for declaring a suite. */
export function defineEval<A extends Agent>(suite: EvalSuite<A>): EvalSuite<A> {
  return suite
}

// ---------------------------------------------------------------------------------------------------------------
// Checks

function partialMatch(actual: unknown, expected: unknown): boolean {
  if (expected instanceof RegExp) return typeof actual === 'string' && expected.test(actual)
  if (typeof expected === 'function') return Boolean((expected as (v: unknown) => unknown)(actual))
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((e, i) => partialMatch(actual[i], e))
    )
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false
    return Object.entries(expected).every(([k, v]) => partialMatch((actual as Record<string, unknown>)[k], v))
  }
  if (typeof expected === 'number' && typeof actual === 'string') return Number(actual) === expected
  if (typeof expected === 'string' && typeof actual === 'number') return String(actual) === expected
  return Object.is(actual, expected)
}

function short(value: unknown, max = 200): string {
  let s: string
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    s = String(value)
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * The agent called `toolName` without an error. `input` is matched partially: listed keys must match, others are
 * ignored; a `RegExp` tests strings and a function is a predicate. `times` asks for an exact number of calls.
 */
export function calledTool(
  toolName: string,
  input?: Record<string, unknown>,
  opts: { times?: number; allowError?: boolean } = {},
): EvalCheck {
  return {
    name: `calledTool(${toolName})`,
    run({ result }) {
      const calls = result.toolCalls.filter((c) => c.toolName === toolName)
      const ok = calls.filter(
        (c) => (opts.allowError || !c.error) && (input === undefined || partialMatch(c.input, input)),
      )
      if (opts.times !== undefined && ok.length !== opts.times) {
        return { pass: false, reason: `expected ${opts.times} matching call(s), got ${ok.length}` }
      }
      if (ok.length) return { pass: true }
      if (!calls.length) {
        const made = [...new Set(result.toolCalls.map((c) => c.toolName))].join(', ') || 'none'
        return { pass: false, reason: `not called (tools called: ${made})` }
      }
      const errored = calls.find((c) => c.error)
      if (errored && input === undefined) return { pass: false, reason: `failed: ${errored.error}` }
      return {
        pass: false,
        reason: `called with ${short(calls.map((c) => c.input))}, expected ${short(input)}`,
      }
    },
  }
}

/** The agent never called `toolName`. */
export function notCalledTool(toolName: string): EvalCheck {
  return {
    name: `notCalledTool(${toolName})`,
    run: ({ result }) => {
      const n = result.toolCalls.filter((c) => c.toolName === toolName).length
      return n ? { pass: false, reason: `called ${n} time(s)` } : { pass: true }
    },
  }
}

/** No tool call failed (permission denied, validation errors…). */
export function noToolErrors(): EvalCheck {
  return {
    name: 'noToolErrors',
    run: ({ result }) => {
      const bad = result.toolCalls.filter((c) => c.error)
      return bad.length
        ? { pass: false, reason: bad.map((c) => `${c.toolName}: ${c.error}`).join('; ') }
        : { pass: true }
    },
  }
}

/** The final answer contains `text` (a string, case-insensitive) or matches a `RegExp`. */
export function answerMatches(pattern: string | RegExp): EvalCheck {
  return {
    name: `answerMatches(${String(pattern)})`,
    run: ({ result }) => {
      const ok =
        typeof pattern === 'string'
          ? result.text.toLowerCase().includes(pattern.toLowerCase())
          : pattern.test(result.text)
      return ok ? { pass: true } : { pass: false, reason: `answer was: ${short(result.text)}` }
    },
  }
}

/** At most `n` model steps (tool round trips): catches agents that wander. */
export function maxSteps(n: number): EvalCheck {
  return {
    name: `maxSteps(${n})`,
    run: ({ result }) =>
      result.steps <= n ? { pass: true } : { pass: false, reason: `took ${result.steps} steps` },
  }
}

/** Any custom assertion: query the database, inspect the result. Return `false` (or throw) to fail. */
export function check(name: string, fn: (ctx: CheckContext) => unknown | Promise<unknown>): EvalCheck {
  return {
    name,
    async run(ctx) {
      const r = await fn(ctx)
      if (r && typeof r === 'object' && 'pass' in (r as object)) return r as CheckResult
      return r === false ? { pass: false, reason: 'returned false' } : { pass: true }
    },
  }
}

function toolSummary(calls: ToolCallRecord[]): string {
  if (!calls.length) return '(no tool calls)'
  return calls
    .map(
      (c, i) =>
        `${i + 1}. ${c.toolName}(${short(c.input, 400)}) → ${c.error ? `ERROR ${c.error}` : short(c.output, 400)}`,
    )
    .join('\n')
}

/** Parse `{ "pass": …, "reason": … }` out of a judge's answer. */
export function parseVerdict(text: string): CheckResult | undefined {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return undefined
  try {
    const v = JSON.parse(m[0])
    if (typeof v.pass !== 'boolean') return undefined
    return { pass: v.pass, reason: typeof v.reason === 'string' ? v.reason : undefined }
  } catch {
    return undefined
  }
}

/**
 * Ask a model whether the run meets `rubric` (plain language: "Confirms the product was created as a draft and
 * does not claim it is live"). Uses `opts.model`, else the suite's `judgeModel`. Use a strong model as the judge,
 * and keep deterministic checks for whatever can be checked in code.
 */
export function judge(rubric: string, opts: { model?: string | LanguageModel } = {}): EvalCheck {
  return {
    name: `judge(${short(rubric, 60)})`,
    async run(ctx) {
      const m = opts.model ?? ctx.judgeModel
      if (!m)
        return { pass: false, reason: 'no judge model: set judgeModel on the suite or judge(…, { model })' }
      const model = await resolveModel(m)
      const res = await generateText({
        model,
        system:
          'You grade the work of an AI agent against a rubric. Judge only what the transcript shows: the tool calls ' +
          'and their results are what actually happened; the final answer is what the user was told. Reply with ' +
          'one JSON object and nothing else: {"pass": true|false, "reason": "<one sentence>"}.',
        prompt:
          `Rubric:\n${rubric}\n\nUser message:\n${ctx.case.input}\n\nTool calls:\n${toolSummary(ctx.result.toolCalls)}` +
          `\n\nFinal answer:\n${ctx.result.text || '(empty)'}`,
      } as any)
      return parseVerdict(res.text) ?? { pass: false, reason: `judge gave no verdict: ${short(res.text)}` }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Runner

function env(name: string): string | undefined {
  const v = (globalThis as any).process?.env?.[name]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function tokens(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

/** Cost in dollars of `usage` at `price` (per million tokens). */
export function costOf(
  usage: Pick<EvalAttempt, 'inputTokens' | 'outputTokens' | 'cachedInputTokens'>,
  price?: ModelPrice,
): number | null {
  if (!price) return null
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens)
  return (
    (uncached * price.input +
      usage.cachedInputTokens * (price.cachedInput ?? price.input) +
      usage.outputTokens * price.output) /
    1_000_000
  )
}

function createAgent<A extends Agent>(factory: EvalSuite<A>['agent']): A {
  const proto = (factory as { prototype?: { run?: unknown } }).prototype
  return proto && typeof proto.run === 'function' ? new (factory as new () => A)() : (factory as () => A)()
}

function summarize(model: string, attempts: EvalAttempt[]): EvalModelSummary {
  const passed = attempts.filter((a) => a.pass).length
  const priced = attempts.every((a) => a.cost !== null)
  const cost = priced ? attempts.reduce((s, a) => s + (a.cost ?? 0), 0) : null
  return {
    model,
    passed,
    total: attempts.length,
    passRate: attempts.length ? passed / attempts.length : 0,
    inputTokens: attempts.reduce((s, a) => s + a.inputTokens, 0),
    outputTokens: attempts.reduce((s, a) => s + a.outputTokens, 0),
    cachedInputTokens: attempts.reduce((s, a) => s + a.cachedInputTokens, 0),
    cost,
    costPerPass: cost !== null && passed ? cost / passed : null,
    avgDurationMs: attempts.length ? attempts.reduce((s, a) => s + a.durationMs, 0) / attempts.length : 0,
  }
}

/**
 * Run every case of `suite` against every model, `repeat` times, and grade each run with its checks. Runs one
 * at a time without conversation memory. Calls real models unless the suite uses a mock: every run costs money.
 */
export async function runEval<A extends Agent>(
  suite: EvalSuite<A>,
  opts: RunEvalOptions = {},
): Promise<EvalReport> {
  const envModels = env('GHURI_EVAL_MODELS')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const repeat = Math.max(1, Number(env('GHURI_EVAL_REPEAT') ?? opts.repeat ?? suite.repeat ?? 1) || 1)
  const filter = env('GHURI_EVAL_CASE') ?? opts.filter
  const cases = suite.cases.filter((c) => !filter || c.name.includes(filter))
  const probe = createAgent(suite.agent)
  const models: Array<string | LanguageModel | null> = envModels ??
    opts.models ??
    suite.models ?? [probe.model ?? null]
  const startedAt = new Date().toISOString()
  const attempts: EvalAttempt[] = []

  for (const m of models) {
    const label = modelLabel(m) || modelLabel(probe.model) || '(default)'
    for (const c of cases) {
      for (let attempt = 1; attempt <= repeat; attempt++) {
        await opts.beforeEach?.()
        const agent = createAgent(suite.agent)
        if (m !== null) (agent as { model?: unknown }).model = m
        const extra = (await suite.setup?.(c)) ?? {}
        const t0 = Date.now()
        let result: AgentRunResult | undefined
        let error: string | undefined
        try {
          result = await agent.run(c.input, { ...extra, ...c.options, memory: false } as RunOptions)
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
        }
        const durationMs = Date.now() - t0
        const failures: EvalFailure[] = []
        if (result) {
          for (const chk of c.checks) {
            try {
              const r = await chk.run({ case: c, model: label, result, judgeModel: suite.judgeModel })
              const v = typeof r === 'boolean' ? { pass: r } : r
              if (!v.pass) failures.push({ check: chk.name, reason: v.reason ?? 'failed' })
            } catch (err) {
              failures.push({
                check: chk.name,
                reason: `threw: ${err instanceof Error ? err.message : String(err)}`,
              })
            }
          }
        }
        const usage: Partial<LanguageModelUsage> = result?.usage ?? {}
        const counts = {
          inputTokens: tokens(usage.inputTokens),
          outputTokens: tokens(usage.outputTokens),
          cachedInputTokens: tokens(usage.inputTokenDetails?.cacheReadTokens),
        }
        const a: EvalAttempt = {
          case: c.name,
          model: label,
          attempt,
          pass: !error && failures.length === 0,
          failures: error ? [{ check: 'run', reason: error }] : failures,
          ...(error ? { error } : {}),
          text: result?.text ?? '',
          toolCalls: (result?.toolCalls ?? []).map((t) => ({
            toolName: t.toolName,
            input: t.input,
            ...(t.error ? { error: t.error } : {}),
          })),
          steps: result?.steps ?? 0,
          ...counts,
          cost: costOf(counts, suite.prices?.[label]),
          durationMs,
        }
        attempts.push(a)
        opts.onAttempt?.(a)
      }
    }
  }

  const labels = [...new Set(attempts.map((a) => a.model))]
  const summaries = labels.map((l) =>
    summarize(
      l,
      attempts.filter((a) => a.model === l),
    ),
  )
  const report: EvalReport = {
    suite: suite.name,
    startedAt,
    models: summaries,
    byModel: Object.fromEntries(summaries.map((s) => [s.model, s])),
    attempts,
  }
  await writeReportFile(report)
  return report
}

/** With `GHURI_EVAL_REPORT_DIR` set (`ghuri eval --report <dir>`), save the report as `<dir>/<suite>.json`. */
async function writeReportFile(report: EvalReport): Promise<void> {
  const dir = env('GHURI_EVAL_REPORT_DIR')
  if (!dir) return
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${report.suite.replace(/[^\w.-]+/g, '_')}.json`)
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`)
}

// ---------------------------------------------------------------------------------------------------------------
// Output

function money(n: number | null): string {
  if (n === null) return '-'
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

/** A plain-text table of the report (models side by side) followed by the failures. */
export function formatEvalReport(report: EvalReport, opts: { failures?: boolean } = {}): string {
  const head = ['model', 'pass', 'rate', 'in tok', 'out tok', 'cost', '$/pass', 'avg s']
  const rows = report.models.map((s) => [
    s.model,
    `${s.passed}/${s.total}`,
    `${Math.round(s.passRate * 100)}%`,
    String(s.inputTokens),
    String(s.outputTokens),
    money(s.cost),
    money(s.costPerPass),
    (s.avgDurationMs / 1000).toFixed(1),
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')
  const out = [`Eval: ${report.suite}`, line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)]
  if (opts.failures !== false) {
    const failed = report.attempts.filter((a) => !a.pass)
    if (failed.length) {
      out.push('', 'Failures:')
      for (const a of failed) {
        out.push(`  [${a.model}] ${a.case}${a.attempt > 1 ? ` (run ${a.attempt})` : ''}`)
        for (const f of a.failures) out.push(`    - ${f.check}: ${f.reason}`)
      }
    }
  }
  return out.join('\n')
}
