import { type Env, type RequestUser, tryGetContext } from '@ghuri/core'
import type { LanguageModel } from 'ai'
import { captureCarried } from './carry'
import { ModelResolutionError } from './errors'
import { type AgentsSettings, agentsSettings, type ProviderConfig } from './settings'

/** Who a model is resolved for: set when an agent run resolves its model. */
export interface ProviderRunInfo {
  /** The agent's registered name. */
  agent: string
  /** The user the run acts for (anonymous when nobody signed in). */
  user: RequestUser
  /** The request context carried by `@ghuri/core` context carriers (`{ tenant: '42' }`), `{}` when none. */
  carried: Record<string, string>
}

export interface ProviderContext {
  /** Worker bindings / environment variables of the current request. */
  env: Env
  settings: AgentsSettings
  /** `AGENTS.PROVIDERS[name]`, with a `headers` function already called (empty object when unset). */
  config: ProviderConfig
  /** The run the model is for; absent when `resolveModel()` is called outside an agent run. */
  run?: ProviderRunInfo
}

/** Builds a model for `'<provider>:<modelId>'`. Import provider packages lazily inside the factory. */
export type ProviderFactory = (
  modelId: string,
  ctx: ProviderContext,
) => LanguageModel | Promise<LanguageModel>

const KEY = Symbol.for('ghuri.agents.providers')
const g = globalThis as any
if (!g[KEY]) g[KEY] = new Map<string, ProviderFactory>()
const providers: Map<string, ProviderFactory> = g[KEY]

/**
 * Register (or replace) a model provider used by `'name:model-id'` strings.
 *
 * ```ts
 * registerProvider('google', async (id, { config }) => {
 *   const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
 *   return createGoogleGenerativeAI({ apiKey: config.apiKey })(id)
 * })
 * ```
 */
export function registerProvider(name: string, factory: ProviderFactory): void {
  providers.set(name, factory)
}

export function unregisterProvider(name: string): boolean {
  return providers.delete(name)
}

/** Names of registered providers. */
export function getProviders(): string[] {
  return [...providers.keys()]
}

function processEnv(name: string): string | undefined {
  const p = (globalThis as any).process
  return p?.env?.[name]
}

function apiKey(ctx: ProviderContext, envName: string): string | undefined {
  const v = ctx.config.apiKey ?? ctx.env?.[envName] ?? processEnv(envName)
  return typeof v === 'string' && v ? v : undefined
}

function missingPackage(pkg: string, provider: string, cause: unknown): ModelResolutionError {
  return new ModelResolutionError(
    `The '${provider}:' model provider needs the '${pkg}' package: npm install ${pkg}`,
    { cause } as never,
  )
}

function withoutKnown(config: ProviderConfig): Record<string, unknown> {
  const { apiKey: _k, ...rest } = config
  return rest
}

// Each import sits in its own try block: bundlers (esbuild / wrangler) then leave a missing optional
// provider package unresolved instead of failing the build, and only used providers are ever loaded.

registerProvider('workers-ai', async (modelId, ctx) => {
  const bindingName = ctx.settings.AI_BINDING ?? 'AI'
  const binding = ctx.env?.[bindingName]
  if (!binding) {
    throw new ModelResolutionError(
      `Workers AI binding '${bindingName}' not found in env. Add "ai": { "binding": "${bindingName}" } to wrangler.jsonc or set AGENTS.AI_BINDING.`,
    )
  }
  let mod: typeof import('workers-ai-provider')
  try {
    mod = await import('workers-ai-provider')
  } catch (err) {
    throw missingPackage('workers-ai-provider', 'workers-ai', err)
  }
  return mod.createWorkersAI({ ...(withoutKnown(ctx.config) as object), binding } as any)(modelId as any)
})

registerProvider('anthropic', async (modelId, ctx) => {
  let mod: typeof import('@ai-sdk/anthropic')
  try {
    mod = await import('@ai-sdk/anthropic')
  } catch (err) {
    throw missingPackage('@ai-sdk/anthropic', 'anthropic', err)
  }
  return mod.createAnthropic({ ...withoutKnown(ctx.config), apiKey: apiKey(ctx, 'ANTHROPIC_API_KEY') })(
    modelId,
  )
})

registerProvider('openai', async (modelId, ctx) => {
  let mod: typeof import('@ai-sdk/openai')
  try {
    mod = await import('@ai-sdk/openai')
  } catch (err) {
    throw missingPackage('@ai-sdk/openai', 'openai', err)
  }
  return mod.createOpenAI({ ...withoutKnown(ctx.config), apiKey: apiKey(ctx, 'OPENAI_API_KEY') })(modelId)
})

function configValue(ctx: ProviderContext, key: string, envName: string): string | undefined {
  const v = ctx.config[key] ?? ctx.env?.[envName] ?? processEnv(envName)
  return typeof v === 'string' && v ? v : undefined
}

/**
 * Headers naming who a ghuri-ai call is for: `x-ghuri-agent`, `x-ghuri-user` (authenticated users only) and one
 * `x-ghuri-<name>` per carried context value (`x-ghuri-tenant`). Used for metering and budgets.
 */
