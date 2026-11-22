// Queued runs on @ghuri/tasks: `agent.enqueue()` becomes the `agents.run` task when @ghuri/tasks is loaded.
import { AsyncLocalStorage } from 'node:async_hooks'
import { AuthConfig, AuthTokenConfig, ContentTypesConfig, SessionsConfig } from '@ghuri/auth'
import { registerContextCarrier, unregisterContextCarrier } from '@ghuri/core'
import { DBTaskResult, database, runWorker, TasksConfig } from '@ghuri/tasks'
import { dummy, useTaskBackend } from '@ghuri/tasks/testing'
import { describe, expect, it } from 'vitest'
import {
  AGENT_TASK_NAME,
  Agent,
  AgentRouter,
  AgentsConfig,
  agentRunTask,
  Conversation,
  createRegisteredAgent,
  enqueueMode,
  Message,
  UsageLimitExceeded,
} from '../src/index'
import { makeUser, useHarness } from './helpers'
import { scriptedModel } from './mock'
import { ShopConfig } from './models'

const INSTALLED_APPS = [
  ContentTypesConfig,
  AuthConfig,
  SessionsConfig,
  AuthTokenConfig,
  ShopConfig,
  AgentsConfig,
  TasksConfig,
]

const seen: Array<{ user: string | null; store: string | undefined }> = []
const store = new AsyncLocalStorage<string>()

class Helper extends Agent {
  override model = scriptedModel(
    Array.from({ length: 20 }, () => [{ type: 'text' as const, text: 'Done in the background.' }]),
  )
  override permissionClasses = []
  override async beforeRun(ctx: any) {
    seen.push({ user: ctx.user?.isAuthenticated ? ctx.user.username : null, store: store.getStore() })
  }
}

let failures = 0
class Broken extends Agent {
  override model = scriptedModel(
    Array.from({ length: 20 }, () => () => {
      failures++
      throw new Error('model down')
    }),
  )
  override permissionClasses = []
}

const router = new AgentRouter().register('helper', Helper).register('broken', Broken)

async function messagesOf(conversationId: string | undefined): Promise<string[]> {
  const rows: any[] = await Message.objects.filter({ conversation: conversationId }).orderBy('id')
  return rows.map((r) => r.role)
}

