# Changelog

## Unreleased

- MCP protocol revision **2026-07-28** (stateless) next to the legacy revisions on the same endpoint: no `initialize`
  or session; every request's `_meta` (`io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities`) and the
  `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers are validated (`-32602`, `-32020`, `-32022` with
  `data.supported` / `data.requested`, HTTP 400; `=?base64?…?=` header values decoded); `server/discover`; results carry
  `resultType: 'complete'` and `io.modelcontextprotocol/serverInfo`; lists carry `ttlMs` / `cacheScope`
  (`listTtlMs` option); unknown and removed methods (`ping`, `logging/setLevel`) answer 404 / `-32601`; batches are
  refused. New exports `MCP_MODERN_PROTOCOL_VERSIONS`, `MCP_LEGACY_PROTOCOL_VERSIONS`, `MCP_META`,
  `isModernProtocolVersion`, `JSONRPC.HEADER_MISMATCH` / `MISSING_REQUIRED_CLIENT_CAPABILITY` /
  `UNSUPPORTED_PROTOCOL_VERSION`.
- Behaviour change: `initialize` asking for an unknown or newer version now negotiates `2025-11-25`, the newest
  revision that has `initialize` (`MCP_LATEST_PROTOCOL_VERSION` is now `2026-07-28`).
- **MCP authorization (OAuth mode):** `McpServer({ oauth: { verifyAccessToken, … } })` accepts Bearer access tokens
  whose audience is the canonical MCP URL (RFC 8707), serves RFC 9728 Protected Resource Metadata
  (`server.wellKnownUrls`, `mcpWellKnownUrls(...servers)`) at `/.well-known/oauth-protected-resource[/<path>]`, answers
  `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` (`error="invalid_token"` for bad tokens) and
  `403 error="insufficient_scope"` for step-up. Works with `verifyAccessToken` from the new `@ghuri/oauth-provider`, or
  any verifier.
- Per-tool OAuth scopes: `tool({ scopes })`, `scopes` on `ModelTools` / `ViewSetTools` (a list or per action, `'*'`
  fallback), `requireScopes(scopes, toolOrToolkit)`, `AgentTool.scopes`; `requiredScopes`, `impliedScopes`,
  `hideUnauthorizedTools`. Helpers `missingScopes`, `expandScopes`, `bearerChallenge`, `canonicalResourceUrl`,
  `protectedResourceMetadataUrl`, `InsufficientScope`.

## 0.1.0-alpha.1

- Ship the initial migration (`Conversation`, `Message`; the user foreign key follows `AUTH_USER_MODEL`): `ghuri migrate` creates the tables, no `makemigrations agents` needed. Tests run the real migrations.
- `@tool` also works as a legacy decorator compiled by Babel with decorator metadata (jiti — the `ghuri` CLI's loader), which passes the prototype instead of the descriptor.
- Chat answers 503 `ModelUnavailable` (reason shown with `DEBUG`) when the model can't be resolved, instead of a 500; the model is resolved before a conversation is created, so failed runs leave no empty conversation.
- `McpServer({ agents })` accepts `Agent` subclasses as well as factories (`{ support: SupportAgent }` or `{ support: () => new SupportAgent() }`); previously a class was called without `new` and threw. New `AgentSource` type.

## 0.1.0-alpha.0

- `Agent` base class on the AI SDK v7 tool loop: `model` (`'workers-ai:…'`, `'anthropic:…'`, `'openai:…'` or a
  `LanguageModel`), `instructions` (string or function of the run), `tools`, `permissionClasses`, `maxSteps`,
  `temperature`, `maxOutputTokens`, `providerOptions`, hooks `beforeRun` / `onToolCall` / `afterRun`;
  `run()`, `stream()` (`AgentStream` with `toUIMessageStreamResponse()`), `enqueue()`.
- Lazy provider registry (`resolveModel`, `registerProvider`): provider packages are imported only when used and
  bundlers tolerate missing ones.
- Tools: `@tool` decorator (TC39), `static tools = { name: tool({...}) }`, standalone `tool({ ..., execute })`;
  `ModelTools`, `ViewSetTools`, `RouterTools` generating tools with JSON Schemas from serializers, filter backends
  and paginators, executed through `router.registry[i].invoke()` as the requesting user. Tool failures become
  tool errors for the model (`ToolError`).
- Conversation memory: `AgentsConfig` app with `Conversation` and `Message` models; automatic load / save,
  owner-only access.
- `AgentRouter`: `POST <name>/chat` (JSON, or SSE in the AI SDK UI message stream format),
  `GET <name>/conversations/`, `GET|DELETE <name>/conversations/<id>/`; queue consumer `consumeQueue()`.
- MCP: in-house Streamable HTTP server (`agents.mcp()`, `McpServer`) — `initialize`, `ping`, `tools/list`,
  `tools/call`, empty resources / prompts lists, notifications, batches, JSON-RPC errors; REST authentication
  classes; agents exposed as `ask_<name>` tools.
- Settings `AGENTS`: `DEFAULT_MODEL`, `AI_BINDING`, `PROVIDERS`, `MAX_STEPS`, `AUTHENTICATION_CLASSES`,
  `PERMISSION_CLASSES`, `QUEUE_BINDING`.
