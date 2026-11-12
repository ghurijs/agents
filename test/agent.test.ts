import { IsAdminUser, IsAuthenticated, ModelSerializer, ModelViewSet } from '@ghuri/rest'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  Agent,
  type AgentRunContext,
  Conversation,
  ConversationNotFound,
  Message,
  ModelTools,
  ToolError,
  tool,
  ViewSetTools,
} from '../src/index'
import { backends, makeUser, useHarness } from './helpers'
import { scriptedModel, toolOutputs } from './mock'
import { Order, Ticket } from './models'

class TicketSerializer extends ModelSerializer<Ticket> {
  static Meta = {
    model: Ticket,
    fields: ['id', 'subject', 'body', 'author', 'closed'],
    readOnlyFields: ['author'],
  }
}

class TicketViewSet extends ModelViewSet<Ticket> {
  queryset = Ticket.objects.all()
  serializerClass = TicketSerializer
  permissionClasses = [IsAuthenticated]

  override async performCreate(serializer: any): Promise<void> {
    await serializer.save({ authorId: this.request.user.pk })
  }
}

class AdminOnlyTickets extends TicketViewSet {
  override permissionClasses = [IsAdminUser]
}

function makeAgent(model: any) {
  return class SupportAgent extends Agent {
    static override agentName = 'support'
    override model = model
    override instructions = (ctx: AgentRunContext) =>
      `You help ${ctx.user.isAuthenticated ? 'customers' : 'visitors'}.`
    override tools = [
      new ModelTools(Order, {
        actions: ['list', 'retrieve', 'update'],
        filter: (qs, user) => qs.filter({ customer: user.pk }),
        searchFields: ['number'],
      }),
      new ViewSetTools(TicketViewSet, { actions: ['create', 'list'] }),
      new ViewSetTools(AdminOnlyTickets, { actions: ['list'], prefix: 'admin_tickets' }),
    ]
    refunded: number[] = []

    @tool({ description: 'Refund an order', input: z.object({ orderId: z.number() }) })
    async refund({ orderId }: { orderId: number }, { user }: { user: any }) {
      const order: any = await Order.objects.filter({ id: orderId, customer: user.pk }).first()
      if (!order) throw new ToolError(`Order ${orderId} not found.`, { status: 404 })
      order.status = 'refunded'
      await order.save()
      this.refunded.push(orderId)
      return { refunded: orderId }
    }
  }
}

