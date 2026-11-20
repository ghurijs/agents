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
  return {
    createOpenAI: (opts: unknown) =>
      Object.assign((id: string) => fakeModel('openai', id, opts), {
        chat: (id: string) => fakeModel('openai.chat', id, opts),
      }),
  }
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

describe('provider run info and headers', () => {
  beforeEach(() => {
    loaded.calls.length = 0
  })

  it('passes static headers through and calls a headers function with the run', async () => {
    const seen: any[] = []
    registerProvider('spy', (id, ctx) => {
      seen.push(ctx)
      return scriptedModel([[{ type: 'text', text: id }]])
    })
    try {
      const user = { pk: 7, isAuthenticated: true } as any
      await withSettings(
        {
          PROVIDERS: {
            spy: {
              baseURL: 'https://gw.example/v1',
              headers: (ctx: any) => ({
                'x-agent': ctx.run?.agent ?? '-',
                'x-user': String(ctx.run?.user.pk),
              }),
            },
          },
        },
        {},
        () => resolveModel('spy:m', undefined, { agent: 'support', user, carried: { tenant: '42' } }),
      )
      expect(seen[0].run).toEqual({ agent: 'support', user, carried: { tenant: '42' } })
      expect(seen[0].config).toEqual({
        baseURL: 'https://gw.example/v1',
        headers: { 'x-agent': 'support', 'x-user': '7' },
      })
      // Outside a run there is no run info; a headers function still gets called.
      await withSettings({ PROVIDERS: { spy: { headers: () => ({ a: '1' }) } } }, {}, () =>
        resolveModel('spy:m'),
      )
      expect(seen[1].run).toBeUndefined()
      expect(seen[1].config.headers).toEqual({ a: '1' })
    } finally {
      unregisterProvider('spy')
    }
  })

  it('built-in providers receive the computed headers', async () => {
    const m: any = await withSettings(
      { PROVIDERS: { openai: { apiKey: 'k', headers: () => ({ 'x-ghuri-agent': 'a' }) } } },
      {},
      () => resolveModel('openai:gpt-5'),
    )
    expect(m.opts).toEqual({ apiKey: 'k', headers: { 'x-ghuri-agent': 'a' } })
  })

  it('agent runs resolve their model with the agent name and user', async () => {
    const seen: any[] = []
    registerProvider('spy', (_id, ctx) => {
      seen.push(ctx.run)
      return scriptedModel([[{ type: 'text', text: 'hi' }]])
    })
    try {
      const { Agent } = await import('../src/index')
      class Helper extends Agent {
        static override agentName = 'helper'
        override model = 'spy:m'
        override memory = false as const
        override permissionClasses = []
      }
      await withSettings({}, {}, () => new Helper().run('hello'))
      expect(seen[0]).toMatchObject({ agent: 'helper', carried: {} })
      expect(seen[0].user.isAuthenticated).toBe(false)
    } finally {
      unregisterProvider('spy')
    }
  })
})

describe('ghuri-ai provider', () => {
  const user = { pk: 7, isAuthenticated: true } as any
  const run = { agent: 'support', user, carried: { tenant: '42' } }

  it('needs the gateway URL', async () => {
    await expect(withSettings({}, {}, () => resolveModel('ghuri-ai:smart'))).rejects.toThrow(/GHURI_AI_URL/)
  })

  it('sends aliases to the OpenAI-compatible endpoint with attribution headers', async () => {
    const m: any = await withSettings(
      {},
      { GHURI_AI_URL: 'https://ai.example/', GHURI_AI_API_KEY: 'gk' },
      () => resolveModel('ghuri-ai:smart', undefined, run),
    )
    expect(m).toMatchObject({ provider: 'openai.chat', modelId: 'smart' })
    expect(m.opts).toEqual({
      baseURL: 'https://ai.example/v1',
      apiKey: 'gk',
      headers: { 'x-ghuri-agent': 'support', 'x-ghuri-user': '7', 'x-ghuri-tenant': '42' },
    })
  })

  it('routes anthropic/ and openai/ models to the pass-through endpoints', async () => {
    const settings = { PROVIDERS: { 'ghuri-ai': { baseURL: 'https://ai.example', apiKey: 'gk' } } }
    const a: any = await withSettings(settings, {}, () =>
      resolveModel('ghuri-ai:anthropic/claude-haiku-5-5', undefined, run),
    )
    expect(a).toMatchObject({ provider: 'anthropic', modelId: 'claude-haiku-5-5' })
    expect(a.opts.baseURL).toBe('https://ai.example/v1/anthropic')
    expect(a.opts.headers['x-ghuri-tenant']).toBe('42')
    const o: any = await withSettings(settings, {}, () => resolveModel('ghuri-ai:openai/gpt-5-mini'))
    expect(o).toMatchObject({ provider: 'openai', modelId: 'gpt-5-mini' })
    expect(o.opts).toEqual({ baseURL: 'https://ai.example/v1/openai', apiKey: 'gk', headers: {} })
  })

  it('leaves out the user header for anonymous runs; configured headers win', async () => {
    const m: any = await withSettings(
      {
        PROVIDERS: {
          'ghuri-ai': { baseURL: 'https://ai.example', headers: { 'x-ghuri-agent': 'override' } },
        },
      },
      {},
      () =>
        resolveModel('ghuri-ai:fast', undefined, {
          agent: 'a',
          user: { pk: null, isAuthenticated: false } as any,
        }),
    )
    expect(m.opts.headers).toEqual({ 'x-ghuri-agent': 'override' })
  })
})
