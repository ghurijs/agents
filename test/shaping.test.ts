import { ImproperlyConfigured } from '@ghuri/core'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { formatToolReport, toolReport } from '../src/evals/index'
import {
  Agent,
  checkToolInput,
  compactValue,
  describeTool,
  FIND_TOOLS,
  McpServer,
  ModelTools,
  searchTools,
  shapeResult,
  standaloneTool,
  tool,
} from '../src/index'
import { backends, makeUser, useHarness } from './helpers'
import { Note, Order } from './models'

type Part = { type: 'text'; text: string } | { type: 'tool-call'; toolName: string; input: unknown }

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

/** A scripted model that records which tools each call was given. */
function recordingModel(steps: Array<Part[] | ((prompt: any[]) => Part[])>) {
  const seenTools: string[][] = []
  let i = 0
  let id = 0
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'rec',
    doGenerate: async (options: any) => {
      seenTools.push((options.tools ?? []).map((t: any) => t.name).sort())
      const step = steps[i++] ?? [{ type: 'text', text: 'done' }]
      const parts = typeof step === 'function' ? step(options.prompt) : step
      const content = parts.map((p) =>
        p.type === 'tool-call'
          ? {
              type: 'tool-call',
              toolCallId: `c${++id}`,
              toolName: p.toolName,
              input: JSON.stringify(p.input),
            }
          : p,
      )
      const calls = content.some((c) => c.type === 'tool-call')
      return {
        content,
        finishReason: { unified: calls ? 'tool-calls' : 'stop', raw: undefined },
        usage,
        warnings: [],
      } as any
    },
  })
  return { model, seenTools }
}

function lastToolOutput(prompt: any[]): any {
  const tool = prompt.filter((p: any) => p.role === 'tool').at(-1)
  return tool?.content?.[0]?.output
}

describe('checkToolInput()', () => {
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Title' },
      status: { type: 'string', enum: ['DRAFT', 'ACTIVE'] },
      price: { type: 'number' },
      qty: { type: ['integer', 'null'] },
      tags: { type: 'array' },
      live: { type: 'boolean' },
    },
    required: ['title'],
  }

  it('accepts valid arguments, numeric strings and string booleans', () => {
    expect(
      checkToolInput(schema, { title: 'x', status: 'DRAFT', price: '12.50', qty: null, live: 'true' }),
    ).toEqual([])
  })

  it('reports unknown and missing arguments, enum values and types', () => {
    expect(
      checkToolInput(schema, { colour: 'red', status: 'LIVE', price: 'cheap', qty: 1.5, tags: 'a' }),
    ).toEqual([
      "unknown argument 'colour' (allowed: title, status, price, qty, tags, live)",
      "missing required argument 'title'",
      "'status' must be one of DRAFT, ACTIVE (got LIVE)",
      "'price' must be number (got cheap)",
      "'qty' must be integer (got 1.5)",
      "'tags' must be array (got a)",
    ])
    expect(checkToolInput(schema, 'title')).toEqual(['arguments must be a JSON object'])
    expect(checkToolInput({ type: 'object', properties: {} }, { a: 1 })).toEqual([
      "unknown argument 'a' (this tool takes no arguments)",
    ])
    expect(checkToolInput({ type: 'object', properties: {}, additionalProperties: true }, { a: 1 })).toEqual(
      [],
    )
    expect(
      checkToolInput(
        { type: 'object', properties: { s: { anyOf: [{ const: 'a' }, { const: 'b' }] } } },
        { s: 'c' },
      ),
    ).toEqual(["'s' must be one of a, b (got c)"])
  })
})

