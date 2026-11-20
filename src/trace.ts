import { Signal } from '@ghuri/core'
import type { LanguageModel, LanguageModelUsage } from 'ai'
import type { Agent, AgentRunContext, AgentRunResult } from './agent'
import { captureCarried } from './carry'
import { memoryAvailable } from './memory'
import { Run } from './models'
import { agentsSettings } from './settings'

/** Arguments of `runFinished` (the sender is the agent's class). */
export interface RunFinishedArgs {
  agent: Agent
  /** The run's context: agent name, user, conversation, messages. */
  context: AgentRunContext
  /** `'<provider>:<model-id>'`. */
  model: string
  /** The result of a successful run. */
  result?: AgentRunResult
  /** Why the run failed (model or provider error). */
  error?: unknown
  durationMs: number
  /** The `Run` row, when `AGENTS.TRACE_RUNS` is on and it was saved. */
  run?: Run
}

/**
 * Sent after every agent run (`run()`, `stream()` once the stream ends, queued runs), successful or failed.
 * Receivers that throw are logged and never fail the run. For metering, alerts and custom traces.
 *
 * ```ts
 * runFinished.connect(async ({ model, result }) => {
 *   if (result) await recordUsage(model, result.usage)
 * })
 * ```
 */
export const runFinished = new Signal<RunFinishedArgs>('runFinished')

/** `'<provider>:<model-id>'` of an agent's model (a string id as given). */
export function modelLabel(model: string | LanguageModel | null | undefined): string {
  if (!model) return ''
  if (typeof model === 'string') return model
  const m = model as { provider?: string; modelId?: string }
  return [m.provider, m.modelId].filter(Boolean).join(':')
}

/** `AGENTS.TRACE_RUNS`: write a `Run` row per run (off by default). */
export function traceSettings(): { enabled: boolean; messages: boolean } {
  const t = agentsSettings().TRACE_RUNS
  if (!t) return { enabled: false, messages: false }
  return { enabled: true, messages: typeof t === 'object' && t.messages === true }
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) => {
        if (v instanceof Uint8Array) return `[${v.byteLength} bytes]`
        if (v instanceof URL) return v.toString()
        return v
      }),
    )
  } catch {
    return null
  }
}

function count(n: number | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

function usageFields(usage: LanguageModelUsage | undefined): Record<string, unknown> {
  if (!usage) return {}
  return {
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    cachedInputTokens: count(usage.inputTokenDetails?.cacheReadTokens),
    usage: jsonSafe(usage),
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}

let warned = false

async function saveRun(args: Omit<RunFinishedArgs, 'run'>, messages: boolean): Promise<Run | undefined> {
  const { context: ctx, result, error } = args
  try {
    return await Run.objects.create({
      agent: ctx.agentName,
      model: args.model.slice(0, 200),
      ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
      ...(ctx.user?.isAuthenticated && ctx.user.pk !== null ? { userId: ctx.user.pk } : {}),
      status: error ? 'error' : 'ok',
      finishReason: (result?.finishReason ?? '').slice(0, 30),
      steps: result?.steps ?? 0,
      ...usageFields(result?.usage),
      toolCalls: (result?.toolCalls ?? []).map((c) => ({
        toolName: c.toolName,
        input: jsonSafe(c.input),
        ...(c.error ? { error: c.error } : {}),
      })),
      messages: messages ? jsonSafe(result ? result.messages : ctx.newMessages) : null,
      context: captureCarried(),
      error: error ? errorText(error) : '',
      durationMs: count(args.durationMs),
    } as any)
  } catch (err) {
    if (!warned) {
      warned = true
      console.warn(
        `[ghuri.agents] AGENTS.TRACE_RUNS is on but the run could not be saved (did you run \`ghuri migrate\`?): ${errorText(err)}`,
      )
    }
    return undefined
  }
}

/** Save the trace (when enabled) and send `runFinished`. Never throws. */
export async function recordRun(args: Omit<RunFinishedArgs, 'run'>): Promise<void> {
  const trace = traceSettings()
  const run = trace.enabled && memoryAvailable() ? await saveRun(args, trace.messages) : undefined
  if (!runFinished.hasListeners(args.agent.constructor)) return
  try {
    await runFinished.send(args.agent.constructor, { ...args, ...(run ? { run } : {}) })
  } catch (err) {
    console.error('[ghuri.agents] a runFinished receiver failed:', err)
  }
}
