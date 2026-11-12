import {
  getHost,
  ImproperlyConfigured,
  isSecure,
  kwargs,
  path,
  tryGetContext,
  type UrlPatterns,
  urlpatterns,
  type ViewFunction,
} from '@ghuri/core'
import {
  type APIRequest,
  APIResponse,
  APIView,
  type AuthenticationClass,
  type BaseAuthentication,
  type BasePermission,
  JSONRenderer,
  type PermissionClass,
} from '@ghuri/rest'
import { Agent, type ToolsInput } from './agent'
import { ToolError } from './errors'
import {
  bearerChallenge,
  canonicalResourceUrl,
  InsufficientScope,
  type McpOAuthOptions,
  type McpTokenInfo,
  mcpBearerAuthentication,
  mcpResource,
  missingScopes,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  routesTo,
} from './oauth'
import { agentsSettings, defaultPermissionClasses } from './settings'
import { runTool } from './tools/execute'
import { sanitizeToolName } from './tools/schema'
import { isToolDecorator, standaloneTool } from './tools/tool'
import { type AgentTool, isAgentTool, isToolkit, type ToolContext } from './tools/types'

/** Protocol revisions this server speaks (newest first). */
export const MCP_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const
export const MCP_LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0]
/** Stateless revisions: no `initialize`, no session; every request carries its version and capabilities in `_meta`. */
export const MCP_MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const
/** Revisions negotiated with `initialize` (2025-11-25 and earlier). */
export const MCP_LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

/** `_meta` keys of the 2026-07-28 revision. */
export const MCP_META = {
  PROTOCOL_VERSION: 'io.modelcontextprotocol/protocolVersion',
  CLIENT_CAPABILITIES: 'io.modelcontextprotocol/clientCapabilities',
  CLIENT_INFO: 'io.modelcontextprotocol/clientInfo',
  SERVER_INFO: 'io.modelcontextprotocol/serverInfo',
  LOG_LEVEL: 'io.modelcontextprotocol/logLevel',
} as const

/** Is `version` a stateless (2026-07-28 or later) revision, supported or not? */
export function isModernProtocolVersion(version: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(version) && version >= MCP_MODERN_PROTOCOL_VERSIONS[0]
}

/** JSON-RPC 2.0 error codes. */
export const JSONRPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Server-defined: authentication / authorization failures. */
  UNAUTHORIZED: -32001,
  /** 2026-07-28: a request header does not match the body (or is missing). */
  HEADER_MISMATCH: -32020,
  /** 2026-07-28: the client did not declare a capability the request needs. */
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  /** 2026-07-28: the requested protocol version is not supported. */
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
} as const

export type JsonRpcId = string | number | null

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** An `Agent` subclass, or a factory returning a fresh agent. */
export type AgentSource = (new () => Agent) | (() => Agent)

function isAgentClass(source: AgentSource): source is new () => Agent {
  return source === Agent || source.prototype instanceof Agent
}

/** A factory for `source`: classes are instantiated with `new`, factories are called. */
function agentFactory(source: AgentSource): () => Agent {
  return isAgentClass(source) ? () => new source() : (source as () => Agent)
}

export interface McpServerOptions {
  /** Server name shown to clients (default `'ghuri'`). */
  name?: string
  /** Server version (default `'0.1.0'`). */
  version?: string
  title?: string
  /** Instructions for the client's model (returned by `initialize`). */
  instructions?: string
  /** Tools to expose: toolkits (`ModelTools`, `ViewSetTools`, `RouterTools`), `tool({...execute})`, `AgentTool`s. */
  tools?: ToolsInput
  /** Agents to expose as `ask_<name>` tools: agent classes (`{ support: SupportAgent }`) or factories (`() => new SupportAgent()`). */
  agents?: Record<string, AgentSource>
  /** Authentication (default `AGENTS.AUTHENTICATION_CLASSES`, then REST defaults). */
  authenticationClasses?: AuthenticationClass[]
  /** Access to the endpoint (default `AGENTS.PERMISSION_CLASSES`: `[IsAuthenticated]`). */
  permissionClasses?: PermissionClass[]
  /** Accept browser `Origin`s other than the server's own host / `CSRF_TRUSTED_ORIGINS` (default false). */
  allowAnyOrigin?: boolean
  /**
   * OAuth mode (MCP authorization): Bearer access tokens checked by `oauth.verifyAccessToken` for this server's
   * URL, Protected Resource Metadata (mount `server.wellKnownUrls` at the site root), 401 / 403 challenges and
   * per-tool scopes.
   */
  oauth?: McpOAuthOptions
  /** How long 2026-07-28 clients may cache `tools/list` and `server/discover` (ms, default 300000). */
  listTtlMs?: number
}

