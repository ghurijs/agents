import { taskHandlers } from '@ghuri/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agent, AgentRouter, Conversation, Message, ModelTools } from '../src/index'
import { backends, makeUser, useHarness } from './helpers'
import { scriptedModel } from './mock'
import { Order } from './models'

for (const using of backends) {
  describe(`streaming and queued runs (${using})`, () => {
    const h = useHarness(() => ({ using }))
    afterEach(() => taskHandlers.clear())

    it('agent.stream(): text stream, UI chunks, then saves the conversation', async () => {
      const alice = await makeUser('alice')
      await Order.objects.create({ number: 'A-1', customer: alice, total: '1.00' } as any)
      class Streamer extends Agent {
        static override agentName = 'streamer'
        override model = scriptedModel([
          [{ type: 'tool-call', toolName: 'orders_list', input: {} }],
          [{ type: 'text', text: 'One order found.' }],
        ])
        override tools = [new ModelTools(Order, { filter: (qs, user) => qs.filter({ customer: user.pk }) })]
      }
      const stream = await new Streamer().stream('orders?', { user: alice })
      expect(stream.conversationId).toMatch(/^[0-9a-f-]{36}$/)
      let text = ''
      for await (const delta of stream.textStream) text += delta
      expect(text).toBe('One order found.')
      const result = await stream.done
      expect(result.text).toBe('One order found.')
      expect(result.toolCalls[0]).toMatchObject({ toolName: 'orders_list' })
      expect((result.toolCalls[0].output as any).count).toBe(1)
      const rows = await Message.objects.filter({ conversation: stream.conversationId }).count()
      expect(rows).toBe(4)
    })

    it('enqueue() sends a job; consumeQueue() runs it as the user', async () => {
      const alice = await makeUser('alice')
      const sent: any[] = []
      h.env.AGENTS_QUEUE = { send: async (body: unknown) => void sent.push(body) }
      class Worker extends Agent {
        override model = scriptedModel([[{ type: 'text', text: 'Background done.' }]])
        override permissionClasses = []
      }
      const router = new AgentRouter().register('worker', Worker)
      const { conversationId } = await router.create('worker').enqueue('do it later', { user: alice })
      expect(sent).toEqual([
        { type: 'ghuri.agents.run', agent: 'worker', input: 'do it later', userId: alice.id, conversationId },
      ])
      expect(await Conversation.objects.filter({ id: conversationId }).count()).toBe(1)

      router.consumeQueue('agents')
      const [handler] = taskHandlers.queuesFor('agents')
      const msg = { id: '1', timestamp: new Date(), body: sent[0], ack: vi.fn(), retry: vi.fn() }
      const other = { id: '2', timestamp: new Date(), body: { hello: 1 }, ack: vi.fn(), retry: vi.fn() }
      await handler({ queue: 'agents', messages: [msg, other], ackAll: vi.fn(), retryAll: vi.fn() }, h.ctx)
      expect(msg.ack).toHaveBeenCalled()
      expect(other.ack).not.toHaveBeenCalled()
      const rows: any[] = await Message.objects.filter({ conversation: conversationId }).orderBy('id')
      expect(rows.map((r) => r.role)).toEqual(['user', 'assistant'])
      expect(rows[1].content).toEqual([{ type: 'text', text: 'Background done.' }])
      delete h.env.AGENTS_QUEUE
    })
  })
}
