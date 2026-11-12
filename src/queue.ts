import {
  anonymousUser,
  apps,
  ImproperlyConfigured,
  type MessageBatchLike,
  onQueue,
  type RequestUser,
  tryGetContext,
} from '@ghuri/core'
import type { Agent, AgentInput } from './agent'
import { createConversation, memoryAvailable, ownerPk, titleFrom } from './memory'
import { agentsSettings } from './settings'

/** Message body sent to the queue by `enqueue()`. */
export interface AgentJob {
  type: 'ghuri.agents.run'
  agent: string
  input: AgentInput
  /** Primary key of the user to run as (null: anonymous). */
  userId: unknown
  conversationId?: string
  context?: Record<string, unknown>
}

export const AGENT_JOB_TYPE = 'ghuri.agents.run'

export interface EnqueueOptions {
  user?: RequestUser | null
  conversationId?: string | null
  /** Queue producer binding (default `AGENTS.QUEUE_BINDING`, else `'AGENTS_QUEUE'`). */
  binding?: string
  context?: Record<string, unknown>
}

/**
 * Send a run to a Cloudflare Queue (consumed by `AgentRouter.consumeQueue()`). A conversation is created up
 * front (when memory is available) so callers can poll it.
 */
export async function enqueueRun(
  agent: Agent,
  input: AgentInput,
  opts: EnqueueOptions = {},
): Promise<{ conversationId?: string }> {
  const name = opts.binding ?? agentsSettings().QUEUE_BINDING ?? 'AGENTS_QUEUE'
  const queue = tryGetContext()?.env?.[name]
  if (!queue || typeof queue.send !== 'function') {
    throw new ImproperlyConfigured(
      `Queue producer binding '${name}' not found: add it to wrangler.jsonc ("queues": { "producers": [...] }) or set AGENTS.QUEUE_BINDING.`,
    )
  }
  let conversationId = opts.conversationId ?? undefined
  if (!conversationId && agent.memory !== false && memoryAvailable()) {
    const conv = await createConversation(agent.getName(), opts.user, { title: titleFrom(input) })
    conversationId = String(conv.pk)
  }
  const job: AgentJob = {
    type: AGENT_JOB_TYPE,
    agent: agent.getName(),
    input,
    userId: ownerPk(opts.user),
    ...(conversationId ? { conversationId } : {}),
    ...(opts.context ? { context: opts.context } : {}),
  }
  await queue.send(job)
  return { conversationId }
}

/** Load the user a queued run acts for (`AUTH_USER_MODEL`); anonymous when `userId` is null. */
export async function loadJobUser(userId: unknown): Promise<RequestUser> {
  if (userId === null || userId === undefined) return anonymousUser
  const label = (tryGetContext()?.settings.AUTH_USER_MODEL as string | undefined) ?? 'auth.User'
  const model = apps.getModel(label) as any
  return model.objects.get({ pk: userId })
}

/**
 * Register a queue consumer running queued agent jobs with `create(name)` (an `AgentRouter`'s factory).
 * Messages that are not agent jobs are left alone; failed runs are retried.
 */
export function consumeAgentQueue(queue: string, create: (name: string) => Agent): () => void {
  return onQueue(queue, async (batch: MessageBatchLike<any>) => {
    for (const msg of batch.messages) {
      const job = msg.body as AgentJob
      if (!job || job.type !== AGENT_JOB_TYPE) continue
      try {
        const agent = create(job.agent)
        const user = await loadJobUser(job.userId)
        await agent.run(job.input, {
          user,
          conversationId: job.conversationId ?? null,
          context: job.context,
        })
        msg.ack()
      } catch (err) {
        console.error(`[ghuri.agents] queued run of '${job.agent}' failed:`, err)
        msg.retry()
      }
    }
  })
}
