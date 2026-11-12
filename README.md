# @ghuri/agents

AI agents for [Ghuri](https://github.com/ghurijs/ghuri) whose tools are **the models, serializers, viewsets
and permission classes you already wrote for your REST API** — plus a built-in **MCP server** so Claude
Desktop, Claude Code and other MCP clients can use the same tools. Built on the
[Vercel AI SDK](https://ai-sdk.dev) (v7): Workers AI, Anthropic and OpenAI out of the box.

> Status: alpha (`0.1.0-alpha.0`). APIs may change.

```bash
npm install @ghuri/agents@next ai zod
# plus the provider(s) you use:
npm install workers-ai-provider     # 'workers-ai:…' models (Cloudflare)
npm install @ai-sdk/anthropic       # 'anthropic:…'
npm install @ai-sdk/openai          # 'openai:…'
```

## Contents

1. [Concepts](#1-concepts)
2. [Quick start (Workers AI on Cloudflare)](#2-quick-start-workers-ai-on-cloudflare)
3. [Models and providers](#3-models-and-providers)
4. [Tools from your API: ModelTools, ViewSetTools, RouterTools](#4-tools-from-your-api)
5. [Custom tools](#5-custom-tools)
6. [Running agents from code](#6-running-agents-from-code)
7. [Conversation memory](#7-conversation-memory)
8. [HTTP endpoints and streaming to a frontend](#8-http-endpoints-and-streaming-to-a-frontend)
9. [MCP server (Claude Desktop / Claude Code)](#9-mcp-server)
10. [Background runs (Queues)](#10-background-runs)
11. [Security model](#11-security-model)
12. [Settings](#12-settings)
13. [Testing your agents](#13-testing-your-agents)

## 1. Concepts

| Piece | What it is |
|---|---|
| `Agent` | A class with a `model`, `instructions`, `tools` and `permissionClasses`. `run()` / `stream()` drive the AI SDK tool loop. |
| Tools | `ModelTools(Model)`, `ViewSetTools(ViewSet)`, `RouterTools(router)` generate tools (with JSON Schemas from your serializers) that execute through the **same REST pipeline** as HTTP; `@tool` / `tool()` for your own. |
| User | Every run has a user (`run(input, { user })`). Every tool executes **as that user**: your permission classes, querysets and `filter` scoping decide what the model may see or change. |
| Memory | `AgentsConfig` stores `Conversation`s and `Message`s with the ORM (D1, Postgres, SQLite). |
| `AgentRouter` | Mounts agents as HTTP endpoints (JSON or SSE in the AI SDK UI message stream format) and as an MCP server. |

## 2. Quick start (Workers AI on Cloudflare)

`wrangler.jsonc` — add the Workers AI binding:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "ai": { "binding": "AI" }
}
```

`src/settings.ts`:

```ts
import { AuthConfig, AuthenticationMiddleware, ContentTypesConfig, SessionMiddleware, SessionsConfig, AuthTokenConfig } from '@ghuri/auth'
import { SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'
import { AgentsConfig } from '@ghuri/agents'

export default defineSettings((env) => ({
  // …
  INSTALLED_APPS: [ContentTypesConfig, AuthConfig, SessionsConfig, AuthTokenConfig, ShopConfig, AgentsConfig],
  AGENTS: {
    DEFAULT_MODEL: 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    AUTHENTICATION_CLASSES: [TokenAuthentication, SessionAuthentication],
  },
}))
```

`src/shop/agents.ts`:

```ts
import { Agent, ModelTools, ToolError, ViewSetTools, tool } from '@ghuri/agents'
import { IsAuthenticated } from '@ghuri/rest'
import { z } from 'zod'
import { Order } from './models'
import { OrderSerializer } from './serializers'
import { TicketViewSet } from './views'

export class SupportAgent extends Agent {
  static agentName = 'support'
  instructions = 'You help customers with their orders. Be brief.'
  tools = [
    new ModelTools(Order, {
      actions: ['list', 'retrieve'],
      serializer: OrderSerializer,
      filter: (qs, user) => qs.filter({ customer: user.pk }),   // users only ever see their own orders
      searchFields: ['number'],
      orderingFields: ['createdAt'],
    }),
    new ViewSetTools(TicketViewSet, { actions: ['create'] }),     // tickets_create, with TicketViewSet's rules
  ]
  permissionClasses = [IsAuthenticated]

  @tool({ description: 'Request a refund for an order', input: z.object({ orderId: z.number() }) })
  async refund({ orderId }: { orderId: number }, { user }) {
    const order = await Order.objects.filter({ id: orderId, customer: user.pk }).first()
    if (!order) throw new ToolError(`Order ${orderId} not found.`)
    // …
    return { ok: true }
  }
}
```

`src/urls.ts`:

```ts
import { AgentRouter } from '@ghuri/agents'
import { include, path } from '@ghuri/core'
import { SupportAgent } from './shop/agents'

export const agents = new AgentRouter()
agents.register('support', SupportAgent)

export const urlpatterns = [
  path('agents/', include(agents.urls)),          // POST /agents/support/chat, GET /agents/support/conversations/
  path('mcp/', agents.mcp({ name: 'shop' })),     // Streamable HTTP MCP endpoint
]
```

The agents app ships its migration (`Conversation`, `Message`; the user foreign key follows
`AUTH_USER_MODEL`): create the tables with `ghuri migrate`.

```bash
curl -X POST https://shop.example.com/agents/support/chat \
  -H 'Authorization: Token <key>' -H 'Content-Type: application/json' \
  -d '{"message": "Where is my last order?"}'
# {"conversationId":"7c0e…","text":"Your order A-1042 shipped yesterday.","toolCalls":[…],"usage":{…}}
```

> `@tool` works as a standard TC39 decorator (TypeScript 5, esbuild, wrangler) and as a legacy one (Vitest's
> oxc with `oxc: { decorator: { legacy: true } }`, as `ghuri startproject` configures; jiti / the `ghuri` CLI).
> Prefer no decorators? See [Custom tools](#5-custom-tools).

## 3. Models and providers

`model` is a `'provider:model-id'` string or any AI SDK `LanguageModel` instance. Unset → `AGENTS.DEFAULT_MODEL`.

| Prefix | Package (loaded lazily) | Credentials |
|---|---|---|
| `workers-ai:` | `workers-ai-provider` | the `AI` binding (`AGENTS.AI_BINDING`) |
| `anthropic:` | `@ai-sdk/anthropic` | `AGENTS.PROVIDERS.anthropic.apiKey`, else env `ANTHROPIC_API_KEY` |
| `openai:` | `@ai-sdk/openai` | `AGENTS.PROVIDERS.openai.apiKey`, else env `OPENAI_API_KEY` |

```ts
class Analyst extends Agent {
  model = 'anthropic:claude-sonnet-4-5'
  temperature = 0.2
  maxSteps = 8                                  // tool round trips (default AGENTS.MAX_STEPS = 10)
  providerOptions = { anthropic: { thinking: { type: 'enabled', budgetTokens: 4000 } } }
}
// or an instance: model = createOpenAI({ apiKey, baseURL })('gpt-5-mini')
```

Extra options in `AGENTS.PROVIDERS[name]` are passed to the provider factory (`baseURL`, `headers`, Workers AI
`gateway`…). Provider packages are imported only when a model of that provider is first resolved, so unused
providers need not be installed (bundlers skip missing ones). Add providers with `registerProvider`:

```ts
import { registerProvider } from '@ghuri/agents'
registerProvider('google', async (id, { config, env }) => {
  const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
  return createGoogleGenerativeAI({ apiKey: config.apiKey ?? env.GOOGLE_API_KEY })(id)
})
```

## 4. Tools from your API

All generated tools run through `router.registry[i].invoke()` — the full DRF pipeline without HTTP:
authentication is forced to the run's user, then **permission classes, throttles, `getQueryset()`,
filters, pagination, serializer validation and representation** apply exactly as for an HTTP request.
4xx answers become tool errors the model can read (`"You do not have permission to perform this action. (HTTP 403)"`).

### ModelTools

```ts
new ModelTools(Order, {
  actions: ['list', 'retrieve', 'create', 'update', 'delete'],   // default ['list', 'retrieve']
  serializer: OrderSerializer,              // default: ModelSerializer with fields '__all__'
  filter: (qs, user) => qs.filter({ customer: user.pk }),         // applies to every action
  searchFields: ['number'],                 // → `search` argument
  orderingFields: ['createdAt', 'total'],   // → `ordering` argument
  filterFields: ['status'],                 // → exact-match arguments
  pageSize: 20,                             // → `page`, `pageSize` arguments
  permissionClasses: [IsAuthenticated],     // default REST_FRAMEWORK.DEFAULT_PERMISSION_CLASSES
  saveKwargs: (user) => ({ customer: user.pk }),   // values forced on create / update
})
```

Generates `orders_list`, `orders_retrieve`, `orders_create`, `orders_update` (partial update: only the given
fields change) and `orders_delete`. Input schemas come from the serializer (`jsonSchema({ mode: 'input' })`), so
read-only fields are not offered and choices become `enum`s. Tools carry MCP annotations
(`readOnlyHint`, `destructiveHint`, `idempotentHint`).

### ViewSetTools

```ts
new ViewSetTools(PostViewSet, { actions: ['list', 'retrieve', 'create', 'publish'] })   // posts_list, …, posts_publish
new ViewSetTools(router.registry[0])                                                    // every routed action
```

Any routed action works, including `@action`s (detail actions take an `id`; bodies use the action's serializer
when it sets `serializerClass`, otherwise a free-form `data` object). `'delete'` is accepted as an alias of `destroy`.
Options: `prefix` (tool name prefix), `basename`, `descriptions: { list: '…' }`.

### RouterTools

```ts
new RouterTools(router)                                     // the whole API
new RouterTools(router, { include: ['posts', 'comments'], readOnly: true })
new RouterTools(router, { exclude: ['users', 'posts_destroy'], actions: { posts: ['list', 'create'] } })
```

## 5. Custom tools

Three equivalent forms; tools receive `(input, ctx)` where `ctx.user` is the requesting user:

```ts
class OpsAgent extends Agent {
  // 1. decorator
  @tool({ description: 'Restart a job', input: z.object({ jobId: z.string() }) })
  async restartJob({ jobId }, { user }) { … }

  // 2. no decorators: options here, implementation in the method of the same name
  static tools = { cancelJob: tool({ description: 'Cancel a job', input: z.object({ jobId: z.string() }) }) }
  async cancelJob({ jobId }, ctx) { … }

  // 3. standalone, in the tools list
  tools = [tool({ name: 'now', description: 'Current server time', execute: () => new Date().toISOString() })]
}
```

`input` is a Zod schema (validated; descriptions and defaults reach the model) or a plain JSON Schema object.
Throw `ToolError` for failures the model should see; other exceptions are reported to the model as
"The tool failed with an internal error." (the real message only when `DEBUG`) and logged. Implement the
`Toolkit` interface (`getTools(): AgentTool[]`) to package your own tool collections.

## 6. Running agents from code

```ts
const result = await new SupportAgent().run('Where is order A-1042?', { user })
result.text            // final answer
result.toolCalls       // [{ toolName, input, output } | { toolName, input, error }]
result.messages        // AI SDK messages added by this run
result.usage           // tokens
result.conversationId  // pass it back to continue

await SupportAgent.run('…', { user, conversationId })   // static shortcut
```

Options: `user`, `conversationId`, `signal`, `memory` (force on/off), `checkPermissions` (check the agent's
`permissionClasses` — the HTTP and MCP layers always do), `context` (free-form values for hooks).

Instructions may depend on the run:

```ts
instructions = (ctx: AgentRunContext) => `You help ${ctx.user.username}. Today is ${new Date().toDateString()}.`
```

Hooks:

```ts
class Audited extends Agent {
  async beforeRun(ctx) { /* edit ctx.messages, throw to abort */ }
  async onToolCall(call, ctx) {                 // before every tool call
    if (call.toolName.endsWith('_delete') && !ctx.user.isStaff) throw new ToolError('Ask a staff member.')
  }
  async afterRun(result, ctx) { await AuditLog.objects.create({ … }) }
}
```

## 7. Conversation memory

With `AgentsConfig` installed, every run is stored as a `Conversation` (owner, agent name, title, metadata,
timestamps) with its `Message`s (role + AI SDK content parts — text, tool calls with inputs, tool results and
errors). Passing `conversationId` loads the history first. Conversations belong to their user: another user's
id fails with `ConversationNotFound` (404 over HTTP). Set `memory = false` on an agent (or `run(…, { memory: false })`)
for stateless runs. `loadMessages()`, `saveMessages()`, `createConversation()` are exported for custom flows.

The conversation's `agent` column is the agent name: the `AgentRouter.register()` name over HTTP/MCP, otherwise
`static agentName` (falling back to the class name — set `agentName` explicitly, minifiers rename classes).

## 8. HTTP endpoints and streaming to a frontend

`include(agents.urls)` serves, per registered agent:

| Route | |
|---|---|
| `POST <name>/chat` | body `{ message, conversationId? }` (or an AI SDK `useChat` body with `messages`). JSON `{ conversationId, text, toolCalls, usage, finishReason }`, or **SSE** in the AI SDK UI message stream format with `Accept: text/event-stream` or `?stream=1`. |
| `GET <name>/conversations/` | the user's conversations `{ count, results }` (`?limit=&offset=`). |
| `GET <name>/conversations/<id>/` | one conversation with its messages (owner only). |
| `DELETE <name>/conversations/<id>/` | delete it (owner only). |

When the model can't be used (provider package missing, no API key, no Workers AI binding) the chat answers
**503** `{ "detail": "The agent's language model is not available." }` — with the reason when `DEBUG` is on.

Authentication uses `AGENTS.AUTHENTICATION_CLASSES` (default: `REST_FRAMEWORK.DEFAULT_AUTHENTICATION_CLASSES`);
access uses the agent's `permissionClasses` (default `AGENTS.PERMISSION_CLASSES`, i.e. `[IsAuthenticated]`). With
session authentication, unsafe requests need the CSRF token (`X-CSRFToken`) like any API view.

The SSE stream's `start` chunk carries `messageMetadata: { conversationId }` (also in the `x-conversation-id`
header) and closes only after the conversation was saved. With React and `@ai-sdk/react`:

```tsx
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'

const conversationId = useRef<string>()
const { messages, sendMessage, status } = useChat({
  transport: new DefaultChatTransport({
    api: '/agents/support/chat?stream=1',
    headers: { 'X-CSRFToken': getCookie('csrftoken') },
    prepareSendMessagesRequest: ({ messages }) => ({
      body: { message: textOf(messages.at(-1)), conversationId: conversationId.current },
    }),
  }),
  onFinish: ({ message }) => { conversationId.current ??= message.metadata?.conversationId },
})
```

Programmatically: `const s = await agent.stream(input, { user })` → `s.toUIMessageStreamResponse()`,
`s.toUIMessageStream()`, `s.textStream`, `await s.done` (final `AgentRunResult`).

## 9. MCP server

`agents.mcp(options)` returns URL patterns for a **Streamable HTTP** MCP endpoint (JSON-RPC 2.0 over POST with
JSON responses; GET answers 405 — no server-initiated stream). Implemented in-house, Workers-safe.

```ts
path('mcp/', agents.mcp({
  name: 'shop', version: '1.0.0',
  instructions: 'Tools for the Example shop.',
  tools: [new RouterTools(router, { readOnly: true }), new ModelTools(Order, { filter: … })],
  agents: true,                         // registered agents as ask_<name> tools (or a list of names, or false)
  // authenticationClasses / permissionClasses: default AGENTS.AUTHENTICATION_CLASSES / AGENTS.PERMISSION_CLASSES
}))
// without an AgentRouter: new McpServer({ tools, agents: { support: () => new SupportAgent() } }).urls
```

Supported: `initialize` (protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`; the client's
version is echoed when supported), `notifications/*` (202), `ping`, `tools/list` (JSON Schema `inputSchema`,
annotations), `tools/call` (text + `structuredContent`; tool failures are results with `isError: true`),
empty `resources/list`, `resources/templates/list`, `prompts/list`, batches, and JSON-RPC errors
(`-32700`, `-32600`, `-32601`, `-32602`, `-32603`). Requests without valid credentials get HTTP 401 with
`WWW-Authenticate`; browser `Origin`s other than your host / `CSRF_TRUSTED_ORIGINS` are refused (DNS rebinding);
unknown `MCP-Protocol-Version` headers get 400.

Create a token for the user the client acts as (`ghuri drf_create_token alice`, or `Token.objects.create({ user })`).

**Claude Code** — `claude mcp add --transport http shop https://shop.example.com/mcp/ --header "Authorization: Token <key>"`,
or in `.mcp.json`:

```json
{
  "mcpServers": {
    "shop": {
      "type": "http",
      "url": "https://shop.example.com/mcp/",
      "headers": { "Authorization": "Token ${SHOP_TOKEN}" }
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`, through the `mcp-remote` bridge):

```json
{
  "mcpServers": {
    "shop": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://shop.example.com/mcp/", "--header", "Authorization:${SHOP_AUTH}"],
      "env": { "SHOP_AUTH": "Token 0123456789abcdef0123456789abcdef01234567" }
    }
  }
}
```

Clients that only send `Authorization: Bearer <token>`: add a keyword variant of `TokenAuthentication`
(or use `JWTAuthentication`):

```ts
class BearerTokenAuthentication extends TokenAuthentication { keyword = 'Bearer' }
AGENTS: { AUTHENTICATION_CLASSES: [TokenAuthentication, BearerTokenAuthentication] }
```

Mount the endpoint with a trailing slash and use that exact URL (`APPEND_SLASH` only redirects GETs).

## 10. Background runs

```ts
// wrangler.jsonc: "queues": { "producers": [{ "binding": "AGENTS_QUEUE", "queue": "agents" }],
//                            "consumers": [{ "queue": "agents" }] }
agents.consumeQueue('agents')                                   // once, e.g. in an AppConfig.ready()
const { conversationId } = await agents.create('support').enqueue('Summarize my week', { user })
```

The consumer reloads the user (`AUTH_USER_MODEL`), runs the agent and stores the result in the conversation
(created up front so you can poll `GET …/conversations/<id>/`). Failed runs are retried by the queue.

## 11. Security model

- **Tools act as the user, never as the server.** Generated tools force-authenticate the run's user and go
  through your viewset's permission classes, `getQueryset()` / `filter` scoping, object permissions and serializer
  validation. Anonymous runs are unauthenticated requests. The model cannot do anything the user could not do
  with your REST API — but it can do *anything* the user could, so expose only the actions you want
  (`ModelTools` is read-only by default) and keep `filter` scoping on multi-tenant data.
- **Endpoints require authentication by default** (`AGENTS.PERMISSION_CLASSES = [IsAuthenticated]`); set
  `[AllowAny]` deliberately for public agents (and consider throttling — LLM calls cost money).
- **Errors**: permission / validation / not-found failures are shown to the model; unexpected exceptions are not
  (generic message unless `DEBUG`).
- **Conversations** are owner-only; anonymous conversations are reachable only by their unguessable UUID.
- **Prompt injection**: data returned by tools (e.g. user-written text) can steer the model. Gate destructive or
  irreversible tools with `onToolCall`, keep `maxSteps` low, and audit with `afterRun`.
- **MCP**: token or session authentication through REST authentication classes; `Origin` validation; tools run as
  the token's user.

## 12. Settings

```ts
AGENTS: {
  DEFAULT_MODEL: 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast',   // or a LanguageModel
  AI_BINDING: 'AI',                                        // Workers AI binding name
  PROVIDERS: { anthropic: { apiKey: env.ANTHROPIC_API_KEY }, openai: { apiKey: env.OPENAI_API_KEY } },
  MAX_STEPS: 10,                                           // default tool-loop steps
  AUTHENTICATION_CLASSES: [TokenAuthentication, SessionAuthentication],   // default: REST defaults
  PERMISSION_CLASSES: [IsAuthenticated],                   // default for agents / MCP
  QUEUE_BINDING: 'AGENTS_QUEUE',                           // enqueue() producer binding
}
```

## 13. Testing your agents

Use the AI SDK mock model — no network:

```ts
import { MockLanguageModelV4 } from 'ai/test'

const model = new MockLanguageModelV4({
  doGenerate: [
    { content: [{ type: 'tool-call', toolCallId: '1', toolName: 'orders_list', input: '{}' }],
      finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [] },
    { content: [{ type: 'text', text: 'You have 2 orders.' }],
      finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] },
  ],
})
class TestAgent extends SupportAgent { model = model }
const result = await new TestAgent().run('orders?', { user })
expect(result.toolCalls[0].output.count).toBe(2)
```

For HTTP / MCP tests, mount the router in `ROOT_URLCONF` and use `@ghuri/core/testing` / `@ghuri/rest/testing`
clients (`client.forceAuthenticate(user)` or a real `Authorization: Token …` header).

## License

MIT