export interface McpCallContext {
  user: ToolContext['user']
  request?: APIRequest
  signal?: AbortSignal
  /** Scopes of the OAuth access token (OAuth mode); undefined when the request was not authorized by a token. */
  scopes?: string[]
  /** The request uses a stateless (2026-07-28+) revision. */
  modern?: boolean
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

function asJson(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

/**
 * A Model Context Protocol server over **Streamable HTTP** (JSON-RPC 2.0 over POST, JSON responses; no
 * server-initiated SSE stream, so GET answers 405). Implements `initialize`, `ping`, `tools/list`,
 * `tools/call`, empty `resources/list` / `prompts/list`, notifications and batches. Requests are authenticated
 * with REST authentication classes and every tool runs as the authenticated user.
 */
export class McpServer {
  readonly opts: McpServerOptions

  constructor(opts: McpServerOptions = {}) {
    this.opts = opts
  }

  /** All exposed tools (toolkits expanded, agents as `ask_<name>`). */
  getTools(): AgentTool[] {
    const out: AgentTool[] = []
    const add = (entry: unknown, key?: string) => {
      if (isToolDecorator(entry)) out.push(standaloneTool(entry, key))
      else if (isAgentTool(entry)) out.push(entry)
      else if (isToolkit(entry)) out.push(...entry.getTools())
      else throw new TypeError(`MCP tools: unsupported entry ${key ? `'${key}'` : String(entry)}.`)
    }
    const tools = this.opts.tools
    if (Array.isArray(tools)) for (const t of tools) add(t)
    else if (tools) for (const [k, t] of Object.entries(tools)) add(t, k)
    for (const [name, factory] of Object.entries(this.opts.agents ?? {})) out.push(agentTool(name, factory))
    const seen = new Set<string>()
    for (const t of out) {
      if (seen.has(t.name)) throw new ImproperlyConfigured(`MCP server has two tools named '${t.name}'.`)
      seen.add(t.name)
    }
    return out
  }

  /** Can the token of `ctx` use `tool`? (Always true outside OAuth mode / without a token.) */
  toolAllowed(tool: AgentTool, ctx?: McpCallContext): boolean {
    const oauth = this.opts.oauth
    if (!oauth || !ctx?.scopes) return true
    return !missingScopes(tool.scopes ?? [], ctx.scopes, oauth.impliedScopes).length
  }

  /** `tools/list` entries (tools the token lacks scopes for are left out in OAuth mode). */
  listTools(ctx?: McpCallContext): Array<Record<string, unknown>> {
    const hide = this.opts.oauth?.hideUnauthorizedTools !== false
    return this.getTools()
      .filter((t) => !hide || this.toolAllowed(t, ctx))
      .map((t) => ({
        name: t.name,
        ...(t.annotations?.title ? { title: t.annotations.title } : {}),
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }))
  }

  /** `tools/call`: run a tool as `ctx.user`. Tool failures are results with `isError: true`. */
  async callTool(name: string, args: unknown, ctx: McpCallContext): Promise<Record<string, unknown>> {
    const tool = this.getTools().find((t) => t.name === name)
    if (!tool) throw new McpError(JSONRPC.INVALID_PARAMS, `Unknown tool: ${name}`)
    if (!this.toolAllowed(tool, ctx)) {
      const missing = missingScopes(tool.scopes ?? [], ctx.scopes ?? [], this.opts.oauth?.impliedScopes)
      throw new InsufficientScope(
        [...new Set([...(ctx.scopes ?? []), ...(tool.scopes ?? [])])],
        `The tool '${name}' needs the scope${missing.length > 1 ? 's' : ''} ${missing.join(', ')}.`,
      )
    }
    try {
      const out = await runTool(tool, args, { user: ctx.user, request: ctx.request, signal: ctx.signal })
      if (typeof out === 'string') return { content: [{ type: 'text', text: out }], isError: false }
      const json = asJson(out)
      return {
        content: [{ type: 'text', text: JSON.stringify(json) }],
        structuredContent: isPlainObject(json) ? json : { result: json },
        isError: false,
      }
    } catch (err) {
      const e = err instanceof ToolError ? err : new ToolError(String(err))
      const detail = e.detail !== undefined ? `\n${JSON.stringify(e.detail)}` : ''
      return { content: [{ type: 'text', text: `${e.message}${detail}` }], isError: true }
    }
  }

  /** `serverInfo` (an MCP `Implementation`). */
  serverInfo(): Record<string, unknown> {
    return {
      name: this.opts.name ?? 'ghuri',
      version: this.opts.version ?? '0.1.0',
      ...(this.opts.title ? { title: this.opts.title } : {}),
    }
  }

  /** `initialize` result (legacy revisions; a stateless client asking for one gets the newest legacy revision). */
  initializeResult(params: Record<string, unknown>): Record<string, unknown> {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined
    const protocolVersion =
      requested && (MCP_LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : MCP_LEGACY_PROTOCOL_VERSIONS[0]
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.serverInfo(),
      ...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
    }
  }

  /** Cache hints of list results (2026-07-28): token-dependent lists are `private`. */
  protected cacheHints(): { ttlMs: number; cacheScope: 'public' | 'private' } {
    return { ttlMs: this.opts.listTtlMs ?? 300_000, cacheScope: this.opts.oauth ? 'private' : 'public' }
  }

  /** `server/discover` result (2026-07-28). */
  discoverResult(): Record<string, unknown> {
    return {
      supportedVersions: [...MCP_PROTOCOL_VERSIONS],
      capabilities: { tools: {} },
      ...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
      ...this.cacheHints(),
    }
  }

  /** Handle one JSON-RPC message; `null` for notifications and client responses (nothing to send). */
  async handleMessage(message: unknown, ctx: McpCallContext): Promise<JsonRpcResponse | null> {
    if (!isPlainObject(message) || message.jsonrpc !== '2.0') {
      const id = isPlainObject(message) && isValidId(message.id) ? (message.id as JsonRpcId) : null
      return errorResponse(id, JSONRPC.INVALID_REQUEST, 'Invalid Request')
    }
    const hasId = 'id' in message && message.id !== undefined
    if (typeof message.method !== 'string') {
      // A response from the client (to a server request we never send) — ignore.
      if (('result' in message || 'error' in message) && hasId) return null
      return errorResponse(
        isValidId(message.id) ? (message.id as JsonRpcId) : null,
        JSONRPC.INVALID_REQUEST,
        'Invalid Request',
      )
    }
    if (!hasId) return null // notification (notifications/initialized, notifications/cancelled, …)
    if (!isValidId(message.id) || message.id === null)
      return errorResponse(null, JSONRPC.INVALID_REQUEST, 'Invalid Request: id must be a string or number')
    const id = message.id as JsonRpcId
    const params = message.params === undefined ? {} : message.params
    if (!isPlainObject(params)) return errorResponse(id, JSONRPC.INVALID_PARAMS, 'params must be an object')
    try {
      const result = await this.dispatch(message.method, params, ctx)
      return { jsonrpc: '2.0', id, result }
    } catch (err) {
      if (err instanceof InsufficientScope) throw err
      if (err instanceof McpError) return errorResponse(id, err.code, err.message, err.data)
      console.error('[ghuri.agents] MCP request failed:', err)
      const debug = !!tryGetContext()?.settings.DEBUG
      return errorResponse(
        id,
        JSONRPC.INTERNAL_ERROR,
        debug && err instanceof Error ? err.message : 'Internal error',
      )
    }
  }

  protected async dispatch(
    method: string,
    params: Record<string, unknown>,
    ctx: McpCallContext,
  ): Promise<unknown> {
    if (ctx.modern) return this.dispatchModern(method, params, ctx)
    switch (method) {
      case 'initialize':
        return this.initializeResult(params)
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: this.listTools(ctx) }
      case 'tools/call': {
        if (typeof params.name !== 'string')
          throw new McpError(JSONRPC.INVALID_PARAMS, 'tools/call requires a tool name')
        return this.callTool(params.name, params.arguments ?? {}, ctx)
      }
      case 'resources/list':
        return { resources: [] }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      case 'prompts/list':
        return { prompts: [] }
      case 'logging/setLevel':
        return {}
      default:
        throw new McpError(JSONRPC.METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
  }

  /** 2026-07-28 methods: every result carries `resultType` and `serverInfo`; lists carry cache hints. */
  protected async dispatchModern(
    method: string,
    params: Record<string, unknown>,
    ctx: McpCallContext,
  ): Promise<unknown> {
    let result: Record<string, unknown>
    switch (method) {
      case 'server/discover':
        result = this.discoverResult()
        break
      case 'tools/list':
        result = { tools: this.listTools(ctx), ...this.cacheHints() }
        break
      case 'tools/call': {
        if (typeof params.name !== 'string')
          throw new McpError(JSONRPC.INVALID_PARAMS, 'tools/call requires a tool name')
        result = await this.callTool(params.name, params.arguments ?? {}, ctx)
        break
      }
      case 'resources/list':
        result = { resources: [], ...this.cacheHints() }
        break
      case 'resources/templates/list':
        result = { resourceTemplates: [], ...this.cacheHints() }
        break
      case 'prompts/list':
        result = { prompts: [], ...this.cacheHints() }
        break
      default:
        throw new McpError(JSONRPC.METHOD_NOT_FOUND, `Method not found: ${method}`, undefined, 404)
    }
    return {
      resultType: 'complete',
      ...result,
      _meta: { [MCP_META.SERVER_INFO]: this.serverInfo() },
    }
  }

  /**
   * Handle a 2026-07-28 request (one message; its `_meta` and the request headers are validated first, as the
   * transport requires). Returns the HTTP status and JSON body (or none).
   */
  async handleModern(
    message: unknown,
    headers: { protocolVersion?: string; method?: string; name?: string },
    ctx: McpCallContext,
  ): Promise<{ status: number; body?: unknown }> {
    const fail = (status: number, id: JsonRpcId, code: number, msg: string, data?: unknown) => ({
      status,
      body: errorResponse(id, code, msg, data),
    })
    if (Array.isArray(message))
      return fail(400, null, JSONRPC.INVALID_REQUEST, 'Batches are not supported by this protocol revision')
    if (!isPlainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
      return fail(400, null, JSONRPC.INVALID_REQUEST, 'Invalid Request')
    const hasId = 'id' in message && message.id !== undefined
    if (!hasId) return { status: 202 }
    if (!isValidId(message.id) || message.id === null)
      return fail(400, null, JSONRPC.INVALID_REQUEST, 'Invalid Request: id must be a string or number')
    const id = message.id as JsonRpcId
    const params = message.params === undefined ? {} : message.params
    if (!isPlainObject(params)) return fail(400, id, JSONRPC.INVALID_PARAMS, 'params must be an object')
    const meta = isPlainObject(params._meta) ? params._meta : {}
    const version = meta[MCP_META.PROTOCOL_VERSION]
    if (!headers.protocolVersion)
      return fail(400, id, JSONRPC.HEADER_MISMATCH, 'Missing MCP-Protocol-Version header')
    if (typeof version !== 'string')
      return fail(400, id, JSONRPC.INVALID_PARAMS, `Missing _meta field ${MCP_META.PROTOCOL_VERSION}`)
    if (headers.protocolVersion !== version)
      return fail(
        400,
        id,
        JSONRPC.HEADER_MISMATCH,
        `Header mismatch: MCP-Protocol-Version header value '${headers.protocolVersion}' does not match body value '${version}'`,
      )
    if (!(MCP_MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version))
      return fail(400, id, JSONRPC.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
        supported: [...MCP_PROTOCOL_VERSIONS],
        requested: version,
      })
    if (!isPlainObject(meta[MCP_META.CLIENT_CAPABILITIES]))
      return fail(400, id, JSONRPC.INVALID_PARAMS, `Missing _meta field ${MCP_META.CLIENT_CAPABILITIES}`)
    const method = message.method
    if (headers.method === undefined)
      return fail(400, id, JSONRPC.HEADER_MISMATCH, 'Missing Mcp-Method header')
    if (decodeHeaderValue(headers.method) !== method)
      return fail(
        400,
        id,
        JSONRPC.HEADER_MISMATCH,
        `Header mismatch: Mcp-Method header value '${headers.method}' does not match body value '${method}'`,
      )
    const nameKey =
      method === 'resources/read'
        ? 'uri'
        : method === 'tools/call' || method === 'prompts/get'
          ? 'name'
          : null
    if (nameKey && typeof params[nameKey] === 'string') {
      if (headers.name === undefined) return fail(400, id, JSONRPC.HEADER_MISMATCH, 'Missing Mcp-Name header')
      if (decodeHeaderValue(headers.name) !== params[nameKey])
        return fail(
          400,
          id,
          JSONRPC.HEADER_MISMATCH,
          `Header mismatch: Mcp-Name header value '${headers.name}' does not match body value '${String(params[nameKey])}'`,
        )
    }
    try {
      const result = await this.dispatch(method, params, { ...ctx, modern: true })
      return { status: 200, body: { jsonrpc: '2.0', id, result } }
    } catch (err) {
      if (err instanceof InsufficientScope) throw err
      if (err instanceof McpError) return fail(err.httpStatus ?? 200, id, err.code, err.message, err.data)
      console.error('[ghuri.agents] MCP request failed:', err)
      const debug = !!tryGetContext()?.settings.DEBUG
      return fail(
        200,
        id,
        JSONRPC.INTERNAL_ERROR,
        debug && err instanceof Error ? err.message : 'Internal error',
      )
    }
  }

  /** Handle a parsed POST body (single message or batch). Returns the HTTP status and JSON body (or none). */
  async handleBody(body: unknown, ctx: McpCallContext): Promise<{ status: number; body?: unknown }> {
    if (Array.isArray(body)) {
      if (!body.length)
        return { status: 400, body: errorResponse(null, JSONRPC.INVALID_REQUEST, 'Empty batch') }
      const responses: JsonRpcResponse[] = []
      for (const m of body) {
        const r = await this.handleMessage(m, ctx)
        if (r) responses.push(r)
      }
      return responses.length ? { status: 200, body: responses } : { status: 202 }
    }
    const r = await this.handleMessage(body, ctx)
    if (!r) return { status: 202 }
    return { status: 200, body: r }
  }

  /** The Streamable HTTP endpoint view. */
  asView(): ViewFunction {
    const view = McpView.asView({ mcpServer: this })
    Object.defineProperty(view, 'mcpServer', { value: this })
    return view
  }

  /** URL patterns: mount with `path('mcp/', server.urls)`. */
  get urls(): UrlPatterns {
    return [path('', this.asView(), { name: 'mcp' })]
  }

  /** Every scope any tool requires. */
  toolScopes(): string[] {
    return [...new Set(this.getTools().flatMap((t) => t.scopes ?? []))]
  }

  /**
   * Protected Resource Metadata (RFC 9728) for OAuth mode; mount at the site root:
   * `path('', include(server.wellKnownUrls))` → `/.well-known/oauth-protected-resource[/<mcp path>]`.
   */
  get wellKnownUrls(): UrlPatterns {
    return mcpWellKnownUrls(this)
  }
}

/** Decode the `=?base64?…?=` form of 2026-07-28 request headers. */
function decodeHeaderValue(value: string): string {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(value)
  if (!m) return value
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0)))
  } catch {
    return value
  }
}

