// Token usage limits (ARCHITECTURE.md §22): count each run's tokens per subject (user / tenant / anonymous client)
// and window (UTC day / month) in `agents_usage`, and refuse runs of subjects over their `AGENTS.USAGE_LIMITS`.
import { ImproperlyConfigured, type RequestUser, Signal } from '@ghuri/core'
import { F, Q } from '@ghuri/orm'
import { type APIRequest, BaseThrottle } from '@ghuri/rest'
import type { LanguageModelUsage } from 'ai'
import type { Agent } from './agent'
import { captureCarried } from './carry'
import { UsageLimitExceeded } from './errors'
import { memoryAvailable } from './memory'
import { USAGE_PERIODS, Usage, type UsagePeriod, type UsageScope } from './models'
import { agentsSettings } from './settings'

/** Token budgets of one subject: tokens (input + output) per UTC day and month. Absent or null: no limit. */
export interface UsageLimits {
  day?: number | null
  month?: number | null
}

/** Who a run counts against. */
export interface UsageSubject {
  scope: UsageScope
  /** The user pk, the tenant pk, or the anonymous client's address (`'*'` without a request). */
  key: string
  /** The run's user (anonymous for `anon`). */
  user: RequestUser
}

/** A function returning a subject's limits (a billing plan, a staff exemption…). */
export type UsageLimitsFunction = (
  subject: UsageSubject,
) => UsageLimits | null | undefined | Promise<UsageLimits | null | undefined>

/** `AGENTS.USAGE_LIMITS`: limits per scope (numbers or a function), or one function for every scope. */
export type UsageLimitsSetting =
  | {
      user?: UsageLimits | UsageLimitsFunction | null
      tenant?: UsageLimits | UsageLimitsFunction | null
      anon?: UsageLimits | UsageLimitsFunction | null
    }
  | UsageLimitsFunction

/** A subject's usage in one window (`getUsage()`, `GET …/usage/`). */
export interface UsageWindow {
  scope: UsageScope
  key: string
  period: UsagePeriod
  /** First day of the window, `'YYYY-MM-DD'` (UTC). */
  start: string
  /** When the window ends and the count starts again from zero. */
  resetsAt: Date
  /** Tokens counted so far (`totalTokens`). */
  used: number
  /** The limit, or null when the subject has none for this period. */
  limit: number | null
  /** `max(limit - used, 0)`, or null without a limit. */
  remaining: number | null
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  runs: number
}

/** Tokens of one run, as counted. */
export interface UsageTokens {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  totalTokens: number
}

/** Arguments of `usageLimitReached` (sender: the agent's class). */
export interface UsageLimitReachedArgs {
  agent: Agent
  user: RequestUser
  /** The window that refused the run. */
  error: UsageLimitExceeded
  /** Every subject of the refused run. */
  subjects: UsageSubject[]
}

/** Arguments of `usageRecorded` (sender: the agent's class). */
export interface UsageRecordedArgs {
  agent: Agent
  user: RequestUser
  subjects: UsageSubject[]
  tokens: UsageTokens
}

/**
 * Sent when a run (or an `enqueue()`) is refused because a subject used its token budget. Receivers that throw are
 * logged. For notifications and upsells.
 */
export const usageLimitReached = new Signal<UsageLimitReachedArgs>('usageLimitReached')

/**
 * Sent after a run's tokens were added to the usage counters. Receivers that throw are logged. Call `getUsage()` in
 * a receiver to warn subjects close to their limit.
 */
export const usageRecorded = new Signal<UsageRecordedArgs>('usageRecorded')

// ---- settings ------------------------------------------------------------------------------------------------

/** `AGENTS.USAGE_LIMITS`, or undefined when usage limits are off. */
export function usageLimitsSetting(): UsageLimitsSetting | undefined {
  const s = agentsSettings().USAGE_LIMITS
  return s && (typeof s === 'function' || typeof s === 'object') ? s : undefined
}

/** Is usage counted for `scope`? (a function counts every scope; an object the scopes it names). */
function scopeCounted(setting: UsageLimitsSetting, scope: UsageScope): boolean {
  if (typeof setting === 'function') return true
  return Object.hasOwn(setting, scope) && setting[scope] !== undefined
}

/** The limits of `subject` under the current settings (null: none). */
export async function usageLimitsFor(subject: UsageSubject): Promise<UsageLimits | null> {
  const setting = usageLimitsSetting()
  if (!setting) return null
  const value = typeof setting === 'function' ? setting : setting[subject.scope]
  const limits = typeof value === 'function' ? await value(subject) : value
  return limits && typeof limits === 'object' ? limits : null
}