export function ghuriAIHeaders(run: ProviderRunInfo | undefined): Record<string, string> {
  if (!run) return {}
  const out: Record<string, string> = { 'x-ghuri-agent': run.agent }
  if (run.user?.isAuthenticated && run.user.pk !== null && run.user.pk !== undefined) {
    out['x-ghuri-user'] = String(run.user.pk)
  }
  for (const [name, value] of Object.entries(run.carried ?? {})) {
    if (/^[a-z0-9-]+$/i.test(name)) out[`x-ghuri-${name.toLowerCase()}`] = value
  }
  return out
}

// ghuri-ai: the model gateway. `ghuri-ai:<alias>` (`fast`, `smart`, …) goes to its OpenAI-compatible
// `/v1/chat/completions`; `ghuri-ai:anthropic/<model>` and `ghuri-ai:openai/<model>` go to its pass-through routes
// with the provider's own SDK, so provider options (Anthropic prompt caching, thinking) keep working.
registerProvider('ghuri-ai', async (modelId, ctx) => {
  const base = configValue(ctx, 'baseURL', 'GHURI_AI_URL')?.replace(/\/+$/, '')
  if (!base) {
    throw new ModelResolutionError(
      "The 'ghuri-ai:' model provider needs the gateway URL: set AGENTS.PROVIDERS['ghuri-ai'].baseURL or GHURI_AI_URL.",
    )
  }
  const key = apiKey(ctx, 'GHURI_AI_API_KEY')
  const { apiKey: _k, baseURL: _b, headers: configHeaders, ...rest } = ctx.config
  const headers = { ...ghuriAIHeaders(ctx.run), ...((configHeaders as Record<string, string>) ?? {}) }
  const slash = modelId.indexOf('/')
  const via = slash > 0 ? modelId.slice(0, slash) : ''
  if (via === 'anthropic') {
    let mod: typeof import('@ai-sdk/anthropic')
    try {
      mod = await import('@ai-sdk/anthropic')
    } catch (err) {
      throw missingPackage('@ai-sdk/anthropic', 'ghuri-ai', err)
    }
    return mod.createAnthropic({ ...rest, baseURL: `${base}/v1/anthropic`, apiKey: key, headers })(
      modelId.slice(slash + 1),
    )
  }
  let mod: typeof import('@ai-sdk/openai')
  try {
    mod = await import('@ai-sdk/openai')
  } catch (err) {
    throw missingPackage('@ai-sdk/openai', 'ghuri-ai', err)
  }
  if (via === 'openai') {
    return mod.createOpenAI({ ...rest, baseURL: `${base}/v1/openai`, apiKey: key, headers })(
      modelId.slice(slash + 1),
    )
  }
  return mod.createOpenAI({ ...rest, baseURL: `${base}/v1`, apiKey: key, headers }).chat(modelId)
})

/** Is `value` an AI SDK language model instance (not a string id)? */
export function isLanguageModel(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as any).modelId === 'string' &&
    (typeof (value as any).doGenerate === 'function' || typeof (value as any).doStream === 'function')
  )
}

/**
 * Resolve an agent's `model`: an AI SDK `LanguageModel` is returned as is; `'provider:model-id'` strings go
 * through the provider registry (`workers-ai:`, `anthropic:`, `openai:`, `ghuri-ai:` built in). Falls back to
 * `AGENTS.DEFAULT_MODEL`.
 */
export async function resolveModel(
  model?: string | LanguageModel | null,
  env?: Env,
  run?: Omit<ProviderRunInfo, 'carried'> & { carried?: Record<string, string> },
): Promise<LanguageModel> {
  const settings = agentsSettings()
  const m = model ?? settings.DEFAULT_MODEL
  if (!m) {
    throw new ModelResolutionError(
      "No model configured: set `model` on the agent (e.g. 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast') or AGENTS.DEFAULT_MODEL.",
    )
  }
  if (typeof m !== 'string') return m
  const i = m.indexOf(':')
  if (i <= 0) {
    throw new ModelResolutionError(
      `Model '${m}' must be '<provider>:<model-id>' (providers: ${getProviders().join(', ')}).`,
    )
  }
  const name = m.slice(0, i)
  const modelId = m.slice(i + 1)
  const factory = providers.get(name)
  if (!factory) {
    throw new ModelResolutionError(
      `Unknown model provider '${name}' in '${m}' (registered: ${getProviders().join(', ')}). Use registerProvider().`,
    )
  }
  const ctx: ProviderContext = {
    env: env ?? tryGetContext()?.env ?? {},
    settings,
    config: settings.PROVIDERS?.[name] ?? {},
    ...(run ? { run: { ...run, carried: run.carried ?? captureCarried() } } : {}),
  }
  if (typeof ctx.config.headers === 'function') {
    ctx.config = { ...ctx.config, headers: await ctx.config.headers(ctx) }
  }
  return factory(modelId, ctx)
}
