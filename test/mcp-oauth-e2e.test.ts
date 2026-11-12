// End to end with the real authorization server (@ghuri/oauth-provider): what Claude.ai / ChatGPT do from a
// bare MCP URL — 401 → Protected Resource Metadata → AS metadata → CIMD client → consent → code + PKCE → token
// (audience = MCP URL) → stateless MCP calls → step-up 403 → refresh rotation → revocation.
import {
  AuthConfig,
  AuthenticationMiddleware,
  AuthTokenConfig,
  authUrls,
  ContentType,
  ContentTypesConfig,
  PBKDF2PasswordHasher,
  SessionMiddleware,
  SessionsConfig,
  User,
} from '@ghuri/auth'
import { CsrfMiddleware, createApp, defineSettings, type GhuriApp, include, path } from '@ghuri/core'
import { createTestClient, type TestClient } from '@ghuri/core/testing'
import { pkcePair, setProviderFetch } from '@ghuri/oauth'
import {
  OAuth2ProviderConfig,
  oauth2ProviderUrls,
  oauth2WellKnownUrls,
  verifyAccessToken,
} from '@ghuri/oauth-provider'
import { setupTestDatabase, type TestDatabase } from '@ghuri/orm/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentsConfig, MCP_META, McpServer, tool } from '../src/index'
import { backends } from './helpers'
import { ShopConfig } from './models'

const CHATGPT = 'https://chatgpt.com/oauth/client.json'
const CHATGPT_CB = 'https://chatgpt.com/connector_platform_oauth_redirect'

const mcp = new McpServer({
  name: 'theme',
  tools: [
    tool({
      name: 'theme_get',
      description: 'Read the theme',
      scopes: ['theme:read'],
      execute: (_i, ctx) => `theme of ${(ctx.user as any).username}`,
    }),
    tool({
      name: 'theme_update',
      description: 'Edit the theme',
      scopes: ['theme:write'],
      execute: () => 'saved',
    }),
  ],
  oauth: { verifyAccessToken },
})

function field(html: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)
  return m![1]
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

