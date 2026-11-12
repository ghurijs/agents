import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, type GhuriSettings, runWithContext } from '@ghuri/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getProviders,
  ModelResolutionError,
  registerProvider,
  resolveModel,
  unregisterProvider,
} from '../src/index'
import { scriptedModel } from './mock'

const loaded = vi.hoisted(() => ({ anthropic: 0, openai: 0, workers: 0, calls: [] as any[] }))

function fakeModel(provider: string, id: string, opts: unknown) {
  loaded.calls.push({ provider, id, opts })
  return { specificationVersion: 'v4', provider, modelId: id, opts, doGenerate: async () => ({}) }
}

vi.mock('@ai-sdk/anthropic', () => {
  loaded.anthropic++
  return { createAnthropic: (opts: unknown) => (id: string) => fakeModel('anthropic', id, opts) }
})
vi.mock('@ai-sdk/openai', () => {
  loaded.openai++
  return { createOpenAI: (opts: unknown) => (id: string) => fakeModel('openai', id, opts) }
})
vi.mock('workers-ai-provider', () => {
  loaded.workers++
  return { createWorkersAI: (opts: unknown) => (id: string) => fakeModel('workers-ai', id, opts) }
})

function withSettings<T>(
  agents: Record<string, unknown>,
  env: Record<string, unknown>,
  fn: () => Promise<T>,
) {
  const ctx = createContext({
    env,
    settings: {
      SECRET_KEY: 'x',
      INSTALLED_APPS: [],
      ROOT_URLCONF: [],
      AGENTS: agents,
    } as unknown as GhuriSettings,
  })
  return runWithContext(ctx, fn)
}

describe('provider registry', () => {
  beforeEach(() => {
    loaded.calls.length = 0
  })

  it('loads provider packages lazily, only when a model of that provider is resolved', async () => {
    expect(loaded).toMatchObject({ anthropic: 0, openai: 0, workers: 0 })
    const m: any = await withSettings({ PROVIDERS: { anthropic: { apiKey: 'sk-ant' } } }, {}, () =>
      resolveModel('anthropic:claude-sonnet-4-5'),
    )
    expect(m).toMatchObject({ provider: 'anthropic', modelId: 'claude-sonnet-4-5' })
    expect(m.opts).toEqual({ apiKey: 'sk-ant' })
    expect(loaded).toMatchObject({ anthropic: 1, openai: 0, workers: 0 })
  })

  it('reads API keys from env when PROVIDERS has none', async () => {
    const m: any = await withSettings({}, { OPENAI_API_KEY: 'sk-env' }, () =>
      resolveModel('openai:gpt-5-mini'),
    )
    expect(m).toMatchObject({ provider: 'openai', modelId: 'gpt-5-mini', opts: { apiKey: 'sk-env' } })
    const extra: any = await withSettings(
      { PROVIDERS: { openai: { apiKey: 'sk-set', baseURL: 'https://proxy.example/v1' } } },
      { OPENAI_API_KEY: 'sk-env' },
      () => resolveModel('openai:gpt-5'),
    )
    expect(extra.opts).toEqual({ apiKey: 'sk-set', baseURL: 'https://proxy.example/v1' })
  })

  it('resolves workers-ai models with the AI binding (AGENTS.AI_BINDING)', async () => {
    const binding = { run: vi.fn() }
    const m: any = await withSettings({}, { AI: binding }, () =>
      resolveModel('workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
    )
    expect(m).toMatchObject({ provider: 'workers-ai', modelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' })
    expect(m.opts.binding).toBe(binding)
    const custom: any = await withSettings(
      { AI_BINDING: 'MY_AI', PROVIDERS: { 'workers-ai': { gateway: { id: 'gw' } } } },
      { MY_AI: binding },
      () => resolveModel('workers-ai:@cf/qwen/qwen3'),
    )
    expect(custom.opts).toEqual({ gateway: { id: 'gw' }, binding })
    await expect(withSettings({}, {}, () => resolveModel('workers-ai:@cf/x'))).rejects.toThrow(
      /Workers AI binding 'AI' not found/,
    )
  })

  it('uses AGENTS.DEFAULT_MODEL, passes model instances through and reports bad strings', async () => {
    const instance = scriptedModel([])
    expect(await resolveModel(instance)).toBe(instance)
    const viaDefault: any = await withSettings({ DEFAULT_MODEL: 'anthropic:claude-haiku-4-5' }, {}, () =>
      resolveModel(undefined),
    )
    expect(viaDefault.modelId).toBe('claude-haiku-4-5')
    await expect(withSettings({}, {}, () => resolveModel(undefined))).rejects.toBeInstanceOf(
      ModelResolutionError,
    )
    await expect(resolveModel('gpt-4')).rejects.toThrow(/must be '<provider>:<model-id>'/)
    await expect(resolveModel('nope:x')).rejects.toThrow(/Unknown model provider 'nope'/)
  })

  it('accepts custom providers', async () => {
    registerProvider('mock', (id, { config }) => ({ ...scriptedModel([]), modelId: id, config }) as any)
    expect(getProviders()).toEqual(expect.arrayContaining(['workers-ai', 'anthropic', 'openai', 'mock']))
    const m: any = await withSettings({ PROVIDERS: { mock: { apiKey: 'k' } } }, {}, () =>
      resolveModel('mock:m1'),
    )
    expect(m.modelId).toBe('m1')
    expect(m.config).toEqual({ apiKey: 'k' })
    expect(unregisterProvider('mock')).toBe(true)
  })
})

describe('Workers safety', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      return statSync(p).isDirectory() ? files(p) : [p]
    })
  }

  it('never imports provider packages or Node built-ins statically', () => {
    const src = join(import.meta.dirname, '../src')
    for (const file of files(src)) {
      const code = readFileSync(file, 'utf8')
      expect(code, file).not.toMatch(/^import [^;]*from '(workers-ai-provider|@ai-sdk\/[^']+)'/m)
      expect(code, file).not.toMatch(/from 'node:/)
    }
  })
})