describe('result shaping', () => {
  it('keeps fields of objects, arrays and paginated lists, and drops empty values', () => {
    const page = {
      count: 1,
      next: null,
      previous: null,
      results: [{ id: 1, title: 'A', body: '', tags: [] }],
    }
    expect(shapeResult(page, { fields: ['id', 'title'] })).toEqual({
      ...page,
      results: [{ id: 1, title: 'A' }],
    })
    expect(shapeResult(page, { compact: true })).toEqual({ count: 1, results: [{ id: 1, title: 'A' }] })
    expect(shapeResult([{ id: 1, x: 2 }], { fields: ['id'] })).toEqual([{ id: 1 }])
    expect(shapeResult({ id: 1, x: 2 }, { fields: ['id'] })).toEqual({ id: 1 })
    expect(compactValue({ a: 0, b: false, c: { d: null }, e: [{ f: '' }] })).toEqual({
      a: 0,
      b: false,
      e: [{}],
    })
  })

  it('appends examples to descriptions', () => {
    expect(describeTool({ description: 'Do it.' })).toBe('Do it.')
    expect(describeTool({ description: 'Do it.', examples: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }] })).toBe(
      'Do it.\n\nExample input: {"a":1}\nExample input: {"a":2}\nExample input: {"a":3}',
    )
  })

  it('searches tools by name, title and description, singular or plural', () => {
    const t = (name: string, description: string) => ({
      name,
      description,
      inputSchema: {},
      execute: () => 1,
    })
    const tools = [
      t('products_update', 'Update some fields of a product.'),
      t('orders_list', 'List orders.'),
      t('theme_publish', 'Publish the draft theme so the store shows it.'),
    ]
    expect(searchTools(tools, 'change the price of a product').map((x) => x.name)).toEqual([
      'products_update',
    ])
    expect(searchTools(tools, 'show my order')[0].name).toBe('orders_list')
    expect(searchTools(tools, 'store theme').map((x) => x.name)).toEqual(['theme_publish'])
    expect(searchTools(tools, 'the of')).toEqual([])
  })
})

