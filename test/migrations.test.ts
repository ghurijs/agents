// The shipped migrations match the models (no pending changes) and apply on every backend.
import { apps } from '@ghuri/core'
import { connections } from '@ghuri/orm'
import { MigrationLoader, makeMigrations, showMigrations } from '@ghuri/orm/migrations'
import { describe, expect, it } from 'vitest'
import { AgentsConfig, Conversation, Message } from '../src/index'
import { makeUser, useHarness } from './helpers'

describe('agents migrations', () => {
  const h = useHarness()

  it('ships 0001_initial with Conversation and Message, depending on auth', async () => {
    const loader = await MigrationLoader.load({ connection: null })
    const m = loader.getMigration('agents', '0001_initial')
    expect(m.dependencies).toEqual([['auth', '0001_initial']])
    expect(m.operations.map((o) => o.describe())).toEqual([
      'Create model Conversation',
      'Create model Message',
    ])
    expect(apps.getAppConfig('agents')).toBeInstanceOf(AgentsConfig)
  })

  it('has no changes missing from the migrations', async () => {
    const res = await makeMigrations({ appLabels: ['agents'], check: true, write: false })
    expect(res.migrations.map((g) => g.migration.operations.map((o) => o.describe()))).toEqual([])
  })

  it('is applied by the test database and the tables work', async () => {
    const status = await showMigrations({ appLabels: ['agents'], connection: await connections.get() })
    expect(status.map((s) => [s.app, s.name, s.applied])).toEqual([['agents', '0001_initial', true]])
    const user = await makeUser('migrated')
    const conv = await Conversation.objects.create({ agent: 'support', user } as any)
    await Message.objects.create({ conversation: conv, role: 'user', content: 'hi' } as any)
    expect(await Message.objects.filter({ conversation__agent: 'support' }).count()).toBe(1)
    expect(h.db.using).toBe('sqlite')
  })
})
