import {
  anonymousUser,
  type GhuriContext,
  ImproperlyConfigured,
  type RequestUser,
  tryGetContext,
} from '@ghuri/core'
import type { APIRequest, PermissionClass } from '@ghuri/rest'
import { NotAuthenticated, PermissionDenied } from '@ghuri/rest'
import {
  tool as aiTool,
  createUIMessageStreamResponse,
  generateText,
  type JSONSchema7,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StreamTextResult,
  stepCountIs,
  streamText,
  type ToolSet,
  type UIMessageChunk,
} from 'ai'
import {
  ConversationNotFound,
  createConversation,
  getConversation,
  loadMessages,
  memoryAvailable,
  saveMessages,
  titleFrom,
} from './memory'
import type { Conversation } from './models'
import { resolveModel } from './providers'
import { type EnqueueOptions, enqueueRun } from './queue'
import { agentsSettings, DEFAULT_MAX_STEPS, defaultPermissionClasses } from './settings'
import { inContext, toToolError } from './tools/execute'
import { collectDeclaredTools, isToolDecorator, standaloneTool, type ToolDecorator } from './tools/tool'
import { type AgentTool, isAgentTool, isToolkit, type ToolContext, type Toolkit } from './tools/types'

/** What can go in an agent's `tools`: toolkits, standalone `tool({...execute})`s and `AgentTool`s. */
export type ToolEntry = Toolkit | ToolDecorator | AgentTool
export type ToolsInput = ToolEntry[] | Record<string, ToolEntry>

/** Input of a run: a user message, or AI SDK model messages to append. */
export type AgentInput = string | ModelMessage[]

export interface RunOptions {
  /** The user the agent acts for; every tool runs with this user's permissions (default: anonymous). */
  user?: RequestUser | null
  /** Continue a stored conversation (must belong to `user` and this agent). */
  conversationId?: string | null
  signal?: AbortSignal
  /** Load / save conversation memory (default: when the `agents` app is installed and `agent.memory`). */
  memory?: boolean
  /** Check the agent's `permissionClasses` for `user` first (HTTP and MCP always do). */
  checkPermissions?: boolean
  /** The REST request when running for an HTTP / MCP call. */
  request?: APIRequest
  /** Free-form values available to `instructions(ctx)` and hooks as `ctx.extra`. */
  context?: Record<string, unknown>
  /** Title for a new conversation (default: from the first message). */
  title?: string
}

/** Per-run state passed to `instructions(ctx)` and the hooks. */
export interface AgentRunContext {
  agent: Agent
  agentName: string
  user: RequestUser
  input: AgentInput
  conversationId?: string
  conversation?: Conversation
  /** Full prompt: stored history + the new messages. Hooks may edit it. */
  messages: ModelMessage[]
  /** The new messages of this run (saved to memory with the response). */
  newMessages: ModelMessage[]
  signal?: AbortSignal
  request?: APIRequest
  extra: Record<string, unknown>
}

/** A tool call made during a run. */
export interface ToolCallRecord {
  toolCallId: string
  toolName: string
  input: unknown
  output?: unknown
  /** Error message returned to the model (permission denied, validation…). */
  error?: string
}

export interface AgentRunResult {
  text: string
  /** Messages added by this run: the input and the response (assistant / tool messages). */
  messages: ModelMessage[]
  toolCalls: ToolCallRecord[]
  usage: LanguageModelUsage
  finishReason: string
  steps: number
  conversationId?: string
}

/** Passed to `onToolCall` before a tool runs. Throw (e.g. `ToolError`) to refuse the call. */
export interface ToolCallInfo {
  toolName: string
  toolCallId?: string
  input: unknown
}

interface Prepared {
  ctx: AgentRunContext
  model: LanguageModel
  instructions?: string
  tools: ToolSet
  ghuri?: GhuriContext
}

function deriveName(cls: Function): string {
  const base = cls.name.replace(/Agent$/, '') || cls.name || 'agent'
  return base
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .toLowerCase()
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}

function toolCallsFrom(content: ReadonlyArray<any>): ToolCallRecord[] {
  const calls = new Map<string, ToolCallRecord>()
  for (const part of content) {
    if (part.type === 'tool-call') {
      calls.set(part.toolCallId, { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })
    } else if (part.type === 'tool-result' || part.type === 'tool-error') {
      const rec: ToolCallRecord = calls.get(part.toolCallId) ?? {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      }
      if (part.type === 'tool-result') rec.output = part.output
      else rec.error = errorText(part.error)
      calls.set(part.toolCallId, rec)
    }
  }
  return [...calls.values()]
}

