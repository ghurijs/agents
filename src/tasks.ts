// Background runs on @ghuri/tasks, without depending on it: when @ghuri/tasks is loaded it publishes `task()` and
// `getTask()` on `globalThis[Symbol.for('ghuri.tasks.interop')]`, and agents define the `agents.run` task through
// that. On Workers a dynamic import of a package that is not installed breaks the bundle, so there is no import.
import { apps, ImproperlyConfigured } from '@ghuri/core'
import type { Agent, AgentInput } from './agent'
import { createConversation, memoryAvailable, ownerPk, titleFrom } from './memory'
import { type EnqueueOptions, loadJobUser } from './queue'
import { agentsSettings } from './settings'

/** Name of the task that runs queued agents. */
export const AGENT_TASK_NAME = 'agents.run'
/** Attempts of a queued run before its task result is `FAILED`. */
export const AGENT_TASK_MAX_ATTEMPTS = 3

/** The argument of the `agents.run` task. */
export interface AgentTaskJob {
  /** Registered agent name. */
  agent: string
  input: AgentInput
  /** Primary key of the user to run as (null: anonymous). */
  userId: unknown
  conversationId?: string
  context?: Record<string, unknown>
}

/** What the `agents.run` task returns (its `TaskResult.returnValue`). */
export interface AgentTaskReturn {
  conversationId: string | null
  text: string
  finishReason: string
}

/** The parts of an `@ghuri/tasks` `TaskResult` agents use. */
export interface AgentTaskResult {
  id: string
  status: 'READY' | 'RUNNING' | 'FAILED' | 'SUCCESSFUL'
  refresh(): Promise<void>
  readonly returnValue: AgentTaskReturn
}

interface TaskLike {
  modulePath: string
  using(overrides: Record<string, unknown>): TaskLike
  enqueue(job: AgentTaskJob): Promise<AgentTaskResult>
}

interface TasksInterop {
  version: 1
  task(fn: (job: AgentTaskJob) => Promise<AgentTaskReturn>, options: Record<string, unknown>): TaskLike
  getTask(name: string): TaskLike | undefined
}

/** `@ghuri/tasks`' interop object when it is loaded in this process, else undefined. */
export function tasksInterop(): TasksInterop | undefined {
  const interop = (globalThis as Record<symbol, unknown>)[Symbol.for('ghuri.tasks.interop')] as
    | TasksInterop
    | undefined
  return interop?.version === 1 ? interop : undefined
}

// ---- agents by name ------------------------------------------------------------------------------------------

type AgentClass = new () => Agent

const REGISTRY_KEY = Symbol.for('ghuri.agents.agentClasses')
function agentClasses(): Map<string, Set<AgentClass>> {
  const g = globalThis as Record<symbol, unknown>
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map<string, Set<AgentClass>>()
  return g[REGISTRY_KEY] as Map<string, Set<AgentClass>>
}

/**
 * Make `agentClass` runnable by name from background tasks. `AgentRouter.register()` calls it; call it yourself for
 * agents you enqueue without a router.
 */
export function registerAgent(name: string, agentClass: AgentClass): void {
  const registry = agentClasses()
  const classes = registry.get(name) ?? new Set<AgentClass>()
  classes.add(agentClass)
  registry.set(name, classes)
}

/** A fresh instance of the agent registered as `name`. */
export function createRegisteredAgent(name: string): Agent {
  const classes = agentClasses().get(name)
  if (!classes?.size) {
    throw new ImproperlyConfigured(
      `No agent registered as '${name}': register it with an AgentRouter (or registerAgent()) in a module the worker loads.`,
    )
  }
  if (classes.size > 1) {
    throw new ImproperlyConfigured(
      `'${name}' names ${classes.size} different agent classes (registered by different routers); give them different names.`,
    )
  }
  const [cls] = classes
  const agent = new cls()
  agent.agentName = name
  return agent
}

// ---- the agents.run task -------------------------------------------------------------------------------------