for (const using of backends) {
  describe(`agent runs (${using})`, () => {
    useHarness(() => ({ using }))

    async function seed() {
      const alice = await makeUser('alice')
      const bob = await makeUser('bob')
      const o1: any = await Order.objects.create({ number: 'A-1', customer: alice, total: '10.00' } as any)
      const o2: any = await Order.objects.create({ number: 'A-2', customer: alice, total: '25.50' } as any)
      const o3: any = await Order.objects.create({ number: 'B-1', customer: bob, total: '99.00' } as any)
      return { alice, bob, o1, o2, o3 }
    }

    it('runs a multi-step tool loop over ModelTools, ViewSetTools and custom tools', async () => {
      const { alice, o1, o2 } = await seed()
      let listed: any
      const model = scriptedModel([
        [{ type: 'tool-call', toolName: 'orders_list', input: {} }],
        (prompt) => {
          listed = toolOutputs(prompt)[0]
          return [
            { type: 'tool-call', toolName: 'refund', input: { orderId: o2.id } },
            {
              type: 'tool-call',
              toolName: 'tickets_create',
              input: { subject: 'Refund issued', body: 'A-2' },
            },
          ]
        },
        [{ type: 'text', text: 'Refunded order A-2 and opened a ticket.' }],
      ])
      const Support = makeAgent(model)
      const agent = new Support()
      const result = await agent.run('Refund my most expensive order', { user: alice })

      expect(result.text).toBe('Refunded order A-2 and opened a ticket.')
      expect(result.steps).toBe(3)
      expect(result.toolCalls.map((c) => c.toolName)).toEqual(['orders_list', 'refund', 'tickets_create'])
      expect(result.toolCalls.every((c) => c.error === undefined)).toBe(true)
      // the list was paginated and scoped
      expect(listed.type).toBe('json')
      expect(listed.value.count).toBe(2)
      expect(listed.value.results.map((o: any) => o.number)).toEqual(['A-1', 'A-2'])
      expect(agent.refunded).toEqual([o2.id])
      expect((await Order.objects.get({ id: o2.id })).status).toBe('refunded')
      expect((await Order.objects.get({ id: o1.id })).status).toBe('open')
      const ticket: any = await Ticket.objects.get({ subject: 'Refund issued' })
      expect(ticket.authorId).toBe(alice.id)
      // instructions and tool definitions reached the model
      const call = model.doGenerateCalls[0] as any
      expect(call.prompt[0]).toMatchObject({ role: 'system', content: 'You help customers.' })
      expect(call.tools.map((t: any) => t.name)).toEqual(
        expect.arrayContaining([
          'orders_list',
          'orders_retrieve',
          'orders_update',
          'tickets_create',
          'refund',
        ]),
      )
      expect(result.usage.inputTokens).toBe(30)
    })

    it('scopes data with filter: other users rows are invisible (404 tool error)', async () => {
      const { alice, o3 } = await seed()
      const model = scriptedModel([
        [{ type: 'tool-call', toolName: 'orders_retrieve', input: { id: o3.id } }],
        [{ type: 'tool-call', toolName: 'orders_update', input: { id: o3.id, status: 'shipped' } }],
        [{ type: 'text', text: 'Sorry.' }],
      ])
      const result = await new (makeAgent(model))().run('Show order B-1', { user: alice })
      expect(result.text).toBe('Sorry.')
      expect(result.toolCalls[0].error).toMatch(/HTTP 404/)
      expect(result.toolCalls[1].error).toMatch(/HTTP 404/)
      expect((await Order.objects.get({ id: o3.id })).status).toBe('open')
    })

    it('returns permission denials and validation errors to the model as tool errors', async () => {
      const { alice } = await seed()
      let seen: any[] = []
      const model = scriptedModel([
        [
          { type: 'tool-call', toolName: 'admin_tickets_list', input: {} },
          { type: 'tool-call', toolName: 'tickets_create', input: { body: 'no subject' } },
          { type: 'tool-call', toolName: 'refund', input: { orderId: 'abc' } },
        ],
        (prompt) => {
          seen = toolOutputs(prompt)
          return [{ type: 'text', text: 'I could not do that.' }]
        },
      ])
      const result = await new (makeAgent(model))().run('List all tickets', { user: alice })
      expect(result.text).toBe('I could not do that.')
      const errors = Object.fromEntries(result.toolCalls.map((c) => [c.toolName, c.error]))
      expect(errors.admin_tickets_list).toMatch(/permission.*HTTP 403/i)
      expect(errors.tickets_create).toMatch(/HTTP 400/)
      expect(errors.tickets_create).toMatch(/subject/)
      expect(errors.refund).toMatch(/orderId/)
      expect(seen.map((s) => s.type)).toEqual(['error-text', 'error-text', 'error-text'])
      expect(await Ticket.objects.count()).toBe(0)
    })

    it('anonymous users get authentication errors from protected viewsets', async () => {
      await seed()
      const model = scriptedModel([
        [{ type: 'tool-call', toolName: 'tickets_list', input: {} }],
        [{ type: 'text', text: 'Please log in.' }],
      ])
      const result = await new (makeAgent(model))().run('my tickets?')
      expect(result.toolCalls[0].error).toMatch(/credentials were not provided/i)
    })

    it('persists conversations across runs and enforces ownership', async () => {
      const { alice, bob } = await seed()
      const model = scriptedModel([
        [{ type: 'text', text: 'Hello Alice!' }],
        (prompt) => [{ type: 'text', text: `I remember ${prompt.length} messages.` }],
        [{ type: 'text', text: 'never' }],
      ])
      const Support = makeAgent(model)
      const first = await new Support().run('Hi, I am Alice', { user: alice })
      expect(first.conversationId).toMatch(/^[0-9a-f-]{36}$/)
      const conv: any = await Conversation.objects.get({ id: first.conversationId })
      expect(conv.agent).toBe('support')
      expect(conv.title).toBe('Hi, I am Alice')
      expect(conv.userId).toBe(alice.id)

      const second = await new Support().run('What did I say?', {
        user: alice,
        conversationId: first.conversationId,
      })
      expect(second.conversationId).toBe(first.conversationId)
      // system + user + assistant + user
      expect(second.text).toBe('I remember 4 messages.')
      const rows = await Message.objects.filter({ conversation: first.conversationId }).orderBy('id')
      expect(rows.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
      expect(rows[0].content).toBe('Hi, I am Alice')

      await expect(
        new Support().run('hijack', { user: bob, conversationId: first.conversationId }),
      ).rejects.toBeInstanceOf(ConversationNotFound)
      await expect(
        new Support().run('anon', { conversationId: first.conversationId }),
      ).rejects.toBeInstanceOf(ConversationNotFound)
    })

    it('stores tool calls and results in message content', async () => {
      const { alice } = await seed()
      const model = scriptedModel([
        [{ type: 'tool-call', toolName: 'orders_list', input: { search: 'A-1' } }],
        [{ type: 'text', text: 'Found it.' }],
      ])
      const res = await new (makeAgent(model))().run('find A-1', { user: alice })
      const rows: any[] = await Message.objects.filter({ conversation: res.conversationId }).orderBy('id')
      expect(rows.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
      expect(rows[1].content[0]).toMatchObject({
        type: 'tool-call',
        toolName: 'orders_list',
        input: { search: 'A-1' },
      })
      expect(rows[2].content[0]).toMatchObject({ type: 'tool-result', toolName: 'orders_list' })
      expect(rows[2].content[0].output.value.count).toBe(1)
    })

    it('hooks: beforeRun, onToolCall (can refuse), afterRun; memory can be turned off', async () => {
      const { alice } = await seed()
      const events: string[] = []
      const model = scriptedModel([
        [{ type: 'tool-call', toolName: 'orders_list', input: {} }],
        [{ type: 'text', text: 'ok' }],
      ])
      class Hooked extends makeAgent(model) {
        override memory = false
        override beforeRun(ctx: AgentRunContext) {
          events.push(`before:${ctx.newMessages.length}`)
        }
        override onToolCall(call: { toolName: string }) {
          events.push(`tool:${call.toolName}`)
          throw new ToolError('Tool calls are disabled right now.')
        }
        override afterRun(result: any) {
          events.push(`after:${result.text}`)
        }
      }
      const res = await new Hooked().run('list', { user: alice })
      expect(events).toEqual(['before:1', 'tool:orders_list', 'after:ok'])
      expect(res.toolCalls[0].error).toBe('Tool calls are disabled right now.')
      expect(res.conversationId).toBeUndefined()
      expect(await Conversation.objects.count()).toBe(0)
    })

    it('checks agent permission classes when asked', async () => {
      const { alice } = await seed()
      class StaffAgent extends Agent {
        override model = scriptedModel([[{ type: 'text', text: 'hi' }]])
        override permissionClasses = [IsAdminUser]
      }
      await expect(new StaffAgent().run('hi', { user: alice, checkPermissions: true })).rejects.toThrow(
        /permission/i,
      )
      await expect(new StaffAgent().run('hi', { checkPermissions: true })).rejects.toThrow(/credentials/i)
      expect((await StaffAgent.run('hi', { user: alice, memory: false })).text).toBe('hi')
    })
  })
}
