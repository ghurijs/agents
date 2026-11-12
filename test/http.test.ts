import { SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'
import { include, path } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import { Agent, AgentRouter, Conversation, Message, ModelTools, tool } from '../src/index'
import { backends, makeUser, tokenFor, useHarness } from './helpers'
import { type ScriptStep, scriptedModel } from './mock'
import { Order } from './models'

class BearerTokenAuthentication extends TokenAuthentication {
  override keyword = 'Bearer'
}

let currentModel = scriptedModel([])
/** Script the model for the next requests (one shared mock across agent instances). */
function useScript(steps: ScriptStep[]) {
  currentModel = scriptedModel(steps)
}

const orderTools = () =>
  new ModelTools(Order, {
    actions: ['list', 'retrieve'],
    filter: (qs, user) => qs.filter({ customer: user.pk }),
  })

class SupportAgent extends Agent {
  static override description = 'Answers questions about your orders.'
  override model = currentModel
  override instructions = 'Be brief.'
  override tools = [orderTools()]
}

const agents = new AgentRouter()
agents.register('support', SupportAgent)

const now = tool({ name: 'now', description: 'Server time', execute: () => '12:00' })

function urls() {
  return [
    path('agents/', include(agents.urls)),
    path(
      'mcp/',
      agents.mcp({
        name: 'shop',
        version: '1.2.3',
        instructions: 'Shop tools.',
        tools: [orderTools(), now],
      }),
    ),
  ]
}

function sse(text: string): any[] {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((b) => b.startsWith('data:'))
    .map((b) => b.slice(5).trim())
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d))
}

