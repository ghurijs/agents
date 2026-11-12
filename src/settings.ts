import { tryGetContext } from '@ghuri/core'
import type { AuthenticationClass, PermissionClass } from '@ghuri/rest'
import { IsAuthenticated } from '@ghuri/rest'
import type { LanguageModel } from 'ai'

/** Credentials / options for one provider (`AGENTS.PROVIDERS.anthropic`). */
export interface ProviderConfig {
  apiKey?: string
  baseURL?: string
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
