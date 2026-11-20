import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agent, ModelTools, Run, type RunFinishedArgs, runFinished } from '../src/index'
import { backends, makeUser, useHarness } from './helpers'
import { scriptedModel } from './mock'
import { Order } from './models'

function failingModel() {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'broken',
    doGenerate: async () => {
      throw new Error('provider down')
    },
  })
}

for (const using of backends) {
  describe(`run traces and runFinished (${using})`, () => {
    const h = useHarness(() => ({ using }))
    const seen: RunFinishedArgs[] = []
    const receiver = async (args: RunFinishedArgs) => void seen.push(args)

    function trace(value: unknown) {
      ;(h.ctx.settings as any).AGENTS = value === undefined ? undefined : { TRACE_RUNS: value }
    }

    afterEach(() => {
      trace(undefined)
      runFinished.disconnect(receiver)
      seen.length = 0
      vi.restoreAllMocks()
    })

    class Orders extends Agent {
      static override agentName = 'orders'
      override model = scriptedModel([
        [{ type: 'tool-call', toolName: 'orders_list', input: {} }],
        [{ type: 'text', text: 'One order.' }],
      ])
      override tools = [new ModelTools(Order, { filter: (qs, user) => qs.filter({ customer: user.pk }) })]
    }

    it('writes nothing by default, but still sends runFinished', async () => {
      runFinished.connect(receiver)
      const alice = await makeUser('alice')
      const r = await new Orders().run('orders?', { user: alice })
      expect(await Run.objects.count()).toBe(0)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ model: 'mock:mock-model', result: r })
      expect(seen[0].context.agentName).toBe('orders')
      expect(seen[0].run).toBeUndefined()
      expect(seen[0].durationMs).toBeGreaterThanOrEqual(0)
    })

    it('saves a Run with model, usage, tool calls and outcome when TRACE_RUNS is on', async () => {
      trace(true)
      runFinished.connect(receiver)
      const alice = await makeUser('alice')
      await Order.objects.create({ number: 'A-1', customer: alice, total: '1.00' } as any)
      const r = await new Orders().run('orders?', { user: alice })
      const run: any = await Run.objects.get({})
      expect(run).toMatchObject({
        agent: 'orders',
        model: 'mock:mock-model',
        status: 'ok',
        finishReason: 'stop',
        steps: 2,
        inputTokens: 20,
        outputTokens: 10,
        messages: null,
        error: '',
        context: {},
      })
      expect(String(run.conversationId)).toBe(r.conversationId)
      expect(String(run.userId)).toBe(String(alice.pk))
      expect(run.toolCalls).toEqual([{ toolName: 'orders_list', input: {} }])
      expect(run.usage.inputTokens).toBe(20)
      expect(seen[0].run?.pk).toBe(run.pk)
    })

    it('stores messages with { messages: true }', async () => {
      trace({ messages: true })
      class Echo extends Agent {
        override model = scriptedModel([[{ type: 'text', text: 'hi back' }]])
        override permissionClasses = []
        override memory = false as const
      }
      await new Echo().run('hi')
      const run: any = await Run.objects.get({})
      expect(run.conversationId).toBeNull()
      expect(run.userId).toBeNull()
      expect(run.messages).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] },
      ])
    })

    it('records failed runs and rethrows the error', async () => {
      trace(true)
      runFinished.connect(receiver)
      class Broken extends Agent {
        override model = failingModel()
        override permissionClasses = []
        override memory = false as const
      }
      await expect(new Broken().run('hi')).rejects.toThrow('provider down')
      const run: any = await Run.objects.get({})
      expect(run).toMatchObject({ status: 'error', model: 'mock:broken', error: 'provider down', steps: 0 })
      expect(seen[0].error).toBeInstanceOf(Error)
      expect(seen[0].result).toBeUndefined()
    })

    it('traces streamed runs when the stream ends', async () => {
      trace(true)
      const alice = await makeUser('alice')
      const stream = await new Orders().stream('orders?', { user: alice })
      for await (const _ of stream.textStream) {
        // drain
      }
      await stream.done
      const run: any = await Run.objects.get({})
      expect(run).toMatchObject({ agent: 'orders', status: 'ok', steps: 2 })
    })

    it('never fails a run because of a trace or a receiver', async () => {
      trace(true)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(Run.objects, 'create').mockRejectedValue(new Error('no such table: agents_run'))
      const bad = async () => {
        throw new Error('receiver bug')
      }
      runFinished.connect(bad)
      try {
        const alice = await makeUser('alice')
        const r = await new Orders().run('orders?', { user: alice })
        expect(r.text).toBe('One order.')
        expect(error).toHaveBeenCalled()
      } finally {
        runFinished.disconnect(bad)
      }
      expect(warn.mock.calls.length).toBeLessThanOrEqual(1)
    })
  })
}
