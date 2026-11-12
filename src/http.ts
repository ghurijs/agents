import { ImproperlyConfigured, path, tryGetContext, type UrlPatterns } from '@ghuri/core'
import {
  APIException,
  type APIRequest,
  APIResponse,
  APIView,
  type AuthenticationClass,
  type BaseAuthentication,
  type BasePermission,
  JSONRenderer,
  NotAuthenticated,
  NotFound,
  ValidationError as RestValidationError,
} from '@ghuri/rest'
import type { Agent, AgentInput } from './agent'
import { ModelResolutionError } from './errors'
import { McpServer, type McpServerOptions } from './mcp'
import { ConversationNotFound, getConversation, memoryAvailable } from './memory'
import { Conversation, Message } from './models'
import { consumeAgentQueue } from './queue'
import { agentsSettings } from './settings'

export type AgentClass = new () => Agent

/**
 * 503: the agent's model can't be used (missing provider package, API key or Workers AI binding). The reason
 * is shown with `DEBUG`; production answers stay generic.
 */
export class ModelUnavailable extends APIException {
  static override statusCode = 503
  static override defaultDetail = "The agent's language model is not available."
  static override defaultCode = 'model_unavailable'
}

/** `AGENTS.AUTHENTICATION_CLASSES`, else `REST_FRAMEWORK.DEFAULT_AUTHENTICATION_CLASSES`. */
export function agentAuthenticationClasses(): AuthenticationClass[] | undefined {
  return agentsSettings().AUTHENTICATION_CLASSES
}

/** Shared base: agent auth settings, permissions from the agent, JSON only (SSE returned as raw responses). */
abstract class AgentBaseView extends APIView {
  declare agentRouter: AgentRouter
  declare agentName: string
  _agent?: Agent

  override rendererClasses = [JSONRenderer]

  /** The agent instance serving this request. */
  get agent(): Agent {
    this._agent ??= this.agentRouter.create(this.agentName)
    return this._agent
  }

  override getAuthenticators(): BaseAuthentication[] {
    const classes = this.authenticationClasses ?? agentAuthenticationClasses()
    return classes ? classes.map((A) => new A()) : super.getAuthenticators()
  }

  override getPermissions(): BasePermission[] {
    if (this.permissionClasses) return super.getPermissions()
    return this.agent.getPermissionClasses().map((P) => new P())
  }

  // Never 406: SSE clients send `Accept: text/event-stream`; errors are rendered as JSON.
  override performContentNegotiation(request: APIRequest, _force = false): [any, string] {
    return super.performContentNegotiation(request, true)
  }

  protected requireMemory(): void {
    if (!memoryAvailable()) throw new NotFound('Conversation memory is not enabled (install AgentsConfig).')
  }
}

function wantsStream(request: APIRequest): boolean {
  const q = request.queryParams.get('stream')
  if (q !== null) return ['1', 'true', 'yes'].includes(q.toLowerCase())
  return (request.header('accept') ?? '').includes('text/event-stream')
}

/** Text of the last user message of AI SDK UI messages (`useChat` request bodies). */
function lastUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.parts))
      return m.parts
        .filter((p: any) => p?.type === 'text')
        .map((p: any) => p.text)
        .join('')
  }
  return undefined
}

/**
 * `POST <name>/chat` — `{ message, conversationId? }` (or an AI SDK `useChat` body with `messages`). Streams the
 * AI SDK UI message stream as SSE when `Accept: text/event-stream` or `?stream=1`, otherwise answers JSON
 * `{ conversationId, text, toolCalls, usage, finishReason }`.
 */
export class AgentChatView extends AgentBaseView {
  async post(request: APIRequest): Promise<Response | APIResponse> {
    const body = (request.data ?? {}) as Record<string, any>
    const message = typeof body.message === 'string' ? body.message : lastUserText(body.messages)
    if (typeof message !== 'string' || !message.trim())
      throw new RestValidationError({ message: ['This field is required.'] })
    const conversationId = body.conversationId ?? null
    if (conversationId !== null && typeof conversationId !== 'string')
      throw new RestValidationError({ conversationId: ['Must be a string.'] })
    const input: AgentInput = message
    const opts = { user: request.user, conversationId, request }
    try {
      if (wantsStream(request)) {
        const stream = await this.agent.stream(input, opts)
        return stream.toUIMessageStreamResponse()
      }
      const r = await this.agent.run(input, opts)
      return new APIResponse({
        conversationId: r.conversationId ?? null,
        text: r.text,
        toolCalls: r.toolCalls,
        usage: r.usage,
        finishReason: r.finishReason,
      })
    } catch (err) {
      if (err instanceof ConversationNotFound) throw new NotFound(err.message)
      if (err instanceof ModelResolutionError)
        throw new ModelUnavailable(tryGetContext()?.settings.DEBUG ? err.message : undefined)
      throw err
    }
  }
}

