// The shipped migrations match the models (no pending changes) and apply on every backend.
import { apps } from '@ghuri/core'
import { connections } from '@ghuri/orm'
import { MigrationLoader, makeMigrations, showMigrations } from '@ghuri/orm/migrations'
import { describe, expect, it } from 'vitest'
import {
  AbstractConversation,
  AgentsConfig,
  Conversation,
  conversationFields,
  getConversationModel,
  Message,
  Run,
} from '../src/index'
import { makeUser, useHarness } from './helpers'

describe('agents migrations', () => {
  const h = useHarness()

  it('ships 0001_initial with Conversation and Message, depending on auth', async () => {
    const loader = await MigrationLoader.load({ connection: null })
    const m = loader.getMigration('agents', '0001_initial')
    // swappableDependency('AUTH_USER_MODEL') → the migration creating auth.User; the conversation one is ours
    expect([...(loader.graph.parents.get('agents.0001_initial') ?? [])]).toEqual(['auth.0001_initial'])
    expect(m.operations.map((o) => o.describe())).toEqual([
      'Create model Conversation',
      'Create model Message',
    ])
    expect(apps.getAppConfig('agents')).toBeInstanceOf(AgentsConfig)
  })

  it('ships 0002_run with the Run trace table, after 0001', async () => {
    const loader = await MigrationLoader.load({ connection: null })
    const m = loader.getMigration('agents', '0002_run')
    expect([...(loader.graph.parents.get('agents.0002_run') ?? [])].sort()).toEqual([
      'agents.0001_initial',
      'auth.0001_initial',
    ])
    expect(m.operations.map((o) => o.describe())).toEqual(['Create model Run'])
  })

  it('has no changes missing from the migrations', async () => {
    const res = await makeMigrations({ appLabels: ['agents'], check: true, write: false })
    expect(res.migrations.map((g) => g.migration.operations.map((o) => o.describe()))).toEqual([])
  })

  it('is applied by the test database and the tables work', async () => {
    const status = await showMigrations({ appLabels: ['agents'], connection: await connections.get() })
    expect(status.map((s) => [s.app, s.name, s.applied])).toEqual([
      ['agents', '0001_initial', true],
      ['agents', '0002_run', true],
    ])
    const user = await makeUser('migrated')
    const conv = await Conversation.objects.create({ agent: 'support', user } as any)
    await Message.objects.create({ conversation: conv, role: 'user', content: 'hi' } as any)
    expect(await Message.objects.filter({ conversation__agent: 'support' }).count()).toBe(1)
    expect(h.db.using).toBe('sqlite')
  })

  it('Conversation is swappable (AGENTS.CONVERSATION_MODEL) and not swapped by default', () => {
    expect(Conversation._meta.swappable).toBe('AGENTS.CONVERSATION_MODEL')
    expect(Conversation._meta.swapped).toBeUndefined()
    expect(getConversationModel()).toBe(Conversation)
    expect(Message._meta.getForwardField('conversation')!.relatedModel).toBe(Conversation)
    expect(Run._meta.getForwardField('conversation')!.relatedModel).toBe(Conversation)
    expect(AbstractConversation._meta.abstract).toBe(true)
    expect(Object.keys(conversationFields)).toEqual(Conversation._meta.localFields.map((f) => f.name))
  })
})