for (const using of backends) {
  describe(`MCP with @ghuri/oauth-provider (${using})`, () => {
    let app: GhuriApp
    let db: TestDatabase
    let client: TestClient
    const env = {}
    beforeAll(async () => {
      app = createApp(
        defineSettings(() => ({
          SECRET_KEY: 'mcp-e2e',
          ALLOWED_HOSTS: ['testserver'],
          INSTALLED_APPS: [
            ContentTypesConfig,
            AuthConfig,
            SessionsConfig,
            AuthTokenConfig,
            ShopConfig,
            AgentsConfig,
            OAuth2ProviderConfig,
          ],
          MIDDLEWARE: [SessionMiddleware, CsrfMiddleware, AuthenticationMiddleware],
          ROOT_URLCONF: [
            path('accounts/', include(authUrls)),
            path('oauth/', include(oauth2ProviderUrls)),
            path('mcp/', mcp.urls),
            path('', include(oauth2WellKnownUrls)),
            path('', include(mcp.wellKnownUrls)),
          ],
          PASSWORD_HASHERS: [new PBKDF2PasswordHasher({ iterations: 1000 })],
          OAUTH2_PROVIDER: { SCOPES: { 'theme:read': 'Read your theme', 'theme:write': 'Edit your theme' } },
        })),
        { checks: false },
      )
      await app.setup(env)
      db = await setupTestDatabase({ using })
    }, 60_000)
    afterAll(async () => {
      setProviderFetch(undefined)
      await db?.teardown()
    })
    beforeEach(async () => {
      await db.flush()
      ContentType.objects.clearCache()
      client = createTestClient(app, { env })
      setProviderFetch(async (input) => {
        const url = new Request(input as any).url
        if (url !== CHATGPT) return new Response('nope', { status: 404 })
        return Response.json({
          client_id: CHATGPT,
          client_name: 'ChatGPT',
          redirect_uris: [CHATGPT_CB],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        })
      })
    })

    const rpc = (method: string, token: string | null, params: Record<string, unknown> = {}) =>
      client.post('/mcp/', {
        csrf: false,
        json: {
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            _meta: { [MCP_META.PROTOCOL_VERSION]: '2026-07-28', [MCP_META.CLIENT_CAPABILITIES]: {} },
            ...params,
          },
        },
        headers: {
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': method,
          ...(method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      })

    async function connect(scope: string) {
      // 1. The bare MCP URL answers 401 pointing at the resource metadata.
      const challenge = await rpc('tools/list', null)
      expect(challenge.status).toBe(401)
      const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get('www-authenticate')!)![1]
      // 2. Protected Resource Metadata names the authorization server.
      const prm = (await (await client.get(prmUrl)).json()) as any
      expect(prm).toMatchObject({
        resource: 'http://testserver/mcp',
        authorization_servers: ['http://testserver'],
      })
      expect(prm.scopes_supported).toEqual(['theme:read', 'theme:write'])
      // 3. Authorization server metadata.
      const as = (await (
        await client.get(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)
      ).json()) as any
      expect(as.client_id_metadata_document_supported).toBe(true)
      expect(as.token_endpoint_auth_methods_supported).toContain('none')
      // 4. The user logs in and approves ChatGPT (a URL client_id: CIMD).
      const user = await User.objects.createUser('ann', 'ann@example.com', 'pw')
      await client.forceLogin(user)
      const pkce = await pkcePair()
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: CHATGPT,
        redirect_uri: CHATGPT_CB,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        scope,
        state: 's1',
        resource: prm.resource,
      })
      const authorizeUrl = `${new URL(as.authorization_endpoint).pathname}?${q}`
      const consent = await client.get(authorizeUrl)
      expect(consent.status).toBe(200)
      const html = await consent.text()
      expect(html).toContain('ChatGPT')
      const approved = await client.post(authorizeUrl, {
        form: { request: field(html, 'request'), allow: '1' },
      })
      const back = new URL(approved.headers.get('location')!)
      expect(back.origin + back.pathname).toBe(CHATGPT_CB)
      expect(back.searchParams.get('iss')).toBe(as.issuer)
      client.clearCookies()
      // 5. Code → tokens, bound to the MCP URL.
      const tokenRes = await client.post(new URL(as.token_endpoint).pathname, {
        csrf: false,
        form: {
          grant_type: 'authorization_code',
          client_id: CHATGPT,
          code: back.searchParams.get('code')!,
          code_verifier: pkce.verifier,
          redirect_uri: CHATGPT_CB,
          resource: prm.resource,
        },
      })
      expect(tokenRes.status).toBe(200)
      return { as, tokens: (await tokenRes.json()) as any }
    }

    it('connects like ChatGPT and calls tools as the user', async () => {
      const { tokens } = await connect('theme:read')
      const list = ((await (await rpc('tools/list', tokens.access_token)).json()) as any).result
      expect(list.tools.map((t: any) => t.name)).toEqual(['theme_get'])
      const call = (
        (await (await rpc('tools/call', tokens.access_token, { name: 'theme_get' })).json()) as any
      ).result
      expect(call.content[0].text).toBe('theme of ann')
      // step-up: writing needs theme:write
      const denied = await rpc('tools/call', tokens.access_token, { name: 'theme_update' })
      expect(denied.status).toBe(403)
      expect(denied.headers.get('www-authenticate')).toContain('scope="theme:read theme:write"')
    })

    it('refreshes with rotation and stops working once revoked', async () => {
      const { as, tokens } = await connect('theme:read theme:write')
      const refresh = await client.post(new URL(as.token_endpoint).pathname, {
        csrf: false,
        form: { grant_type: 'refresh_token', client_id: CHATGPT, refresh_token: tokens.refresh_token },
      })
      const next = (await refresh.json()) as any
      expect((await rpc('tools/call', next.access_token, { name: 'theme_update' })).status).toBe(200)
      await client.post(new URL(as.revocation_endpoint).pathname, {
        csrf: false,
        form: { client_id: CHATGPT, token: next.refresh_token },
      })
      const after = await rpc('tools/list', next.access_token)
      expect(after.status).toBe(401)
      expect(after.headers.get('www-authenticate')).toContain('error="invalid_token"')
    })

    it('refuses a token issued for another resource on this server', async () => {
      const { tokens } = await connect('theme:read')
      expect(
        await verifyAccessToken(tokens.access_token, { audience: 'http://testserver/mcp' }),
      ).not.toBeNull()
      const user = await User.objects.get({ username: 'ann' })
      const { Application, createGrant, issueTokens } = await import('@ghuri/oauth-provider')
      const application = await Application.objects.get({ clientId: CHATGPT })
      const grant = await createGrant({
        user,
        application,
        scopes: ['theme:read'],
        resource: 'http://testserver/api',
      })
      const other = await issueTokens(grant, application, {
        issuer: 'http://testserver',
        scopes: ['theme:read'],
      })
      expect((await rpc('tools/list', other.access_token)).status).toBe(401)
    })
  })
}
