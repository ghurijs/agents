// The 2026-07-28 (stateless) revision next to the legacy ones on the same endpoint.
import { TokenAuthentication } from '@ghuri/auth/rest'
import { path } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import { MCP_META, McpServer, tool } from '../src/index'
import { makeUser, tokenFor, useHarness } from './helpers'

const greet = tool({
  name: 'greet',
  description: 'Say hello',
  input: { type: 'object', properties: { name: { type: 'string' } } },
  execute: (input: any) => `hello ${input.name}`,
})
const server = new McpServer({ name: 'shop', version: '2.0.0', instructions: 'Shop tools.', tools: [greet] })

const V = '2026-07-28'
const meta = { [MCP_META.PROTOCOL_VERSION]: V, [MCP_META.CLIENT_CAPABILITIES]: {} }

describe('MCP 2026-07-28', () => {
  const h = useHarness(() => ({
    urls: () => [path('mcp/', server.urls)],
    settings: { AGENTS: { AUTHENTICATION_CLASSES: [TokenAuthentication] } },
  }))

  async function auth() {
    h.api.credentials({ Authorization: `Token ${await tokenFor(await makeUser('ann'))}` })
  }

  function call(
    method: string,
    params: Record<string, unknown> = {},
    headers: Record<string, string> = {},
    id: unknown = 1,
  ) {
    const name: Record<string, string> = method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}
    return h.api.post(
      '/mcp/',
      { jsonrpc: '2.0', id, method, params: { _meta: meta, ...params } },
      { headers: { 'MCP-Protocol-Version': V, 'Mcp-Method': method, ...name, ...headers } },
    )
  }

  it('answers server/discover without initialize, with serverInfo, resultType and cache hints', async () => {
    await auth()
    const res = await call('server/discover')
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).result).toEqual({
      resultType: 'complete',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {} },
      instructions: 'Shop tools.',
      ttlMs: 300000,
      cacheScope: 'public',
      _meta: { [MCP_META.SERVER_INFO]: { name: 'shop', version: '2.0.0' } },
    })
    expect(res.headers.get('mcp-session-id')).toBeNull()
  })

  it('lists and calls tools statelessly', async () => {
    await auth()
    const list = ((await (await call('tools/list')).json()) as any).result
    expect(list).toMatchObject({ resultType: 'complete', ttlMs: 300000, cacheScope: 'public' })
    expect(list.tools.map((t: any) => t.name)).toEqual(['greet'])
    const res = (
      (await (await call('tools/call', { name: 'greet', arguments: { name: 'ann' } })).json()) as any
    ).result
    expect(res).toMatchObject({
      resultType: 'complete',
      isError: false,
      content: [{ type: 'text', text: 'hello ann' }],
    })
  })

  it('validates the version and capability _meta fields and the mirrored headers', async () => {
    await auth()
    const err = async (res: Response) => [res.status, ((await res.json()) as any).error]
    // missing header
    let [status, e] = await err(
      await h.api.post(
        '/mcp/',
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } },
        { headers: { 'Mcp-Method': 'tools/list' } },
      ),
    )
    expect([status, e.code]).toEqual([400, -32020])
    // header and _meta disagree
    ;[status, e] = await err(
      await h.api.post(
        '/mcp/',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: { ...meta, [MCP_META.PROTOCOL_VERSION]: '2026-07-28' } },
        },
        { headers: { 'MCP-Protocol-Version': '2027-01-01', 'Mcp-Method': 'tools/list' } },
      ),
    )
    expect([status, e.code]).toEqual([400, -32020])
    // unsupported (future) version
    ;[status, e] = await err(
      await h.api.post(
        '/mcp/',
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/list',
          params: { _meta: { ...meta, [MCP_META.PROTOCOL_VERSION]: '2027-01-01' } },
        },
        { headers: { 'MCP-Protocol-Version': '2027-01-01', 'Mcp-Method': 'tools/list' } },
      ),
    )
    expect([status, e.code, e.data.requested]).toEqual([400, -32022, '2027-01-01'])
    expect(e.data.supported).toContain('2026-07-28')
    // missing client capabilities
    ;[status, e] = await err(
      await h.api.post(
        '/mcp/',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: { [MCP_META.PROTOCOL_VERSION]: V } },
        },
        { headers: { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/list' } },
      ),
    )
    expect([status, e.code]).toEqual([400, -32602])
    // Mcp-Method / Mcp-Name mismatch and missing
    ;[status, e] = await err(await call('tools/list', {}, { 'Mcp-Method': 'tools/call' }))
    expect([status, e.code]).toEqual([400, -32020])
    ;[status, e] = await err(await call('tools/call', { name: 'greet' }, { 'Mcp-Name': 'other' }))
    expect([status, e.code]).toEqual([400, -32020])
    const noName = await h.api.post(
      '/mcp/',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: meta, name: 'greet' } },
      { headers: { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/call' } },
    )
    expect(((await noName.json()) as any).error.code).toBe(-32020)
  })

  it('decodes base64 header values', async () => {
    await auth()
    const res = await call(
      'tools/call',
      { name: 'greet', arguments: { name: 'x' } },
      { 'Mcp-Name': `=?base64?${btoa('greet')}?=` },
    )
    expect(res.status).toBe(200)
  })

  it('answers unknown and removed methods with 404 / -32601, refuses batches, accepts notifications', async () => {
    await auth()
    for (const m of ['nope', 'ping', 'logging/setLevel']) {
      const res = await call(m)
      expect(res.status).toBe(404)
      expect(((await res.json()) as any).error.code).toBe(-32601)
    }
    const batch = await h.api.post(
      '/mcp/',
      [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }],
      {
        headers: { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/list' },
      },
    )
    expect(batch.status).toBe(400)
    const note = await h.api.post(
      '/mcp/',
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { _meta: meta } },
      { headers: { 'MCP-Protocol-Version': V, 'Mcp-Method': 'notifications/cancelled' } },
    )
    expect(note.status).toBe(202)
  })

  it('keeps legacy initialize working, negotiating the newest legacy revision', async () => {
    await auth()
    const init = await h.api.post('/mcp/', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'old', version: '1' } },
    })
    expect(((await init.json()) as any).result.protocolVersion).toBe('2025-11-25')
    const list = await h.api.post(
      '/mcp/',
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { headers: { 'MCP-Protocol-Version': '2025-06-18' } },
    )
    const body = (await list.json()) as any
    expect(body.result.tools[0].name).toBe('greet')
    expect(body.result.resultType).toBeUndefined()
    const ping = await h.api.post('/mcp/', { jsonrpc: '2.0', id: 3, method: 'ping' })
    expect(((await ping.json()) as any).result).toEqual({})
  })

  it('still requires authentication', async () => {
    const res = await call('server/discover')
    expect(res.status).toBe(401)
  })
})