/**
 * Protected Resource Metadata for one or more MCP servers in OAuth mode, at `/.well-known/oauth-protected-resource`
 * and `/.well-known/oauth-protected-resource/<mcp path>`. Mount at the site root.
 */
export function mcpWellKnownUrls(...servers: McpServer[]): UrlPatterns {
  const view: ViewFunction = async (c) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'MCP-Protocol-Version',
    }
    if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    const suffix = String(kwargs(c).resourcePath ?? '').replace(/\/+$/, '')
    const origin = `${isSecure(c) ? 'https' : 'http'}://${getHost(c)}`
    for (const server of servers) {
      const oauth = server.opts.oauth
      if (!oauth) continue
      let resource: string | null = null
      if (oauth.resource) {
        const configured = canonicalResourceUrl(oauth.resource)
        const p = new URL(configured).pathname.replace(/^\/+/, '')
        if (p === suffix || !suffix) resource = configured
      } else if (routesTo(`/${suffix}`, server)) {
        resource = canonicalResourceUrl(`${origin}/${suffix}`)
      }
      if (resource)
        return new Response(
          JSON.stringify(protectedResourceMetadata(c, resource, oauth, server.toolScopes())),
          {
            headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', ...cors },
          },
        )
    }
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json', ...cors },
    })
  }
  return urlpatterns(undefined, [
    path('.well-known/oauth-protected-resource', view),
    path('.well-known/oauth-protected-resource/<path:resourcePath>', view),
  ])
}