function conversationJSON(c: any): Record<string, unknown> {
  return {
    id: String(c.pk),
    agent: c.agent,
    title: c.title,
    metadata: c.metadata ?? {},
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

/** `GET <name>/conversations/` — the requesting user's conversations with the agent (newest first). */
export class ConversationListView extends AgentBaseView {
  async get(request: APIRequest): Promise<APIResponse> {
    this.requireMemory()
    if (!request.user.isAuthenticated) throw new NotAuthenticated()
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200)
    const offset = Math.max(Number(request.query.offset) || 0, 0)
    const qs = Conversation.objects.filter({ agent: this.agentName, user: request.user.pk })
    const [count, rows] = await Promise.all([
      qs.count(),
      qs.orderBy('-updatedAt').slice(offset, offset + limit),
    ])
    return new APIResponse({ count, results: rows.map(conversationJSON) })
  }
}

/** `GET / DELETE <name>/conversations/<id>/` — one conversation with its messages (owner only). */
export class ConversationDetailView extends AgentBaseView {
  protected async conversation(request: APIRequest, id: string): Promise<any> {
    this.requireMemory()
    if (!request.user.isAuthenticated) throw new NotAuthenticated()
    try {
      return await getConversation(this.agentName, id, request.user)
    } catch (err) {
      if (err instanceof ConversationNotFound) throw new NotFound(err.message)
      throw err
    }
  }

  async get(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    const conv = await this.conversation(request, String(kwargs.id))
    const rows: any[] = await Message.objects.filter({ conversation: String(conv.pk) }).orderBy('id')
    return new APIResponse({
      ...conversationJSON(conv),
      messages: rows.map((m) => ({ id: m.pk, role: m.role, content: m.content, createdAt: m.createdAt })),
    })
  }

  async delete(request: APIRequest, kwargs: Record<string, any>): Promise<APIResponse> {
    const conv = await this.conversation(request, String(kwargs.id))
    await conv.delete()
    return new APIResponse(null, { status: 204 })
  }
}

export interface AgentRouterOptions {
  /** URL name prefix (default `'agents'`: `agents-support-chat`). */
  urlNamePrefix?: string
}

/**
 * Serves agents over HTTP (and MCP).
 *
 * ```ts
 * const agents = new AgentRouter()
 * agents.register('support', SupportAgent)
 * export const urlpatterns = [path('agents/', include(agents.urls)), path('mcp/', agents.mcp({ name: 'shop' }))]
 * // POST /agents/support/chat   GET /agents/support/conversations/   GET|DELETE /agents/support/conversations/<id>/
 * ```
 */
export class AgentRouter {
  readonly registry = new Map<string, AgentClass>()
  readonly opts: AgentRouterOptions
  _urls?: UrlPatterns

  constructor(opts: AgentRouterOptions = {}) {
    this.opts = opts
  }

  /** Register an agent class under `name` (URL segment, conversation `agent` value, MCP `ask_<name>`). */
  register(name: string, agentClass: AgentClass): this {
    if (!/^[A-Za-z0-9_-]+$/.test(name))
      throw new ImproperlyConfigured(`Agent name '${name}' may only contain letters, digits, '_' and '-'.`)
    if (this.registry.has(name))
      throw new ImproperlyConfigured(`An agent named '${name}' is already registered.`)
    this.registry.set(name, agentClass)
    this._urls = undefined
    return this
  }

  /**
   * Consume queued runs (`agent.enqueue()`) from the Cloudflare Queue named `queue` (default: every queue).
   * Call it once, e.g. from an AppConfig's `ready()`. Returns an unregister function.
   */
  consumeQueue(queue = '*'): () => void {
    return consumeAgentQueue(queue, (name) => this.create(name))
  }

  /** A fresh agent instance for `name`. */
  create(name: string): Agent {
    const cls = this.registry.get(name)
    if (!cls) throw new ImproperlyConfigured(`No agent registered as '${name}'.`)
    const agent = new cls()
    agent.agentName = name
    return agent
  }

  /** Registered agent names. */
  get names(): string[] {
    return [...this.registry.keys()]
  }

  getUrls(): UrlPatterns {
    const prefix = this.opts.urlNamePrefix ?? 'agents'
    const out: UrlPatterns = []
    for (const name of this.registry.keys()) {
      const init = { agentRouter: this, agentName: name }
      const chat = AgentChatView.asView(init)
      out.push(
        path(`${name}/chat/`, chat, { name: `${prefix}-${name}-chat` }),
        path(`${name}/chat`, chat),
        path(`${name}/conversations/`, ConversationListView.asView(init), {
          name: `${prefix}-${name}-conversations`,
        }),
        path(`${name}/conversations/<uuid:id>/`, ConversationDetailView.asView(init), {
          name: `${prefix}-${name}-conversation`,
        }),
      )
    }
    return out
  }

  /**
   * A Streamable HTTP MCP endpoint exposing `tools` plus the registered agents as `ask_<name>` tools
   * (`agents: false` to leave them out, or a list of names). Mount it with `path('mcp/', agents.mcp())`.
   */
  mcp(opts: Omit<McpServerOptions, 'agents'> & { agents?: boolean | string[] } = {}): UrlPatterns {
    return this.mcpServer(opts).urls
  }

  /** The `McpServer` behind `mcp()` (for tests / custom mounting). */
  mcpServer(opts: Omit<McpServerOptions, 'agents'> & { agents?: boolean | string[] } = {}): McpServer {
    const { agents = true, ...rest } = opts
    const names = agents === true ? this.names : agents === false ? [] : agents
    const factories: Record<string, () => Agent> = {}
    for (const name of names) factories[name] = () => this.create(name)
    return new McpServer({ ...rest, agents: factories })
  }

  /** URL patterns to `include()`. */
  get urls(): UrlPatterns {
    this._urls ??= this.getUrls()
    return this._urls
  }
}