function limitOf(limits: UsageLimits | null, period: UsagePeriod): number | null {
  const n = limits?.[period]
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

// ---- subjects and windows ------------------------------------------------------------------------------------

class IdentThrottle extends BaseThrottle {
  allowRequest(): boolean {
    return true
  }
}

/** The client address of a request, as DRF's throttles see it (`getIdent()`, `NUM_PROXIES`). */
export function clientIdent(request: APIRequest | undefined): string {
  if (!request) return '*'
  try {
    return new IdentThrottle().getIdent(request) || '*'
  } catch {
    return '*'
  }
}

/**
 * The subjects a run of `user` counts against, under the current settings: the user (or the anonymous client) and
 * the carried tenant. Empty when `AGENTS.USAGE_LIMITS` is not set.
 */
export function usageSubjects(
  user: RequestUser,
  opts: { request?: APIRequest; tenant?: string | null } = {},
): UsageSubject[] {
  const setting = usageLimitsSetting()
  if (!setting) return []
  const out: UsageSubject[] = []
  if (user.isAuthenticated && user.pk !== null && user.pk !== undefined) {
    if (scopeCounted(setting, 'user')) out.push({ scope: 'user', key: String(user.pk), user })
  } else if (scopeCounted(setting, 'anon')) {
    out.push({ scope: 'anon', key: clientIdent(opts.request).slice(0, 100), user })
  }
  const tenant = opts.tenant === undefined ? captureCarried().tenant : opts.tenant
  if (tenant && scopeCounted(setting, 'tenant')) out.push({ scope: 'tenant', key: String(tenant), user })
  return out
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** The current window of `period`: its first day and when it ends (UTC). */
export function usageWindow(period: UsagePeriod, now: Date = new Date()): { start: string; resetsAt: Date } {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  if (period === 'month') {
    return { start: isoDay(new Date(Date.UTC(y, m, 1))), resetsAt: new Date(Date.UTC(y, m + 1, 1)) }
  }
  const d = now.getUTCDate()
  return { start: isoDay(new Date(Date.UTC(y, m, d))), resetsAt: new Date(Date.UTC(y, m, d + 1)) }
}

function rowKey(scope: string, key: string, period: string, start: string): string {
  return `${scope}\u0000${key}\u0000${period}\u0000${start}`
}

async function currentRows(subjects: UsageSubject[], now: Date): Promise<Map<string, Usage>> {
  const starts = USAGE_PERIODS.map((p) => usageWindow(p, now).start)
  const rows: Usage[] = await Usage.objects.filter({
    scope__in: [...new Set(subjects.map((s) => s.scope))],
    key__in: [...new Set(subjects.map((s) => s.key))],
    start__in: [...new Set(starts)],
  } as any)
  const out = new Map<string, Usage>()
  for (const r of rows) out.set(rowKey(r.scope, r.key, r.period, String(r.start)), r)
  return out
}

function windowOf(
  subject: UsageSubject,
  period: UsagePeriod,
  row: Usage | undefined,
  limit: number | null,
  now: Date,
): UsageWindow {
  const { start, resetsAt } = usageWindow(period, now)
  const used = Number(row?.totalTokens ?? 0)
  return {
    scope: subject.scope,
    key: subject.key,
    period,
    start,
    resetsAt,
    used,
    limit,
    remaining: limit === null ? null : Math.max(limit - used, 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    cachedInputTokens: Number(row?.cachedInputTokens ?? 0),
    runs: Number(row?.runs ?? 0),
  }
}

async function windowsFor(subjects: UsageSubject[], now: Date): Promise<UsageWindow[]> {
  if (!subjects.length) return []
  const rows = await currentRows(subjects, now)
  const out: UsageWindow[] = []
  for (const subject of subjects) {
    const limits = await usageLimitsFor(subject)
    for (const period of USAGE_PERIODS) {
      const { start } = usageWindow(period, now)
      const row = rows.get(rowKey(subject.scope, subject.key, period, start))
      out.push(windowOf(subject, period, row, limitOf(limits, period), now))
    }
  }
  return out
}

// ---- check, record, read -------------------------------------------------------------------------------------

/**
 * Refuse a run of `subjects` when one of them used its budget: throws `UsageLimitExceeded` (naming the window that
 * resets last) and sends `usageLimitReached`. Returns the subjects to count the run against.
 */
export async function checkUsage(
  agent: Agent,
  user: RequestUser,
  opts: { request?: APIRequest } = {},
): Promise<UsageSubject[]> {
  const subjects = usageSubjects(user, opts)
  if (!subjects.length) return subjects
  if (!memoryAvailable()) {
    throw new ImproperlyConfigured(
      'AGENTS.USAGE_LIMITS needs the agents app: add AgentsConfig to INSTALLED_APPS and run `ghuri migrate`.',
    )
  }
  const now = new Date()
  let worst: UsageWindow | undefined
  for (const w of await windowsFor(subjects, now)) {
    if (w.limit === null || w.used < w.limit) continue
    if (!worst || w.resetsAt > worst.resetsAt) worst = w
  }
  if (!worst) return subjects
  const subject = subjects.find((s) => s.scope === worst.scope && s.key === worst.key)!
  const error = new UsageLimitExceeded({
    subject,
    period: worst.period,
    limit: worst.limit!,
    used: worst.used,
    resetsAt: worst.resetsAt,
    wait: Math.max(0, Math.ceil((worst.resetsAt.getTime() - now.getTime()) / 1000)),
  })
  await sendRobust(usageLimitReached, agent, { agent, user, error, subjects })
  throw error
}

function count(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** The tokens a run's usage counts for. */
export function usageTokens(usage: LanguageModelUsage | undefined): UsageTokens {
  const inputTokens = count(usage?.inputTokens)
  const outputTokens = count(usage?.outputTokens)
  const total = count(usage?.totalTokens)
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: count(usage?.inputTokenDetails?.cacheReadTokens),
    totalTokens: total || inputTokens + outputTokens,
  }
}

let warned = false

/**
 * Add a run's tokens to the current day and month of every subject: missing rows are inserted (conflicts ignored),
 * then all of them are incremented in the database, so concurrent runs lose nothing. Never throws.
 */
export async function recordUsage(
  agent: Agent,
  user: RequestUser,
  subjects: UsageSubject[],
  usage: LanguageModelUsage | undefined,
): Promise<void> {
  if (!subjects.length || !memoryAvailable()) return
  const tokens = usageTokens(usage)
  try {
    const now = new Date()
    const keys = subjects.flatMap((s) =>
      USAGE_PERIODS.map((period) => ({
        scope: s.scope,
        key: s.key,
        period,
        start: usageWindow(period, now).start,
      })),
    )
    await insertMissing(keys)
    await Usage.objects.filter(Q.or(...keys)).update({
      inputTokens: F('inputTokens').add(tokens.inputTokens),
      outputTokens: F('outputTokens').add(tokens.outputTokens),
      cachedInputTokens: F('cachedInputTokens').add(tokens.cachedInputTokens),
      totalTokens: F('totalTokens').add(tokens.totalTokens),
      runs: F('runs').add(1),
      updatedAt: now,
    })
  } catch (err) {
    if (!warned) {
      warned = true
      console.warn(
        `[ghuri.agents] AGENTS.USAGE_LIMITS is set but usage could not be saved (did you run \`ghuri migrate\`?): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    return
  }
  await sendRobust(usageRecorded, agent, { agent, user, subjects, tokens })
}

async function insertMissing(
  keys: Array<{ scope: UsageScope; key: string; period: UsagePeriod; start: string }>,
): Promise<void> {
  await Usage.objects.bulkCreate(
    keys.map((k) => new Usage(k as any)),
    { ignoreConflicts: true },
  )
}

/**
 * The current day and month usage of a user (or anonymous client) and of the tenant (default: the carried one),
 * with limits, for a "you have used X of Y tokens" UI. Empty when `AGENTS.USAGE_LIMITS` is not set.
 */
export async function getUsage(opts: {
  user: RequestUser
  tenant?: string | number | null
  request?: APIRequest
}): Promise<UsageWindow[]> {
  const subjects = usageSubjects(opts.user, {
    request: opts.request,
    ...(opts.tenant !== undefined ? { tenant: opts.tenant === null ? null : String(opts.tenant) } : {}),
  })
  if (!subjects.length || !memoryAvailable()) return []
  return windowsFor(subjects, new Date())
}

/** JSON of a usage window (dates as ISO strings). */
export function usageWindowJSON(w: UsageWindow): Record<string, unknown> {
  return { ...w, resetsAt: w.resetsAt.toISOString() }
}

async function sendRobust<A extends object>(signal: Signal<A>, agent: Agent, args: A): Promise<void> {
  if (!signal.hasListeners(agent.constructor)) return
  try {
    await signal.send(agent.constructor, args)
  } catch (err) {
    const name = signal === usageLimitReached ? 'usageLimitReached' : 'usageRecorded'
    console.error(`[ghuri.agents] a ${name} receiver failed:`, err)
  }
}