/** Run a queued agent job (the body of the `agents.run` task). */
export async function runAgentJob(job: AgentTaskJob): Promise<AgentTaskReturn> {
  const agent = createRegisteredAgent(job.agent)
  const user = await loadJobUser(job.userId)
  const result = await agent.run(job.input, {
    user,
    conversationId: job.conversationId ?? null,
    context: job.context,
  })
  return {
    conversationId: result.conversationId ?? job.conversationId ?? null,
    text: result.text,
    finishReason: result.finishReason,
  }
}

/** The `agents.run` task, defined on first use; undefined when `@ghuri/tasks` is not loaded. */
export function agentRunTask(): TaskLike | undefined {
  const interop = tasksInterop()
  if (!interop) return undefined
  return (
    interop.getTask(AGENT_TASK_NAME) ??
    interop.task(runAgentJob, { name: AGENT_TASK_NAME, maxAttempts: AGENT_TASK_MAX_ATTEMPTS })
  )
}

// Define the task when apps load, so a worker knows `agents.run` before the first message arrives.
const HOOK_KEY = Symbol.for('ghuri.agents.taskHook')
if (!(globalThis as Record<symbol, unknown>)[HOOK_KEY]) {
  ;(globalThis as Record<symbol, unknown>)[HOOK_KEY] = true
  apps.onPopulate(() => {
    agentRunTask()
  })
}

// ---- enqueue -------------------------------------------------------------------------------------------------

/**
 * How `agent.enqueue()` runs: `'tasks'` (the `agents.run` task on `@ghuri/tasks`) or `'queue'` (a job on the
 * `AGENTS.QUEUE_BINDING` Cloudflare Queue, run by `AgentRouter.consumeQueue()`). `AGENTS.ENQUEUE` decides; without
 * it, an explicit binding (`AGENTS.QUEUE_BINDING` or `opts.binding`) means `'queue'`, else `'tasks'` when
 * `@ghuri/tasks` is loaded.
 */
export function enqueueMode(opts: EnqueueOptions = {}): 'tasks' | 'queue' {
  const settings = agentsSettings()
  if (opts.binding) return 'queue'
  if (settings.ENQUEUE === 'tasks') {
    if (!tasksInterop()) {
      throw new ImproperlyConfigured(
        "AGENTS.ENQUEUE is 'tasks' but @ghuri/tasks is not installed or not imported.",
      )
    }
    return 'tasks'
  }
  if (settings.ENQUEUE === 'queue') return 'queue'
  if (settings.QUEUE_BINDING) return 'queue'
  return tasksInterop() ? 'tasks' : 'queue'
}

/** Enqueue a run as the `agents.run` task. The conversation is created up front (when memory is available). */
export async function enqueueAsTask(
  agent: Agent,
  input: AgentInput,
  opts: EnqueueOptions = {},
): Promise<{ conversationId?: string; taskResult: AgentTaskResult; taskResultId: string }> {
  const t = agentRunTask()
  if (!t) throw new ImproperlyConfigured('@ghuri/tasks is not loaded.')
  let conversationId = opts.conversationId ?? undefined
  if (!conversationId && agent.memory !== false && memoryAvailable()) {
    const conv = await createConversation(agent.getName(), opts.user, { title: titleFrom(input) })
    conversationId = String(conv.pk)
  }
  const options = agentsSettings().TASK ?? {}
  const overrides: Record<string, unknown> = {}
  for (const key of ['backend', 'queueName', 'priority'] as const) {
    if (options[key] !== undefined) overrides[key] = options[key]
  }
  const configured = Object.keys(overrides).length ? t.using(overrides) : t
  const taskResult = await configured.enqueue({
    agent: agent.getName(),
    input,
    userId: ownerPk(opts.user),
    ...(conversationId ? { conversationId } : {}),
    ...(opts.context ? { context: opts.context } : {}),
  })
  return { conversationId, taskResult, taskResultId: taskResult.id }
}
