import { action, DefaultRouter, IsAuthenticated, ModelSerializer, ModelViewSet } from '@ghuri/rest'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent, ModelTools, RouterTools, sanitizeToolName, tool, ViewSetTools } from '../src/index'
import { useHarness } from './helpers'
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

  @action({ detail: true, methods: ['post'], description: 'Close a ticket.' })
  async close() {
    const t: any = await (this as any).getObject()
    t.closed = true
    await t.save()
    return { closed: true }
  }
}

class HelperAgent extends Agent {
  tools = [tool({ name: 'now', description: 'Current time', execute: () => 'noon' })]
  static override tools = {
    lookup: tool({ description: 'Look something up', input: z.object({ q: z.string().describe('Query') }) }),
  }

  async lookup({ q }: { q: string }) {
    return `found ${q}`
  }

  @tool({ description: 'Add two numbers', input: z.object({ a: z.number(), b: z.number().default(1) }) })
  async add({ a, b }: { a: number; b: number }) {
    return a + b
  }
}

describe('tool names', () => {
  it('sanitizes', () => {
    expect(sanitizeToolName('blog posts.list')).toBe('blog_posts_list')
    expect(sanitizeToolName('__x__')).toBe('x')
    expect(sanitizeToolName('a'.repeat(80))).toHaveLength(64)
  })
})

describe('declared tools', () => {
  it('collects @tool methods, static tools and standalone tools with JSON Schemas', async () => {
    const agent = new HelperAgent()
    const tools = agent.getTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['add', 'lookup', 'now'])
    const add = tools.find((t) => t.name === 'add')!
    expect(add.inputSchema).toMatchObject({
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number', default: 1 } },
      required: ['a'],
    })
    expect(add.parse!({ a: 2 })).toEqual({ a: 2, b: 1 })
    expect(() => add.parse!({ a: 'x' })).toThrow(/Invalid arguments: a:/)
    expect(await add.execute({ a: 2, b: 3 }, { user: {} as any })).toBe(5)
    const lookup = tools.find((t) => t.name === 'lookup')!
    expect(lookup.inputSchema.properties).toEqual({ q: { type: 'string', description: 'Query' } })
    expect(await lookup.execute({ q: 'x' }, { user: {} as any })).toBe('found x')
    expect(tools.find((t) => t.name === 'now')!.inputSchema).toEqual({ type: 'object', properties: {} })
  })

  it('rejects duplicate names', () => {
    class Dup extends Agent {
      tools = [tool({ name: 'add', description: 'x', execute: () => 1 })]
      @tool({ description: 'Add' })
      async add() {
        return 1
      }
    }
    expect(() => new Dup().getTools()).toThrow(/two tools named 'add'/)
  })
})

describe('generated tools', () => {
  useHarness()

  it('ModelTools: one tool per action with serializer / filter / pagination schemas', () => {
    const tools = new ModelTools(Order, {
      actions: ['list', 'retrieve', 'create', 'update', 'delete'],
      searchFields: ['number'],
      orderingFields: ['createdAt', 'total'],
      filterFields: ['status'],
    }).getTools()
    expect(tools.map((t) => t.name)).toEqual([
      'orders_list',
      'orders_retrieve',
      'orders_create',
      'orders_update',
      'orders_delete',
    ])
    const [list, retrieve, create, update, del] = tools
    expect(Object.keys(list.inputSchema.properties as object).sort()).toEqual(
      ['ordering', 'page', 'pageSize', 'search', 'status'].sort(),
    )
    expect(list.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(retrieve.inputSchema).toMatchObject({ required: ['id'], properties: { id: { type: 'integer' } } })
    expect(create.inputSchema.required).toEqual(expect.arrayContaining(['number', 'customer', 'total']))
    expect((create.inputSchema.properties as any).number).toMatchObject({ type: 'string', maxLength: 20 })
    expect((create.inputSchema.properties as any).status.enum).toEqual(['open', 'shipped', 'refunded'])
    expect(create.inputSchema.properties).not.toHaveProperty('id')
    expect(update.inputSchema.required).toEqual(['id'])
    expect(del.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false })
  })

  it('ModelTools defaults to read-only actions', () => {
    expect(new ModelTools(Order).getTools().map((t) => t.name)).toEqual(['orders_list', 'orders_retrieve'])
  })

  it('ViewSetTools: standard and extra actions, aliases', () => {
    const tools = new ViewSetTools(TicketViewSet, {
      actions: ['list', 'create', 'close', 'delete'],
    }).getTools()
    expect(tools.map((t) => t.name)).toEqual([
      'tickets_list',
      'tickets_create',
      'tickets_close',
      'tickets_delete',
    ])
    const create = tools[1]
    expect(Object.keys(create.inputSchema.properties as object).sort()).toEqual(['body', 'closed', 'subject'])
    expect(tools[2].description).toBe('Close a ticket.')
    expect(tools[2].inputSchema.required).toEqual(['id'])
    expect(() => new ViewSetTools(TicketViewSet, { actions: ['nope'] }).getTools()).toThrow(
      /no routed action/,
    )
  })

  it('RouterTools exposes a whole router with include / exclude / readOnly', () => {
    const router = new DefaultRouter()
    router.register('tickets', TicketViewSet)
    const all = new RouterTools(router).getTools().map((t) => t.name)
    expect(all).toEqual(
      expect.arrayContaining([
        'tickets_list',
        'tickets_create',
        'tickets_retrieve',
        'tickets_update',
        'tickets_partial_update',
        'tickets_destroy',
        'tickets_close',
      ]),
    )
    expect(new RouterTools(router, { readOnly: true }).getTools().map((t) => t.name)).toEqual([
      'tickets_list',
      'tickets_retrieve',
    ])
    expect(
      new RouterTools(router, { exclude: ['tickets_destroy'] }).getTools().map((t) => t.name),
    ).not.toContain('tickets_destroy')
    expect(new RouterTools(router, { exclude: ['tickets'] }).getTools()).toEqual([])
  })
})