/**
 * An LLM agent with tools that run as the requesting user.
 *
 * ```ts
 * export class SupportAgent extends Agent {
 *   model = 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast'
 *   instructions = 'You help customers with their orders.'
 *   tools = [new ModelTools(Order, { actions: ['list', 'retrieve'], filter: (qs, user) => qs.filter({ customer: user.pk }) })]
 *   permissionClasses = [IsAuthenticated]
 *
 *   @tool({ description: 'Refund an order', input: z.object({ orderId: z.number() }) })
 *   async refund({ orderId }, { user }) { ... }
 * }
 * const { text, conversationId } = await new SupportAgent().run('Where is my order?', { user })
 * ```
 */
export class Agent {
  /** Name used for conversations, URLs and MCP (`ask_<name>`); default: class name minus `Agent`, kebab-case. */
  static agentName?: string
  /** Shown to MCP clients for the `ask_<name>` tool. */
  static description?: string
  /** Tools implemented by methods of the same name, without decorators: `{ refund: tool({...}) }`. */
  static tools?: Record<string, ToolDecorator>

  /** `'provider:model-id'` or an AI SDK `LanguageModel` (default `AGENTS.DEFAULT_MODEL`). */
  model?: string | LanguageModel
  /** System instructions, or a function of the run context. */
  instructions?: string | ((ctx: AgentRunContext) => string | Promise<string>)
  /** Toolkits and tools (plus `@tool` methods and `static tools`). */
  tools?: ToolsInput
  /** REST permission classes checked for HTTP / MCP access (default `AGENTS.PERMISSION_CLASSES`). */
  permissionClasses?: PermissionClass[]
  /** Maximum model steps (tool round trips) per run (default `AGENTS.MAX_STEPS`, 10). */
  maxSteps?: number
  temperature?: number
  maxOutputTokens?: number
  /** Provider-specific options passed to the AI SDK (`{ anthropic: { thinking: … } }`). */
  providerOptions?: Record<string, any>
  /** Use conversation memory when the `agents` app is installed (default true). */
  memory = true
  /** Set by `AgentRouter.register(name, …)`. */
  agentName?: string

  /** Called before the model runs; may edit `ctx.messages`. Throw to abort the run. */
  beforeRun?(ctx: AgentRunContext): void | Promise<void>
  /** Called after a run finished and was saved. */
  afterRun?(result: AgentRunResult, ctx: AgentRunContext): void | Promise<void>
  /** Called before every tool call. Throw (e.g. `ToolError`) to refuse it; the model sees the error. */
  onToolCall?(call: ToolCallInfo, ctx: AgentRunContext): void | Promise<void>

  /** `new this().run(input, opts)`. */
  static run<T extends Agent>(
    this: new () => T,
    input: AgentInput,
    opts?: RunOptions,
  ): Promise<AgentRunResult> {
    return new this().run(input, opts)
  }

  getName(): string {
    const cls = this.constructor as typeof Agent
    return this.agentName ?? (Object.hasOwn(cls, 'agentName') ? cls.agentName : undefined) ?? deriveName(cls)
  }

  getDescription(): string {
    const cls = this.constructor as typeof Agent
    return cls.description ?? `Ask the ${this.getName()} agent. It answers in natural language.`
  }

  getPermissionClasses(): PermissionClass[] {
    return this.permissionClasses ?? defaultPermissionClasses()
  }

  /** System instructions for a run (override for dynamic instructions). */
  async getInstructions(ctx: AgentRunContext): Promise<string | undefined> {
    const i = this.instructions
    return typeof i === 'function' ? await i.call(this, ctx) : i
  }

  /** All tools of this agent, normalized (toolkits expanded, declared methods bound). */
  getTools(): AgentTool[] {
    const out: AgentTool[] = []
    const add = (entry: unknown, key?: string) => {
      if (isToolDecorator(entry)) out.push(standaloneTool(entry, key))
      else if (isAgentTool(entry)) out.push(key && !entry.name ? { ...entry, name: key } : entry)
      else if (isToolkit(entry)) out.push(...entry.getTools())
      else
        throw new ImproperlyConfigured(
          `${this.constructor.name}.tools: unsupported entry ${key ? `'${key}'` : String(entry)} (use toolkits, tool({...}) or AgentTool objects).`,
        )
    }
    const tools = this.tools
    if (Array.isArray(tools)) for (const t of tools) add(t)
    else if (tools && typeof tools === 'object') for (const [k, t] of Object.entries(tools)) add(t, k)
    out.push(...collectDeclaredTools(this))
    const seen = new Set<string>()
    for (const t of out) {
      if (seen.has(t.name))
        throw new ImproperlyConfigured(`${this.constructor.name} has two tools named '${t.name}'.`)
      seen.add(t.name)
    }
    return out
  }