/** A JSON-RPC error raised while dispatching. */
export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    /** HTTP status for 2026-07-28 requests (e.g. 404 for an unknown method). */
    readonly httpStatus?: number,
  ) {
    super(message)
  }
}

function isValidId(id: unknown): boolean {
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
}

/** An agent exposed as an MCP tool (`ask_<name>`). */
export function agentTool(name: string, source: AgentSource): AgentTool {
  const factory = agentFactory(source)
  const probe = factory()
  return {
    name: sanitizeToolName(`ask_${name}`),
    description: probe.getDescription(),
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Your message to the agent.' },
        conversationId: {
          type: 'string',
          description: 'Continue a previous conversation (the conversationId returned by an earlier call).',
        },
      },
      required: ['message'],
    },
    annotations: { title: `Ask ${name}`, readOnlyHint: false, openWorldHint: false },
    parse(input: unknown) {
      if (!isPlainObject(input) || typeof input.message !== 'string' || !input.message.trim())
        throw new ToolError("'message' is required.", { status: 400 })
      if (input.conversationId !== undefined && typeof input.conversationId !== 'string')
        throw new ToolError("'conversationId' must be a string.", { status: 400 })
      return input
    },
    async execute(input: { message: string; conversationId?: string }, ctx: ToolContext) {
      const agent = factory()
      await agent.checkPermissions(ctx.user, ctx.request)
      const r = await agent.run(input.message, {
        user: ctx.user,
        conversationId: input.conversationId ?? null,
        request: ctx.request,
        signal: ctx.signal,
      })
      return { text: r.text, ...(r.conversationId ? { conversationId: r.conversationId } : {}) }
    },
  }
}