for (const using of backends) {
  describe(`tool shaping in agents (${using})`, () => {
    useHarness(() => ({ using }))

    const orderTools = (extra: Record<string, unknown> = {}) =>
      new ModelTools(Order, {
        filter: (qs, user) => qs.filter({ customer: user.pk }),
        filterFields: ['status'],
        ...extra,
      })

    it('strictToolInput returns argument problems to the model; off by default', async () => {
      const alice = await makeUser('alice')
      const steps = () => [
        [{ type: 'tool-call', toolName: 'orders_list', input: { colour: 'red', page: 'two' } }] as Part[],
        (prompt: any[]) => [{ type: 'text', text: JSON.stringify(lastToolOutput(prompt)) }] as Part[],
      ]
      class Loose extends Agent {
        override model = recordingModel(steps()).model
        override tools = [orderTools()]
        override permissionClasses = []
      }
      const loose = await new Loose().run('orders?', { user: alice, memory: false })
      // Without the check, the unknown argument is ignored and the bad page fails later, less clearly.
      expect(loose.toolCalls[0].error).toBe('Invalid page. (HTTP 404)')

      class Strict extends Loose {
        override model = recordingModel(steps()).model
        override strictToolInput = true
      }
      const strict = await new Strict().run('orders?', { user: alice, memory: false })
      expect(strict.toolCalls[0].error).toBe(
        "Invalid arguments for orders_list: unknown argument 'colour' (allowed: status, page, pageSize); 'page' must be integer (got two).",
      )
      // The history keeps the arguments the model sent.
      expect(strict.toolCalls[0].input).toEqual({ colour: 'red', page: 'two' })
      expect(strict.text).toContain('unknown argument')
    })

    it('ModelTools resultFields and compact shorten results', async () => {
      const alice = await makeUser('alice')
      await Order.objects.create({ number: 'A-1', customer: alice, total: '5.00' } as any)
      const [list, retrieve] = orderTools({
        resultFields: { list: ['number', 'status'] },
        compact: true,
      }).getTools()
      const page: any = await list.execute({}, { user: alice })
      expect(page).toEqual({ count: 1, results: [{ number: 'A-1', status: 'open' }] })
      const id = (await Order.objects.get({ number: 'A-1' })).pk
      const one: any = await retrieve.execute({ id }, { user: alice })
      expect(one).toMatchObject({ number: 'A-1', total: '5.00' })
      const notes = new ModelTools(Note, { compact: true }).getTools()[1]
      const note = await Note.objects.create({ title: 'n' } as any)
      expect(await notes.execute({ id: note.pk }, { user: alice })).toEqual({ id: note.pk, title: 'n' })
    })

    it('examples show in agent tools and MCP listings', async () => {
      const tools = orderTools({ examples: { list: [{ status: 'open' }] } }).getTools()
      expect(tools[0].examples).toEqual([{ status: 'open' }])
      const custom = tool({
        name: 'greet',
        description: 'Greet someone.',
        input: z.object({ name: z.string() }),
        examples: [{ name: 'Rifa' }],
        execute: ({ name }) => `hi ${name}`,
      })
      const server = new McpServer({ tools: [...tools, custom] })
      const listed = server.listTools().map((t: any) => t.description)
      expect(listed[0]).toContain('Example input: {"status":"open"}')
      expect(listed[2]).toBe('Greet someone.\n\nExample input: {"name":"Rifa"}')
    })

    it('toolSearch sends only find_tools and loads tools on request, across turns', async () => {
      const alice = await makeUser('alice')
      await Order.objects.create({ number: 'A-1', customer: alice, total: '5.00' } as any)
      const rec = recordingModel([
        [{ type: 'tool-call', toolName: FIND_TOOLS, input: { query: 'list my orders' } }],
        [{ type: 'tool-call', toolName: 'orders_list', input: {} }],
        (prompt) => [{ type: 'text', text: `count ${lastToolOutput(prompt)?.value?.count}` }],
        [{ type: 'tool-call', toolName: 'orders_list', input: {} }],
        [{ type: 'text', text: 'again' }],
      ])
      class Searching extends Agent {
        override model = rec.model
        override tools = [
          orderTools(),
          tool({ name: 'now', description: 'Current time.', execute: () => 'noon' }),
        ]
        override permissionClasses = []
        override toolSearch = { alwaysLoaded: ['now'] }
      }
      const first = await new Searching().run('How many orders?', { user: alice })
      expect(first.text).toBe('count 1')
      expect(rec.seenTools.slice(0, 3)).toEqual([
        ['find_tools', 'now'],
        ['find_tools', 'now', 'orders_list', 'orders_retrieve'],
        ['find_tools', 'now', 'orders_list', 'orders_retrieve'],
      ])
      expect((first.toolCalls[0].output as any).loaded.map((l: any) => l.name)).toEqual([
        'orders_list',
        'orders_retrieve',
      ])
      // The next turn of the same conversation keeps what was loaded.
      const second = await new Searching().run('And now?', {
        user: alice,
        conversationId: first.conversationId,
      })
      expect(second.text).toBe('again')
      expect(rec.seenTools[3]).toEqual(['find_tools', 'now', 'orders_list', 'orders_retrieve'])
    })

    it('toolSearch: the instructions mention find_tools, and the description lists what it can load', async () => {
      const rec = recordingModel([[{ type: 'text', text: 'ok' }]])
      let system = ''
      const model = rec.model as any
      const original = model.doGenerate.bind(model)
      model.doGenerate = async (options: any) => {
        system = options.prompt.find((p: any) => p.role === 'system')?.content ?? ''
        const t = options.tools.find((x: any) => x.name === FIND_TOOLS)
        expect(t.description).toContain('Tools you can load: orders_list, orders_retrieve')
        return original(options)
      }
      class Searching extends Agent {
        override model = model
        override instructions = 'Be brief.'
        override tools = [orderTools()]
        override permissionClasses = []
        override toolSearch = true
        override memory = false as const
      }
      await new Searching().run('hi')
      expect(system).toContain('Be brief.')
      expect(system).toContain('call find_tools first')
    })

    it('toolSearch rejects unknown alwaysLoaded names and a clashing find_tools tool', async () => {
      class Bad extends Agent {
        override model = recordingModel([]).model
        override tools: any[] = [orderTools()]
        override permissionClasses = []
        override toolSearch: any = { alwaysLoaded: ['nope'] }
        override memory = false as const
      }
      await expect(new Bad().run('hi')).rejects.toBeInstanceOf(ImproperlyConfigured)
      class Clash extends Bad {
        override tools: any[] = [tool({ name: FIND_TOOLS, description: 'Mine.', execute: () => 1 })]
        override toolSearch: any = true
      }
      await expect(new Clash().run('hi')).rejects.toThrow(/named 'find_tools'/)
    })

    it('toolReport measures tool size and finds undocumented arguments', () => {
      const custom = tool({
        name: 'greet',
        description: 'Greet someone.',
        input: { type: 'object', properties: { name: { type: 'string' } } },
        execute: () => 'hi',
      })
      const greetTool = standaloneTool(custom)
      const rows = toolReport([...orderTools().getTools(), greetTool])
      const greet = rows.find((r) => r.name === 'greet')!
      expect(greet.undocumented).toEqual(['name'])
      expect(greet.approxTokens).toBe(
        Math.ceil(
          ('greet'.length + 'Greet someone.'.length + JSON.stringify(greetTool.inputSchema).length) / 4,
        ),
      )
      const text = formatToolReport(rows)
      expect(text.split('\n')[0]).toMatch(/^tool\s+~tokens/)
      expect(text).toMatch(/total\s+\d+\s+3 tools/)
    })
  })
}
