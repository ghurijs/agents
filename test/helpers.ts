import {
  AuthConfig,
  AuthenticationMiddleware,
  AuthTokenConfig,
  ContentType,
  ContentTypesConfig,
  PBKDF2PasswordHasher,
  SessionMiddleware,
  SessionsConfig,
  Token,
  User,
} from '@ghuri/auth'
import { createApp, defineSettings, type Env, type GhuriSettings, type UrlPatterns } from '@ghuri/core'
import { createTestClient } from '@ghuri/core/testing'
import {
  createTablesForModels,
  setTestSchemaCreator,
  setupTestDatabase,
  type TestBackend,
} from '@ghuri/orm/testing'
import { APIClient } from '@ghuri/rest/testing'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { AgentsConfig } from '../src/index'
import { ShopConfig } from './models'

export const FAST_HASHERS = [new PBKDF2PasswordHasher({ iterations: 1000 })]

export const backends: TestBackend[] = (process.env.GHURI_TEST_BACKENDS?.split(',') as
  | TestBackend[]
  | undefined) ?? ['sqlite', 'pglite']

export interface HarnessOptions {
  using?: TestBackend
  urls?: () => UrlPatterns
  settings?: Partial<GhuriSettings>
}

export async function setupHarness(opts: HarnessOptions = {}) {
  const env: Env = {}
  const settings = defineSettings(() => ({
    SECRET_KEY: 'test-secret',
    INSTALLED_APPS: [
      ContentTypesConfig,
      AuthConfig,
      SessionsConfig,
      AuthTokenConfig,
      ShopConfig,
      AgentsConfig,
    ],
    MIDDLEWARE: [SessionMiddleware, AuthenticationMiddleware],
    ROOT_URLCONF: opts.urls?.() ?? [],
    PASSWORD_HASHERS: FAST_HASHERS,
    ...opts.settings,
  }))
  const app = createApp(settings, { checks: false } as any)
  const ctx = await app.setup(env)
  // Create every table straight from the models: the auth app ships migrations, and unmigrated test apps
  // (shop, agents — whose migrations are generated later) reference its user model.
  setTestSchemaCreator(createTablesForModels)
  const db = await setupTestDatabase({ using: opts.using ?? 'sqlite' })
  setTestSchemaCreator(undefined)
  const client = createTestClient(app, { env })
  const api = new APIClient(client, { defaultFormat: 'json' })
  return { app, env, ctx, db, client, api }
}

export type Harness = Awaited<ReturnType<typeof setupHarness>>

/** Per-describe harness, flushed before each test. */
export function useHarness(factory: () => HarnessOptions = () => ({})): Harness {
  const h = {} as Harness
  beforeAll(async () => {
    Object.assign(h, await setupHarness(factory()))
  }, 60_000)
  afterAll(async () => {
    await h.db?.teardown()
  })
  beforeEach(async () => {
    await h.db.flush()
    ContentType.objects.clearCache()
    h.client.clearCookies()
    h.api.forceAuthenticate(null)
    h.api.credentials()
  })
  return h
}

export async function makeUser(username: string, extra: Record<string, unknown> = {}): Promise<any> {
  const u: any = await User.objects.createUser(username, `${username}@example.com`, `pw-${username}`)
  if (Object.keys(extra).length) {
    Object.assign(u, extra)
    await u.save()
  }
  return u
}

export async function tokenFor(user: any): Promise<string> {
  const t: any = await Token.objects.create({ user } as any)
  return t.key
}
