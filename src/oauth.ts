// MCP authorization, resource-server side: Protected Resource Metadata (RFC 9728), Bearer challenges (RFC 6750),
// audience-checked access tokens (RFC 8707) and per-tool scopes. The authorization server is pluggable:
// `verifyAccessToken` from `@ghuri/oauth-provider`, or your own verifier.
import { getHost, isSecure, type RequestUser, resolve } from '@ghuri/core'
import { type APIRequest, AuthenticationFailed } from '@ghuri/rest'
import type { Context } from 'hono'
import { isToolDecorator, standaloneTool, type ToolDecorator } from './tools/tool'
import type { AgentTool, Toolkit } from './tools/types'
import { isAgentTool, isToolkit } from './tools/types'

/** What a token verifier returns for a valid token. */
export interface McpTokenInfo {
  user: RequestUser
  /** Granted scopes. */
  scopes: string[]
}

/** Verifies an access token for `audience` (the canonical MCP URL); null when invalid. */
export type McpTokenVerifier = (
  token: string,
  opts: { audience: string; request?: APIRequest },
) => Promise<McpTokenInfo | null> | McpTokenInfo | null

export interface McpOAuthOptions {
  /** Token verifier, e.g. `verifyAccessToken` from `@ghuri/oauth-provider`. Must check the audience. */
  verifyAccessToken: McpTokenVerifier
  /** Issuer URLs of the authorization servers (default: this site's origin). */
  authorizationServers?: string[]
  /** The canonical MCP URL (default: derived from the request: scheme, host and path without trailing slash). */
  resource?: string
  /** Scopes advertised in the metadata (default: `requiredScopes` plus every tool's scopes). */
  scopesSupported?: string[]
  /** Scopes every request needs (sent in the 401 challenge's `scope`). */
  requiredScopes?: string[]
  /** Broader scopes implying narrower ones: `{ 'theme:write': ['theme:read'] }`. */
  impliedScopes?: Record<string, string[]>
  /** Hide tools the token lacks scopes for from `tools/list` (default true). Calling one answers 403 either way. */
  hideUnauthorizedTools?: boolean
  /** Human-readable name of the server (`resource_name`). */
  resourceName?: string
  /** URL of documentation (`resource_documentation`). */
  resourceDocumentation?: string
}

/** Canonical form of a resource URL: lowercase scheme / host, no default port, fragment or trailing slash. */
export function canonicalResourceUrl(value: string): string {
  const u = new URL(value)
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`
}

function origin(c: Context): string {
  return `${isSecure(c) ? 'https' : 'http'}://${getHost(c)}`
}

/** The canonical MCP URL of the request (or the configured `resource`). */
export function mcpResource(c: Context, opts: McpOAuthOptions): string {
  if (opts.resource) return canonicalResourceUrl(opts.resource)
  return canonicalResourceUrl(`${origin(c)}${new URL(c.req.url).pathname}`)
}

/** `/.well-known/oauth-protected-resource<path>` for a resource URL. */
export function protectedResourceMetadataUrl(resource: string): string {
  const u = new URL(resource)
  const path = u.pathname.replace(/\/+$/, '')
  return `${u.protocol}//${u.host}/.well-known/oauth-protected-resource${path}`
}

/** Granted scopes with implied ones added. */
export function expandScopes(granted: string[], implied: Record<string, string[]> = {}): Set<string> {
  const out = new Set<string>()
  const add = (s: string) => {
    if (out.has(s)) return
    out.add(s)
    for (const i of implied[s] ?? []) add(i)
  }
  for (const s of granted) add(s)
  return out
}

/** The scopes of `required` that `granted` (with implied scopes) does not cover. */
export function missingScopes(
  required: string[],
  granted: string[],
  implied?: Record<string, string[]>,
): string[] {
  if (!required.length) return []
  const have = expandScopes(granted, implied)
  return required.filter((s) => !have.has(s))
}

function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`
}

/** A `WWW-Authenticate: Bearer …` challenge. */
export function bearerChallenge(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${quote(v!)}`)
  return parts.length ? `Bearer ${parts.join(', ')}` : 'Bearer'
}

