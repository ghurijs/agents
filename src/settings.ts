import { tryGetContext } from '@ghuri/core'
import type { AuthenticationClass, PermissionClass } from '@ghuri/rest'
import { IsAuthenticated } from '@ghuri/rest'
import type { LanguageModel } from 'ai'
import type { ProviderContext } from './providers'

/** Credentials / options for one provider (`AGENTS.PROVIDERS.anthropic`). */
export interface ProviderConfig {
  apiKey?: string
  baseURL?: string
  /**
   * Extra HTTP headers on every request to the provider. A function is called once per run, with the run's agent,
   * user and carried context (`{ tenant }`), so headers can name who the call is for.
   */
  headers?:
    | Record<string, string>
    | ((ctx: ProviderContext) => Record<string, string> | Promise<Record<string, string>>)
  /** Extra options passed to the provider factory (`createAnthropic({...})`). */
  [option: string]: unknown
}

/** `AGENTS` settings. Every key is optional. */
export interface AgentsSettings {
  /** Model used by agents without a `model` (`'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast'`). */
  DEFAULT_MODEL?: string | LanguageModel
  /** Workers AI binding name (default `'AI'`). */
  AI_BINDING?: string
  /** Provider credentials: `{ anthropic: { apiKey }, openai: { apiKey }, 'workers-ai': { gateway } }`. */
  PROVIDERS?: Record<string, ProviderConfig>
  /** Default step limit of the tool loop (default 10). */
  MAX_STEPS?: number
  /** Authentication for the chat / MCP endpoints (default `REST_FRAMEWORK.DEFAULT_AUTHENTICATION_CLASSES`). */
  AUTHENTICATION_CLASSES?: AuthenticationClass[]
  /** Permission classes for agents that don't set `permissionClasses` (default `[IsAuthenticated]`). */
  PERMISSION_CLASSES?: PermissionClass[]
  /** Queue producer binding used by `agent.enqueue()` (default `'AGENTS_QUEUE'`). */
  QUEUE_BINDING?: string
  /**
   * Save one `Run` row (table `agents_run`) per agent run: model, token usage, tool calls, outcome and timing.
   * Off by default; needs the agents app and its migrations. `{ messages: true }` also stores the run's messages
   * (prompts and answers: mind privacy and retention).
   */
  TRACE_RUNS?: boolean | { messages?: boolean }
  /**
   * The conversation model, `'app_label.ModelName'` (default `'agents.Conversation'`), like Django's
   * `AUTH_USER_MODEL`. Point it at your own model built from `conversationFields` (e.g. a tenant-scoped one) before
   * the first `migrate`; `agents.Conversation` then gets no table.
   */
  CONVERSATION_MODEL?: string
}

declare module '@ghuri/core' {
  interface GhuriSettings {
    /** `@ghuri/agents` settings. */
    AGENTS?: AgentsSettings
  }
}

export const DEFAULT_MAX_STEPS = 10

/** The `AGENTS` settings of the current context (empty outside a context). */
export function agentsSettings(): AgentsSettings {
  const s = tryGetContext()?.settings.AGENTS
  return (s && typeof s === 'object' ? s : {}) as AgentsSettings
}

/** Default permission classes for agent endpoints. */
export function defaultPermissionClasses(): PermissionClass[] {
  return agentsSettings().PERMISSION_CLASSES ?? [IsAuthenticated]
}