for (const using of backends) {
  describe(`HTTP chat (${using})`, () => {
    const h = useHarness(() => ({
      using,
      urls,
      settings: { AGENTS: { AUTHENTICATION_CLASSES: [TokenAuthentication, SessionAuthentication] } },
    }))

    async function seed() {
      const alice = await makeUser('alice')
      const bob = await makeUser('bob')
      await Order.objects.create({ number: 'A-1', customer: alice, total: '10.00' } as any)
      await Order.objects.create({ number: 'B-1', customer: bob, total: '20.00' } as any)
      return { alice, bob }
    }

    it('answers JSON and continues conversations', async () => {
      const { alice } = await seed()
      useScript([
        [{ type: 'tool-call', toolName: 'orders_list', input: {} }],
        (prompt) => [
          { type: 'text', text: `You have ${JSON.stringify(prompt).includes('A-1') ? 'A-1' : '?'}` },
        ],
        (prompt) => [{ type: 'text', text: `history ${prompt.length}` }],
      ])
      h.api.forceAuthenticate(alice)
      const res = await h.api.post('/agents/support/chat', { message: 'my orders?' })
      expect(res.status).toBe(200)
      expect(res.data.text).toBe('You have A-1')
      expect(res.data.conversationId).toMatch(/^[0-9a-f-]{36}$/)
      expect(res.data.toolCalls[0]).toMatchObject({ toolName: 'orders_list' })
      expect(res.data.toolCalls[0].output.count).toBe(1)

      const again = await h.api.post('/agents/support/chat/', {
        message: 'and?',
        conversationId: res.data.conversationId,
      })
      expect(again.status).toBe(200)
      // system + user + assistant(tool call) + tool + assistant + user
      expect(again.data.text).toBe('history 6')
      expect(again.data.conversationId).toBe(res.data.conversationId)
    })

    it('requires authentication (default IsAuthenticated) and validates input', async () => {
      const { alice } = await seed()
      useScript([])
      const anon = await h.api.post('/agents/support/chat', { message: 'hi' })
      expect(anon.status).toBe(401)
      expect(anon.headers.get('www-authenticate')).toBe('Token')
      h.api.forceAuthenticate(alice)
      const bad = await h.api.post('/agents/support/chat', {})
      expect(bad.status).toBe(400)
      expect(bad.data.message).toBeDefined()
      const missing = await h.api.post('/agents/support/chat', {
        message: 'hi',
        conversationId: '00000000-0000-4000-8000-000000000000',
      })
      expect(missing.status).toBe(404)
    })

    it('streams SSE in the AI SDK UI message stream format and saves the conversation', async () => {
      const { alice } = await seed()
      useScript([
        [{ type: 'tool-call', toolName: 'orders_list', input: {} }],
        [{ type: 'text', text: 'You have one order.' }],
      ])
      h.api.forceAuthenticate(alice)
      const res = await h.api.post('/agents/support/chat', { message: 'stream please' }, {
        headers: { accept: 'text/event-stream' },
      } as any)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
      const conversationId = res.headers.get('x-conversation-id')
      const raw = await res.text()
      expect(raw.trim().endsWith('data: [DONE]')).toBe(true)
      const chunks = sse(raw)
      const types = chunks.map((c) => c.type)
      expect(types[0]).toBe('start')
      expect(chunks[0].messageMetadata).toEqual({ conversationId })
      expect(types).toEqual(
        expect.arrayContaining(['tool-input-available', 'tool-output-available', 'text-delta', 'finish']),
      )
      const output = chunks.find((c) => c.type === 'tool-output-available')
      expect(output.output.count).toBe(1)
      const text = chunks
        .filter((c) => c.type === 'text-delta')
        .map((c) => c.delta)
        .join('')
      expect(text).toBe('You have one order.')
      const rows = await Message.objects.filter({ conversation: conversationId }).orderBy('id')
      expect(rows.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    })

    it('streams with ?stream=1 and accepts useChat bodies', async () => {
      const { alice } = await seed()
      useScript([[{ type: 'text', text: 'hello there' }]])
      h.api.forceAuthenticate(alice)
      const res = await h.client.post('/agents/support/chat?stream=1', {
        json: { id: 'chat-1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] },
        headers: { 'x-ghuri-rest-force-auth': (h.api as any)._forceId },
      })
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const chunks = sse(await res.text())
      expect(
        chunks
          .filter((c) => c.type === 'text-delta')
          .map((c) => c.delta)
          .join(''),
      ).toBe('hello there')
      const conv: any = await Conversation.objects.first()
      expect(conv.title).toBe('hi')
    })

    it('lists, shows and deletes conversations (owner only)', async () => {
      const { alice, bob } = await seed()
      useScript([[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]])
      h.api.forceAuthenticate(alice)
      const a = await h.api.post('/agents/support/chat', { message: 'first' })
      await h.api.post('/agents/support/chat', { message: 'second' })
      const list = await h.api.get('/agents/support/conversations/')
      expect(list.status).toBe(200)
      expect(list.data.count).toBe(2)
      expect(list.data.results.map((c: any) => c.title).sort()).toEqual(['first', 'second'])

      const detail = await h.api.get(`/agents/support/conversations/${a.data.conversationId}/`)
      expect(detail.status).toBe(200)
      expect(detail.data.messages.map((m: any) => [m.role, m.content])).toEqual([
        ['user', 'first'],
        ['assistant', [{ type: 'text', text: 'one' }]],
      ])

      h.api.forceAuthenticate(bob)
      expect((await h.api.get('/agents/support/conversations/')).data.count).toBe(0)
      expect((await h.api.get(`/agents/support/conversations/${a.data.conversationId}/`)).status).toBe(404)
      expect((await h.api.delete(`/agents/support/conversations/${a.data.conversationId}/`)).status).toBe(404)

      h.api.forceAuthenticate(alice)
      expect((await h.api.delete(`/agents/support/conversations/${a.data.conversationId}/`)).status).toBe(204)
      expect((await h.api.get(`/agents/support/conversations/${a.data.conversationId}/`)).status).toBe(404)
      expect(await Message.objects.filter({ conversation: a.data.conversationId }).count()).toBe(0)
    })
  })

  describe(`MCP (${using})`, () => {
    const h = useHarness(() => ({
      using,
      urls,
      settings: {
        AGENTS: {
          AUTHENTICATION_CLASSES: [TokenAuthentication, BearerTokenAuthentication, SessionAuthentication],
        },
      },
    }))

    async function setup() {
      const alice = await makeUser('alice')
      const bob = await makeUser('bob')
      const a1: any = await Order.objects.create({ number: 'A-1', customer: alice, total: '10.00' } as any)
      const b1: any = await Order.objects.create({ number: 'B-1', customer: bob, total: '20.00' } as any)
      const key = await tokenFor(alice)
      let n = 0
      const rpc = async (method: string, params?: unknown, headers: Record<string, string> = {}) => {
        const res = await h.client.post('/mcp/', {
          json: { jsonrpc: '2.0', id: ++n, method, ...(params !== undefined ? { params } : {}) },
          headers: {
            authorization: `Token ${key}`,
            accept: 'application/json, text/event-stream',
            ...headers,
          },
        })
        return { status: res.status, body: res.status === 202 ? null : await res.json() } as any
      }
      return { alice, bob, a1, b1, key, rpc }
    }

    it('initialize negotiates the protocol version and describes the server', async () => {
      const { rpc } = await setup()
      const res = await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'shop', version: '1.2.3' },
          instructions: 'Shop tools.',
        },
      })
      const newer = await rpc('initialize', { protocolVersion: '2099-01-01', capabilities: {} })
      expect(newer.body.result.protocolVersion).toBe('2025-11-25')
      expect((await rpc('ping')).body.result).toEqual({})
    })

    it('accepts notifications with 202 and supports batches', async () => {
      const { key } = await setup()
      const note = await h.client.post('/mcp/', {
        json: { jsonrpc: '2.0', method: 'notifications/initialized' },
        headers: { authorization: `Token ${key}` },
      })
      expect(note.status).toBe(202)
      expect(await note.text()).toBe('')
      const batch = await h.client.post('/mcp/', {
        json: [
          { jsonrpc: '2.0', id: 'a', method: 'ping' },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
        ],
        headers: { authorization: `Token ${key}` },
      })
      const body = await batch.json()
      expect(body.map((r: any) => r.id)).toEqual(['a', 'b'])
      expect(body[1].result.tools.length).toBeGreaterThan(0)
    })

    it('tools/list exposes generated tools, standalone tools and agents with JSON Schemas', async () => {
      const { rpc } = await setup()
      const { body } = await rpc('tools/list')
      const tools = body.result.tools
      expect(tools.map((t: any) => t.name)).toEqual(['orders_list', 'orders_retrieve', 'now', 'ask_support'])
      for (const t of tools) expect(t.inputSchema.type).toBe('object')
      const retrieve = tools.find((t: any) => t.name === 'orders_retrieve')
      expect(retrieve.inputSchema.required).toEqual(['id'])
      expect(retrieve.annotations.readOnlyHint).toBe(true)
      const ask = tools.find((t: any) => t.name === 'ask_support')
      expect(ask.description).toBe('Answers questions about your orders.')
      expect(ask.inputSchema.required).toEqual(['message'])
    })

    it('tools/call runs as the token user with structured content; failures are isError results', async () => {
      const { rpc, b1 } = await setup()
      const list = await rpc('tools/call', { name: 'orders_list', arguments: {} })
      expect(list.body.result.isError).toBe(false)
      expect(list.body.result.structuredContent.count).toBe(1)
      expect(list.body.result.structuredContent.results[0].number).toBe('A-1')
      expect(JSON.parse(list.body.result.content[0].text).count).toBe(1)

      const other = await rpc('tools/call', { name: 'orders_retrieve', arguments: { id: b1.id } })
      expect(other.body.result.isError).toBe(true)
      expect(other.body.result.content[0].text).toMatch(/HTTP 404/)

      const invalid = await rpc('tools/call', { name: 'orders_retrieve', arguments: {} })
      expect(invalid.body.result.isError).toBe(true)
      expect(invalid.body.result.content[0].text).toMatch(/Missing required argument 'id'/)

      const text = await rpc('tools/call', { name: 'now' })
      expect(text.body.result).toEqual({ content: [{ type: 'text', text: '12:00' }], isError: false })

      const unknown = await rpc('tools/call', { name: 'nope', arguments: {} })
      expect(unknown.body.error).toMatchObject({ code: -32602, message: 'Unknown tool: nope' })
    })

    it('exposes agents as ask_<name> tools', async () => {
      const { rpc } = await setup()
      useScript([
        [{ type: 'tool-call', toolName: 'orders_list', input: {} }],
        (prompt) => [
          { type: 'text', text: JSON.stringify(prompt).includes('A-1') ? 'You have A-1.' : 'none' },
        ],
      ])
      const res = await rpc('tools/call', { name: 'ask_support', arguments: { message: 'my orders?' } })
      expect(res.body.result.isError).toBe(false)
      expect(res.body.result.structuredContent.text).toBe('You have A-1.')
      expect(res.body.result.structuredContent.conversationId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('answers JSON-RPC errors for bad requests', async () => {
      const { rpc, key } = await setup()
      const auth = { authorization: `Token ${key}`, 'content-type': 'application/json' }
      const parse = await h.client.post('/mcp/', { body: '{nope', headers: auth })
      expect(parse.status).toBe(400)
      expect((await parse.json()).error.code).toBe(-32700)
      const invalid = await h.client.post('/mcp/', {
        body: JSON.stringify({ id: 1, method: 'ping' }),
        headers: auth,
      })
      expect((await invalid.json()).error).toMatchObject({ code: -32600 })
      expect((await rpc('nope/method')).body.error).toMatchObject({ code: -32601 })
      expect((await rpc('tools/call', { arguments: {} })).body.error).toMatchObject({ code: -32602 })
      const version = await rpc('ping', undefined, { 'mcp-protocol-version': '1999-01-01' })
      expect(version.status).toBe(400)
      const origin = await rpc('ping', undefined, { origin: 'https://evil.example' })
      expect(origin.status).toBe(403)
      const get = await h.client.get('/mcp/', { headers: { authorization: `Token ${key}` } })
      expect(get.status).toBe(405)
    })

    it('authenticates with REST authentication classes (Token / Bearer)', async () => {
      const { key } = await setup()
      const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }
      const none = await h.client.post('/mcp/', { json: ping })
      expect(none.status).toBe(401)
      expect(none.headers.get('www-authenticate')).toBe('Token')
      expect(await none.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32001 } })
      const bad = await h.client.post('/mcp/', { json: ping, headers: { authorization: 'Token nope' } })
      expect(bad.status).toBe(401)
      const bearer = await h.client.post('/mcp/', { json: ping, headers: { authorization: `Bearer ${key}` } })
      expect(bearer.status).toBe(200)
      expect((await bearer.json()).result).toEqual({})
    })
  })
}