describe('agents on @ghuri/tasks', () => {
  useHarness(() => ({ settings: { INSTALLED_APPS, TASKS: { default: database({ queues: [] }) } } }))

  it('defines the agents.run task when apps load and picks tasks mode', () => {
    expect(agentRunTask()?.modulePath).toBe(AGENT_TASK_NAME)
    expect(enqueueMode()).toBe('tasks')
    expect(enqueueMode({ binding: 'AGENTS_QUEUE' })).toBe('queue')
  })

  it('enqueue() stores the task; a worker runs it as the user, with the request context', async () => {
    seen.length = 0
    registerContextCarrier({
      name: 'store',
      capture: () => store.getStore(),
      restore: (v, fn) => store.run(v, fn),
    })
    try {
      const alice = await makeUser('alice')
      const { conversationId, taskResult, taskResultId } = await store.run('s-7', () =>
        router.create('helper').enqueue('summarize my week', { user: alice }),
      )
      expect(taskResult!.status).toBe('READY')
      expect(taskResultId).toBe(taskResult!.id)
      const row = await DBTaskResult.objects.get({ pk: taskResultId })
      expect([row.taskPath, row.maxAttempts, row.carried]).toEqual(['agents.run', 3, { store: 's-7' }])
      expect(row.args).toEqual([
        { agent: 'helper', input: 'summarize my week', userId: alice.id, conversationId },
      ])
      expect(await Conversation.objects.filter({ id: conversationId }).count()).toBe(1)
      expect(await messagesOf(conversationId)).toEqual([])

      expect((await runWorker({ batch: true })).processed).toBe(1)
      await taskResult!.refresh()
      expect(taskResult!.status).toBe('SUCCESSFUL')
      expect(taskResult!.returnValue).toEqual({
        conversationId,
        text: 'Done in the background.',
        finishReason: 'stop',
      })
      expect(await messagesOf(conversationId)).toEqual(['user', 'assistant'])
      expect(seen).toEqual([{ user: 'alice', store: 's-7' }])
    } finally {
      unregisterContextCarrier('store')
    }
  })

  it('retries a failing run, then fails the task without saving messages', async () => {
    failures = 0
    const { backend, restore } = useTaskBackend(dummy({ queues: [] }))
    try {
      const { conversationId, taskResult } = await router.create('broken').enqueue('try')
      await backend.runPending()
      expect(taskResult!.status).toBe('FAILED')
      expect((taskResult as any).attempts).toBe(3)
      expect(failures).toBe(3)
      expect(await messagesOf(conversationId)).toEqual([])
    } finally {
      restore()
    }
  })

  it('AGENTS.TASK chooses the backend, queue and priority', async () => {
    const { backend, restore } = useTaskBackend(dummy({ queues: ['default', 'agents'] }), 'slow')
    try {
      const { getContext } = await import('@ghuri/core')
      const settings = getContext().settings as any
      settings.AGENTS = { TASK: { backend: 'slow', queueName: 'agents', priority: 5 } }
      try {
        const { taskResult } = await router.create('helper').enqueue('later')
        expect(backend.results).toHaveLength(1)
        expect([backend.results[0].task.queueName, backend.results[0].task.priority]).toEqual(['agents', 5])
        expect(taskResult!.status).toBe('READY')
      } finally {
        delete settings.AGENTS
      }
    } finally {
      restore()
    }
  })

  it('AGENTS.QUEUE_BINDING or AGENTS.ENQUEUE keep the Cloudflare Queue path', async () => {
    const { getContext } = await import('@ghuri/core')
    const settings = getContext().settings as any
    try {
      settings.AGENTS = { QUEUE_BINDING: 'AGENTS_QUEUE' }
      expect(enqueueMode()).toBe('queue')
      settings.AGENTS = { ENQUEUE: 'queue' }
      expect(enqueueMode()).toBe('queue')
      settings.AGENTS = { QUEUE_BINDING: 'AGENTS_QUEUE', ENQUEUE: 'tasks' }
      expect(enqueueMode()).toBe('tasks')
    } finally {
      delete settings.AGENTS
    }
  })

  it('AGENTS.USAGE_LIMITS: enqueue() refuses up front; a queued run over the limit fails its task', async () => {
    const { getContext } = await import('@ghuri/core')
    const settings = getContext().settings as any
    const { backend, restore } = useTaskBackend(dummy({ queues: [] }))
    try {
      settings.AGENTS = { USAGE_LIMITS: { user: { day: 10 } } }
      const alice = await makeUser('alice')
      const first = await router.create('helper').enqueue('one', { user: alice })
      const second = await router.create('helper').enqueue('two', { user: alice }) // nothing counted yet
      await backend.runPending()
      expect(first.taskResult!.status).toBe('SUCCESSFUL')
      expect(second.taskResult!.status).toBe('FAILED')
      expect((second.taskResult as any).errors.at(-1).exceptionClassPath).toMatch(/UsageLimitExceeded/)
      expect(await messagesOf(second.conversationId)).toEqual([])

      const conversations = await Conversation.objects.count()
      await expect(router.create('helper').enqueue('three', { user: alice })).rejects.toBeInstanceOf(
        UsageLimitExceeded,
      )
      expect(backend.results).toHaveLength(2)
      expect(await Conversation.objects.count()).toBe(conversations)
    } finally {
      delete settings.AGENTS
      restore()
    }
  })

  it('needs agents to be registered by name', async () => {
    class Lonely extends Agent {
      override model = scriptedModel([[{ type: 'text', text: 'hi' }]])
      override permissionClasses = []
    }
    const { taskResult } = await useBackendImmediately(() => new Lonely().enqueue('hello'))
    expect(taskResult!.status).toBe('FAILED')
    expect(() => createRegisteredAgent('lonely')).toThrow(/No agent registered as 'lonely'/)

    class OtherHelper extends Agent {}
    new AgentRouter().register('helper', OtherHelper)
    expect(() => createRegisteredAgent('helper')).toThrow(/names 2 different agent classes/)
  })
})

/** Enqueue on the dummy backend and run it at once. */
async function useBackendImmediately<T extends { taskResult?: any }>(fn: () => Promise<T>): Promise<T> {
  const { backend, restore } = useTaskBackend(dummy({ queues: [] }))
  try {
    const out = await fn()
    await backend.runPending()
    return out
  } finally {
    restore()
  }
}
