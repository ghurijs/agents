import { getHost, ImproperlyConfigured, path, tryGetContext, type UrlPatterns } from '@ghuri/core'
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
import { agentsSettings, defaultPermissionClasses } from './settings'
import { runTool } from './tools/execute'
import { sanitizeToolName } from './tools/schema'
import { isToolDecorator, standaloneTool } from './tools/tool'
import { type AgentTool, isAgentTool, isToolkit, type ToolContext } from './tools/types'

/** Protocol revisions this server speaks (newest first). */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const
export const MCP_LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0]

/** JSON-RPC 2.0 error codes. */
export const JSONRPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Server-defined: authentication / authorization failures. */
  UNAUTHORIZED: -32001,
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
}

export interface McpCallContext {
  user: ToolContext['user']
  request?: APIRequest
  signal?: AbortSignal
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

  /** `tools/list` entries. */
  listTools(): Array<Record<string, unknown>> {
    return this.getTools().map((t) => ({
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

  /** `initialize` result. */
  initializeResult(params: Record<string, unknown>): Record<string, unknown> {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined
    const protocolVersion =
      requested && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : MCP_LATEST_PROTOCOL_VERSION
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: this.opts.name ?? 'ghuri',
        version: this.opts.version ?? '0.1.0',
        ...(this.opts.title ? { title: this.opts.title } : {}),
      },
      ...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
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
    switch (method) {
      case 'initialize':
        return this.initializeResult(params)
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: this.listTools() }
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
  asView() {
    return McpView.asView({ mcpServer: this })
  }

  /** URL patterns: mount with `path('mcp/', server.urls)`. */
  get urls(): UrlPatterns {
    return [path('', this.asView(), { name: 'mcp' })]
  }
}

/** A JSON-RPC error raised while dispatching. */
export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
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
    const classes = this.mcpServer.opts.authenticationClasses ?? agentsSettings().AUTHENTICATION_CLASSES
    return classes ? classes.map((A) => new A()) : super.getAuthenticators()
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
    if (version && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      return new APIResponse(
        errorResponse(null, JSONRPC.INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${version}`),
        { status: 400 },
      )
    }
    let body: unknown
    try {
      body = request.data
    } catch {
      return new APIResponse(errorResponse(null, JSONRPC.PARSE_ERROR, 'Parse error'), { status: 400 })
    }
    if (body === undefined || (isPlainObject(body) && !Object.keys(body).length)) {
      return new APIResponse(errorResponse(null, JSONRPC.INVALID_REQUEST, 'Invalid Request'), { status: 400 })
    }
    const { status, body: out } = await this.mcpServer.handleBody(body, {
      user: request.user,
      request,
      signal: request.raw.signal,
    })
    if (out === undefined) return new Response(null, { status })
    return new APIResponse(out, { status })
  }

  async get(): Promise<Response> {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }

  async delete(): Promise<Response> {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }
}