  /** Check `permissionClasses` for `user` (`NotAuthenticated` / `PermissionDenied` from `@ghuri/rest`). */
  async checkPermissions(user: RequestUser, request?: APIRequest): Promise<void> {
    const req: any = request ?? { user, auth: null, method: 'POST', successfulAuthenticator: null }
    for (const P of this.getPermissionClasses()) {
      const p = new P()
      if (!(await p.hasPermission(req, this))) {
        if (!user.isAuthenticated) throw new NotAuthenticated()
        throw new PermissionDenied((p.message as any) ?? null, p.code ?? null)
      }
    }
  }

  /** AI SDK tool set for a run: validation, `onToolCall`, context and error normalization included. */
  buildToolSet(ctx: AgentRunContext, tools: AgentTool[] = this.getTools()): ToolSet {
    const ghuri = tryGetContext()
    const set: ToolSet = {}
    for (const t of tools) {
      set[t.name] = aiTool({
        description: t.description,
        inputSchema: jsonSchema(t.inputSchema as JSONSchema7, {
          validate: (value: unknown) => {
            try {
              return { success: true, value: t.parse ? t.parse(value) : value }
            } catch (error) {
              return { success: false, error: toToolError(error, t.name) }
            }
          },
        }),
        execute: (input: unknown, opts: { toolCallId: string; abortSignal?: AbortSignal }) =>
          inContext(ghuri, async () => {
            const toolCtx: ToolContext = {
              user: ctx.user,
              agent: this,
              conversationId: ctx.conversationId,
              toolCallId: opts.toolCallId,
              signal: opts.abortSignal ?? ctx.signal,
              request: ctx.request,
            }
            try {
              await this.onToolCall?.({ toolName: t.name, toolCallId: opts.toolCallId, input }, ctx)
              return await t.execute(input, toolCtx)
            } catch (err) {
              throw toToolError(err, t.name)
            }
          }),
      } as any)
    }
    return set
  }

  protected async prepare(input: AgentInput, opts: RunOptions): Promise<Prepared> {
    const user = opts.user ?? anonymousUser
    if (opts.checkPermissions) await this.checkPermissions(user, opts.request)
    // Resolve the model first: a missing provider / key / binding must not leave an empty conversation behind.
    const model = await resolveModel(this.model)
    const agentName = this.getName()
    const useMemory = opts.memory ?? (this.memory !== false && memoryAvailable())
    let conversation: Conversation | undefined
    let history: ModelMessage[] = []
    if (opts.conversationId) {
      if (!memoryAvailable()) {
        throw new ImproperlyConfigured(
          'conversationId requires the agents app: add AgentsConfig to INSTALLED_APPS.',
        )
      }
      conversation = await getConversation(agentName, opts.conversationId, user)
      history = await loadMessages(conversation)
    } else if (useMemory) {
      conversation = await createConversation(agentName, user, { title: opts.title ?? titleFrom(input) })
    }
    const newMessages: ModelMessage[] =
      typeof input === 'string' ? [{ role: 'user', content: input }] : [...input]
    const ctx: AgentRunContext = {
      agent: this,
      agentName,
      user,
      input,
      conversation,
      conversationId: conversation ? String(conversation.pk) : undefined,
      messages: [...history, ...newMessages],
      newMessages,
      signal: opts.signal,
      request: opts.request,
      extra: opts.context ?? {},
    }
    await this.beforeRun?.(ctx)
    const instructions = await this.getInstructions(ctx)
    return { ctx, model, instructions, tools: this.buildToolSet(ctx), ghuri: tryGetContext() }
  }

  protected callSettings(p: Prepared): Record<string, unknown> {
    return {
      model: p.model,
      ...(p.instructions ? { instructions: p.instructions } : {}),
      messages: p.ctx.messages,
      tools: p.tools,
      stopWhen: stepCountIs(this.maxSteps ?? agentsSettings().MAX_STEPS ?? DEFAULT_MAX_STEPS),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(this.maxOutputTokens !== undefined ? { maxOutputTokens: this.maxOutputTokens } : {}),
      ...(this.providerOptions ? { providerOptions: this.providerOptions } : {}),
      ...(p.ctx.signal ? { abortSignal: p.ctx.signal } : {}),
    }
  }