/** Does a POST use a stateless revision (modern `MCP-Protocol-Version` header or `_meta` version)? */
function isModernRequest(body: unknown, headerVersion: string | undefined): boolean {
  if (headerVersion && isModernProtocolVersion(headerVersion)) return true
  const first = Array.isArray(body) ? body[0] : body
  return (
    isPlainObject(first) &&
    isPlainObject(first.params) &&
    isPlainObject(first.params._meta) &&
    MCP_META.PROTOCOL_VERSION in first.params._meta
  )
}

function sameOrigin(request: APIRequest, origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  const host = getHost(request.c)
  if (url.host === host) return true
  const trusted = (tryGetContext()?.settings.CSRF_TRUSTED_ORIGINS as string[] | undefined) ?? []
  return trusted.some(
    (t) =>
      t === origin ||
      (t.includes('*') && new RegExp(`^${t.replace(/[.]/g, '\\.').replace('*', '[^/]+')}$`).test(origin)),
  )
}

/** The Streamable HTTP endpoint (POST JSON-RPC; GET / DELETE → 405). */
export class McpView extends APIView {
  declare mcpServer: McpServer
  override rendererClasses = [JSONRenderer]

  override getAuthenticators(): BaseAuthentication[] {
    const opts = this.mcpServer.opts
    if (opts.oauth) {
      const Bearer = mcpBearerAuthentication(() => this.mcpServer.opts.oauth!)
      return [new Bearer(), ...(opts.authenticationClasses ?? []).map((A) => new A())]
    }
    const classes = opts.authenticationClasses ?? agentsSettings().AUTHENTICATION_CLASSES
    return classes ? classes.map((A) => new A()) : super.getAuthenticators()
  }

