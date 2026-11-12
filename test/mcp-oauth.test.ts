// MCP authorization (resource server side) with a stub verifier: Protected Resource Metadata, 401 / 403
// challenges, audience binding, per-tool scopes.
import { include, path } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import {
  expandScopes,
  MCP_META,
  type McpOAuthOptions,
  McpServer,
  mcpWellKnownUrls,
  missingScopes,
  requireScopes,
  type Toolkit,
  tool,
  ViewSetTools,
} from '../src/index'
import { scopesFor } from '../src/tools/viewset'
import { makeUser, useHarness } from './helpers'

const MCP = 'http://testserver/mcp'
/** token → (audience, scopes); the user is looked up by name. */
const TOKENS: Record<string, { aud: string; scopes: string[]; user: string }> = {}

const verify: McpOAuthOptions['verifyAccessToken'] = async (token, { audience }) => {
  const t = TOKENS[token]
  if (!t || t.aud !== audience) return null
  const { User } = await import('@ghuri/auth')
  return { user: await User.objects.get({ username: t.user }), scopes: t.scopes }
}

const read = tool({
  name: 'theme_get',
  description: 'Read the theme',
  scopes: ['theme:read'],
  execute: () => 'theme',
})
const write = tool({
  name: 'theme_update',
  description: 'Edit the theme',
  scopes: ['theme:write'],
  execute: () => 'ok',
})
const open = tool({ name: 'now', description: 'Server time', execute: () => '12:00' })

const shop = new McpServer({
  name: 'shop',
  tools: [read, write, open],
  oauth: {
    verifyAccessToken: verify,
    requiredScopes: ['theme:read'],
    impliedScopes: { 'theme:write': ['theme:read'] },
    resourceName: 'Shop MCP',
  },
})
const lenient = new McpServer({
  name: 'lenient',
  tools: [read, write],
  oauth: { verifyAccessToken: verify, hideUnauthorizedTools: false, resource: 'https://mcp.example.com/' },
})

const V = '2026-07-28'
const meta = { [MCP_META.PROTOCOL_VERSION]: V, [MCP_META.CLIENT_CAPABILITIES]: {} }