  protected async finish(
    p: Prepared,
    r: {
      text: string
      responseMessages: ModelMessage[]
      content: ReadonlyArray<any>
      usage: LanguageModelUsage
      finishReason: string
      steps: number
    },
  ): Promise<AgentRunResult> {
    const messages = [...p.ctx.newMessages, ...r.responseMessages]
    if (p.ctx.conversation) await saveMessages(p.ctx.conversation, messages)
    const result: AgentRunResult = {
      text: r.text,
      messages,
      toolCalls: toolCallsFrom(r.content),
      usage: r.usage,
      finishReason: r.finishReason,
      steps: r.steps,
      conversationId: p.ctx.conversationId,
    }
    await this.afterRun?.(result, p.ctx)
    return result
  }

  /**
   * Run the agent to completion (tool loop included). Tool failures (permission denied, validation, not
   * found) are returned to the model as tool errors; the run itself only throws for model / config errors.
   */
  async run(input: AgentInput, opts: RunOptions = {}): Promise<AgentRunResult> {
    const p = await this.prepare(input, opts)
    const res = await generateText(this.callSettings(p) as any)
    return this.finish(p, {
      text: res.text,
      responseMessages: res.responseMessages as ModelMessage[],
      content: res.content,
      usage: res.usage,
      finishReason: res.finishReason,
      steps: res.steps.length,
    })
  }

  /**
   * Run in the background through a Cloudflare Queue (`AGENTS.QUEUE_BINDING`); a consumer registered with
   * `AgentRouter.consumeQueue()` performs the run. Returns the conversation id to poll.
   */
  async enqueue(input: AgentInput, opts: EnqueueOptions = {}): Promise<{ conversationId?: string }> {
    return enqueueRun(this, input, opts)
  }

  /**
   * Stream a run. Use `toUIMessageStreamResponse()` for AI SDK UI (`useChat`) / SSE clients, or `textStream`.
   * The conversation is saved when the stream finishes; `await stream.done` for the final result.
   */
  async stream(input: AgentInput, opts: RunOptions = {}): Promise<AgentStream> {
    const p = await this.prepare(input, opts)
    const result = streamText(this.callSettings(p) as any) as StreamTextResult<ToolSet, any, any>
    const done = (async () => {
      const [text, responseMessages, content, usage, finishReason, steps] = await Promise.all([
        result.text,
        result.responseMessages,
        result.content,
        result.usage,
        result.finishReason,
        result.steps,
      ])
      return inContext(p.ghuri, () =>
        this.finish(p, {
          text,
          responseMessages: responseMessages as ModelMessage[],
          content,
          usage,
          finishReason,
          steps: steps.length,
        }),
      )
    })()
    done.catch(() => {})
    p.ghuri?.executionCtx?.waitUntil(done.catch(() => {}))
    return new AgentStream(result, done, p.ctx.conversationId)
  }
}

/** A streaming run (`agent.stream()`). */
export class AgentStream {
  constructor(
    /** The AI SDK `streamText` result (fullStream, textStream, …). */
    readonly result: StreamTextResult<ToolSet, any, any>,
    /** Resolves after the stream finished and the conversation was saved. */
    readonly done: Promise<AgentRunResult>,
    readonly conversationId?: string,
  ) {}

  /** Plain text deltas. */
  get textStream(): AsyncIterable<string> & ReadableStream<string> {
    return this.result.textStream
  }

  /**
   * AI SDK UI message stream chunks (`start`, `text-delta`, `tool-input-available`, `tool-output-available`,
   * `finish`…). The `start` chunk carries `messageMetadata: { conversationId }`. The stream closes only after
   * the conversation was saved.
   */
  toUIMessageStream(): ReadableStream<UIMessageChunk> {
    const conversationId = this.conversationId
    const done = this.done
    const stream = this.result.toUIMessageStream({
      messageMetadata: ({ part }: { part: { type: string } }) =>
        part.type === 'start' && conversationId ? { conversationId } : undefined,
      onError: (error: unknown) => errorText(error),
    } as any) as unknown as ReadableStream<UIMessageChunk>
    return stream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        async flush(controller) {
          try {
            await done
          } catch (err) {
            controller.enqueue({ type: 'error', errorText: errorText(err) } as UIMessageChunk)
          }
        },
      }),
    )
  }

  /** An SSE `Response` in the AI SDK UI message stream protocol (header `x-conversation-id`). */
  toUIMessageStreamResponse(init: { status?: number; headers?: Record<string, string> } = {}): Response {
    return createUIMessageStreamResponse({
      status: init.status,
      headers: {
        ...(this.conversationId ? { 'x-conversation-id': this.conversationId } : {}),
        ...(init.headers ?? {}),
      },
      stream: this.toUIMessageStream(),
    })
  }
}

export { ConversationNotFound }