  /** The 403 step-up challenge for a token lacking scopes (RFC 6750 `insufficient_scope`). */
  protected insufficientScope(request: APIRequest, err: InsufficientScope, id: JsonRpcId = null): Response {
    const resource = mcpResource(request.c, this.mcpServer.opts.oauth!)
    return new APIResponse(
      errorResponse(id, JSONRPC.UNAUTHORIZED, err.message, { requiredScopes: err.scopes }),
      {
        status: 403,
        headers: {
          'WWW-Authenticate': bearerChallenge({
            error: 'insufficient_scope',
            scope: err.scopes.join(' '),
            resource_metadata: protectedResourceMetadataUrl(resource),
            error_description: err.message,
          }),
        },
      },
    ) as unknown as Response
  }

  override getPermissions(): BasePermission[] {
    return (this.mcpServer.opts.permissionClasses ?? defaultPermissionClasses()).map((P) => new P())
  }

  override performContentNegotiation(request: APIRequest, _force = false): [any, string] {
    return super.performContentNegotiation(request, true)
  }

  /** Authentication / permission failures keep their HTTP status (401 + WWW-Authenticate) with a JSON-RPC body. */
  override async handleException(exc: unknown): Promise<APIResponse> {
    const res = await super.handleException(exc)
    const detail = (res.data as any)?.detail
    res.data = errorResponse(
      null,
      res.status === 401 || res.status === 403 ? JSONRPC.UNAUTHORIZED : JSONRPC.INTERNAL_ERROR,
      detail !== undefined && detail !== null ? String(detail) : 'Request failed',
    ) as any
    return res
  }