describe('MCP OAuth (resource server)', () => {
  const h = useHarness(() => ({
    urls: () => [
      path('mcp/', shop.urls),
      path('lenient/', lenient.urls),
      path('', include(mcpWellKnownUrls(shop, lenient))),
    ],
  }))

  async function bearer(token: string, scopes: string[], aud = MCP) {
    await makeUser('ann').catch(() => null)
    TOKENS[token] = { aud, scopes, user: 'ann' }
    h.api.credentials({ Authorization: `Bearer ${token}` })
  }

  function rpc(url: string, method: string, params: Record<string, unknown> = {}) {
    const name: Record<string, string> = method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}
    return h.api.post(
      url,
      { jsonrpc: '2.0', id: 1, method, params: { _meta: meta, ...params } },
      { headers: { 'MCP-Protocol-Version': V, 'Mcp-Method': method, ...name } },
    )
  }

  it('serves Protected Resource Metadata at the path-based and root URLs', async () => {
    const res = await h.client.get('/.well-known/oauth-protected-resource/mcp')
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.json()).toEqual({
      resource: MCP,
      authorization_servers: ['http://testserver'],
      scopes_supported: ['theme:read', 'theme:write'],
      bearer_methods_supported: ['header'],
      resource_name: 'Shop MCP',
    })
    // a configured resource answers at its own path and at the root
    const configured = (await (await h.client.get('/.well-known/oauth-protected-resource')).json()) as any
    expect(configured.resource).toBe('https://mcp.example.com')
    expect((await h.client.get('/.well-known/oauth-protected-resource/agents')).status).toBe(404)
  })

  it('challenges anonymous requests with 401 and resource_metadata + scope', async () => {
    const res = await rpc('/mcp/', 'tools/list')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="http://testserver/.well-known/oauth-protected-resource/mcp", scope="theme:read"',
    )
    expect(((await res.json()) as any).error.code).toBe(-32001)
  })

  it('rejects tokens for another audience and unknown tokens with invalid_token', async () => {
    await bearer('elsewhere', ['theme:read'], 'http://testserver/other')
    const res = await rpc('/mcp/', 'tools/list')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(
      /^Bearer error="invalid_token", error_description="[^"]+", resource_metadata="http:\/\/testserver\/.well-known\/oauth-protected-resource\/mcp"/,
    )
    h.api.credentials({ Authorization: 'Bearer nope' })
    expect((await rpc('/mcp/', 'tools/list')).status).toBe(401)
  })

  it('filters tools/list by scope and marks it private', async () => {
    await bearer('r', ['theme:read'])
    const result = ((await (await rpc('/mcp/', 'tools/list')).json()) as any).result
    expect(result.tools.map((t: any) => t.name)).toEqual(['theme_get', 'now'])
    expect(result.cacheScope).toBe('private')
    await bearer('w', ['theme:write'])
    const all = ((await (await rpc('/mcp/', 'tools/list')).json()) as any).result
    expect(all.tools.map((t: any) => t.name)).toEqual(['theme_get', 'theme_update', 'now'])
  })

  it('answers 403 insufficient_scope when a call needs more scope', async () => {
    await bearer('r', ['theme:read'])
    expect((await rpc('/mcp/', 'tools/call', { name: 'theme_get' })).status).toBe(200)
    const res = await rpc('/mcp/', 'tools/call', { name: 'theme_update' })
    expect(res.status).toBe(403)
    const challenge = res.headers.get('www-authenticate')!
    expect(challenge).toContain('error="insufficient_scope"')
    expect(challenge).toContain('scope="theme:read theme:write"')
    expect(challenge).toContain(
      'resource_metadata="http://testserver/.well-known/oauth-protected-resource/mcp"',
    )
    const body = (await res.json()) as any
    expect(body).toMatchObject({
      id: 1,
      error: { code: -32001, data: { requiredScopes: ['theme:read', 'theme:write'] } },
    })
  })

  it('requires the server-wide scopes', async () => {
    await bearer('none', [])
    const res = await rpc('/mcp/', 'server/discover')
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toContain('scope="theme:read"')
  })

  it('works for legacy clients too', async () => {
    await bearer('r', ['theme:read'])
    const list = await h.api.post(
      '/mcp/',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { headers: { 'MCP-Protocol-Version': '2025-06-18' } },
    )
    expect(((await list.json()) as any).result.tools).toHaveLength(2)
    const call = await h.api.post('/mcp/', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'theme_update' },
    })
    expect(call.status).toBe(403)
  })

  it('can list tools it will refuse (hideUnauthorizedTools: false) and checks a configured resource', async () => {
    await bearer('r2', ['theme:read'], 'https://mcp.example.com')
    const result = ((await (await rpc('/lenient/', 'tools/list')).json()) as any).result
    expect(result.tools.map((t: any) => t.name)).toEqual(['theme_get', 'theme_update'])
    expect((await rpc('/lenient/', 'tools/call', { name: 'theme_update' })).status).toBe(403)
  })
})

describe('scope helpers', () => {
  it('expands implied scopes and reports missing ones', () => {
    expect([...expandScopes(['a'], { a: ['b'], b: ['c'] })]).toEqual(['a', 'b', 'c'])
    expect(missingScopes(['b', 'd'], ['a'], { a: ['b'] })).toEqual(['d'])
    expect(missingScopes([], [])).toEqual([])
  })

  it('adds scopes to tools and toolkits', () => {
    const t = requireScopes(['x'], tool({ name: 'n', description: 'd', scopes: ['y'], execute: () => 1 }))
    expect(t.scopes).toEqual(['y', 'x'])
    const kit = requireScopes(['z'], { getTools: () => [{ ...t }] } as Toolkit)
    expect(kit.getTools()[0].scopes).toEqual(['y', 'x', 'z'])
  })

  it('resolves per-action toolkit scopes', () => {
    expect(scopesFor(['a'], 'list')).toEqual(['a'])
    expect(scopesFor({ list: ['r'], '*': ['w'] }, 'list', 'list')).toEqual(['r'])
    expect(scopesFor({ list: ['r'], '*': ['w'] }, 'delete', 'destroy')).toEqual(['w'])
    expect(scopesFor(undefined, 'list')).toBeUndefined()
    expect(typeof ViewSetTools).toBe('function')
  })
})