/** 403 for a token without the scopes an operation needs (step-up authorization). */
export class InsufficientScope extends Error {
  constructor(
    readonly scopes: string[],
    message = 'The access token does not grant the scopes this operation needs.',
  ) {
    super(message)
  }
}

const badToken = new WeakMap<Request, string>()

/** Authentication class for MCP endpoints in OAuth mode (built per server by `McpServer`). */
export function mcpBearerAuthentication(getOptions: () => McpOAuthOptions) {
  return class McpBearerAuthentication {
    async authenticate(c: Context): Promise<[RequestUser, McpTokenInfo] | null> {
      const header = c.req.header('authorization') ?? ''
      const m = /^Bearer\s+(\S+)\s*$/i.exec(header)
      if (!m) {
        if (/^Bearer\b/i.test(header)) {
          badToken.set(c.req.raw, 'Malformed Authorization header.')
          throw new AuthenticationFailed('Malformed Authorization header.')
        }
        return null
      }
      const opts = getOptions()
      const info = await opts.verifyAccessToken(m[1], { audience: mcpResource(c, opts) })
      if (!info) {
        badToken.set(c.req.raw, 'The access token is invalid, expired or for another resource.')
        throw new AuthenticationFailed('The access token is invalid, expired or for another resource.')
      }
      if ((info.user as any)?.isActive === false) {
        badToken.set(c.req.raw, 'User inactive or deleted.')
        throw new AuthenticationFailed('User inactive or deleted.')
      }
      return [info.user, info]
    }

    authenticateHeader(c: Context): string {
      const opts = getOptions()
      const error = badToken.get(c.req.raw)
      return bearerChallenge({
        ...(error ? { error: 'invalid_token', error_description: error } : {}),
        resource_metadata: protectedResourceMetadataUrl(mcpResource(c, opts)),
        scope: opts.requiredScopes?.length ? opts.requiredScopes.join(' ') : undefined,
      })
    }
  }
}

/** RFC 9728 metadata document. */
export function protectedResourceMetadata(
  c: Context,
  resource: string,
  opts: McpOAuthOptions,
  toolScopes: string[],
): Record<string, unknown> {
  const scopes = opts.scopesSupported ?? [...new Set([...(opts.requiredScopes ?? []), ...toolScopes])]
  return {
    resource,
    authorization_servers: opts.authorizationServers ?? [origin(c)],
    ...(scopes.length ? { scopes_supported: scopes } : {}),
    bearer_methods_supported: ['header'],
    ...(opts.resourceName ? { resource_name: opts.resourceName } : {}),
    ...(opts.resourceDocumentation ? { resource_documentation: opts.resourceDocumentation } : {}),
  }
}

/** Does `pathname` route to a view of `server` (marked by `McpServer.asView()`)? */
export function routesTo(pathname: string, marker: unknown): boolean {
  for (const p of pathname.endsWith('/') ? [pathname, pathname.slice(0, -1)] : [pathname, `${pathname}/`]) {
    try {
      const match = resolve(p || '/')
      if ((match.view as any)?.mcpServer === marker) return true
    } catch {
      // not routed
    }
  }
  return false
}

/**
 * Require OAuth scopes for a tool, a standalone `tool({ execute })` or every tool of a toolkit (added to the scopes
 * the tools already require): `requireScopes(['orders:write'], new RouterTools(router))`.
 */
export function requireScopes(scopes: string[], target: AgentTool | ToolDecorator): AgentTool
export function requireScopes(scopes: string[], target: Toolkit): Toolkit
export function requireScopes(
  scopes: string[],
  target: AgentTool | ToolDecorator | Toolkit,
): AgentTool | Toolkit {
  const add = (t: AgentTool): AgentTool => ({ ...t, scopes: [...new Set([...(t.scopes ?? []), ...scopes])] })
  if (isToolDecorator(target)) return add(standaloneTool(target))
  if (isAgentTool(target)) return add(target)
  if (isToolkit(target)) {
    const inner = target
    return { getTools: () => inner.getTools().map(add) } as Toolkit
  }
  throw new TypeError('requireScopes() expects a tool or a toolkit.')
}