  async post(request: APIRequest): Promise<APIResponse | Response> {
    const origin = request.header('origin')
    if (origin && !this.mcpServer.opts.allowAnyOrigin && !sameOrigin(request, origin)) {
      return new APIResponse(errorResponse(null, JSONRPC.INVALID_REQUEST, 'Origin not allowed'), {
        status: 403,
      })
    }
    const version = request.header('mcp-protocol-version')
    let body: unknown
    try {
      body = request.data
    } catch {
      return new APIResponse(errorResponse(null, JSONRPC.PARSE_ERROR, 'Parse error'), { status: 400 })
    }
    if (body === undefined || (isPlainObject(body) && !Object.keys(body).length)) {
      return new APIResponse(errorResponse(null, JSONRPC.INVALID_REQUEST, 'Invalid Request'), { status: 400 })
    }
    const ctx: McpCallContext = { user: request.user, request, signal: request.raw.signal }
    const oauth = this.mcpServer.opts.oauth
    const info = request.auth as McpTokenInfo | undefined
    if (oauth && info && Array.isArray(info.scopes)) {
      ctx.scopes = info.scopes
      const missing = missingScopes(oauth.requiredScopes ?? [], info.scopes, oauth.impliedScopes)
      if (missing.length)
        return this.insufficientScope(
          request,
          new InsufficientScope(
            [...new Set([...info.scopes, ...(oauth.requiredScopes ?? [])])],
            `This server needs the scope${missing.length > 1 ? 's' : ''} ${missing.join(', ')}.`,
          ),
        )
    }
    const modern = isModernRequest(body, version)
    if (!modern && version && !(MCP_LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      return new APIResponse(
        errorResponse(null, JSONRPC.INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${version}`),
        { status: 400 },
      )
    }
    try {
      const { status, body: out } = modern
        ? await this.mcpServer.handleModern(
            body,
            {
              protocolVersion: version,
              method: request.header('mcp-method'),
              name: request.header('mcp-name'),
            },
            ctx,
          )
        : await this.mcpServer.handleBody(body, ctx)
      if (out === undefined) return new Response(null, { status })
      return new APIResponse(out, { status })
    } catch (err) {
      if (err instanceof InsufficientScope && oauth) {
        const id = isPlainObject(body) && isValidId(body.id) ? (body.id as JsonRpcId) : null
        return this.insufficientScope(request, err, id)
      }
      throw err
    }
  }

  async get(): Promise<Response> {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }

  async delete(): Promise<Response> {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }
}
