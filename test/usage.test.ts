// Token usage limits (AGENTS.USAGE_LIMITS): counted per subject and window, checked before every run.
import { AsyncLocalStorage } from 'node:async_hooks'
import { SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'
import { include, path, registerContextCarrier, taskHandlers, unregisterContextCarrier } from '@ghuri/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Agent,
  AgentRouter,
  Conversation,
  getUsage,
  McpServer,
  recordUsage,
  Usage,
  UsageLimitExceeded,
  type UsageLimitReachedArgs,
  type UsageRecordedArgs,
  type UsageSubject,
  usageLimitReached,
  usageRecorded,
  usageSubjects,
  usageTokens,
  usageWindow,
} from '../src/index'
import { backends, makeUser, tokenFor, useHarness } from './helpers'
import { scriptedModel } from './mock'

/** Every step of the mock model reports 10 input + 5 output tokens: one plain answer counts 15. */
const PER_RUN = 15

let calls = 0
class Helper extends Agent {
  override model = scriptedModel(
    Array.from({ length: 50 }, () => () => {
      calls++
      return [{ type: 'text' as const, text: 'ok' }]
    }),
  )
  override permissionClasses = []
}

const router = new AgentRouter().register('helper', Helper)
const urls = () => [path('agents/', include(router.urls))]

const tenant = new AsyncLocalStorage<string>()
const tenantCarrier = {
  name: 'tenant',
  capture: () => tenant.getStore(),
  restore: (v: string, fn: () => Promise<unknown>) => tenant.run(v, fn),
}

for (const using of backends) {
  describe(`usage limits (${using})`, () => {
    const h = useHarness(() => ({
      using,
      urls,
      settings: { AGENTS: { AUTHENTICATION_CLASSES: [TokenAuthentication, SessionAuthentication] } },
    }))

    function limits(value: unknown) {
      ;(h.ctx.settings as any).AGENTS = {
        AUTHENTICATION_CLASSES: [TokenAuthentication, SessionAuthentication],
        ...(value === undefined ? {} : { USAGE_LIMITS: value }),
      }
    }

    afterEach(() => {
      limits(undefined)
      vi.useRealTimers()
      vi.restoreAllMocks()
      unregisterContextCarrier('tenant')
    })

    async function rows() {
      const all: any[] = await Usage.objects.orderBy('scope', 'key', 'period')
      return all.map((r) => [r.scope, r.key, r.period, Number(r.totalTokens), Number(r.runs)])
    }

    it('counts and checks nothing without USAGE_LIMITS', async () => {
      const alice = await makeUser('alice')
      await new Helper().run('hi', { user: alice })
      expect(await Usage.objects.count()).toBe(0)
      expect(await getUsage({ user: alice })).toEqual([])
      expect(usageSubjects(alice)).toEqual([])
    })

    it('counts every run per user, day and month, and reports it with getUsage()', async () => {
      limits({ user: { day: 1000, month: 5000 } })
      const alice = await makeUser('alice')
      await new Helper().run('one', { user: alice })
      await new Helper().run('two', { user: alice })
      expect(await rows()).toEqual([
        ['user', String(alice.pk), 'day', 2 * PER_RUN, 2],
        ['user', String(alice.pk), 'month', 2 * PER_RUN, 2],
      ])
      const usage = await getUsage({ user: alice })
      expect(usage.map((w) => [w.scope, w.period, w.used, w.limit, w.remaining, w.runs])).toEqual([
        ['user', 'day', 30, 1000, 970, 2],
        ['user', 'month', 30, 5000, 4970, 2],
      ])
      expect(usage[0]).toMatchObject({ inputTokens: 20, outputTokens: 10, cachedInputTokens: 0 })
    })

    it('refuses a run over the limit before the model or a conversation, until the window resets', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-23T23:00:00Z'))
      limits({ user: { day: 20 } })
      const reached: UsageLimitReachedArgs[] = []
      const receiver = async (a: UsageLimitReachedArgs) => void reached.push(a)
      usageLimitReached.connect(receiver)
      try {
        const alice = await makeUser('alice')
        await new Helper().run('one', { user: alice })
        await new Helper().run('two', { user: alice }) // 15 < 20: still allowed, now 30
        const before = { calls, conversations: await Conversation.objects.count() }
        const err = await new Helper().run('three', { user: alice }).catch((e) => e)
        expect(err).toBeInstanceOf(UsageLimitExceeded)
        expect(err).toMatchObject({ period: 'day', limit: 20, used: 30, wait: 3600 })
        expect(err.subject).toMatchObject({ scope: 'user', key: String(alice.pk) })
        expect(err.resetsAt.toISOString()).toBe('2026-11-24T00:00:00.000Z')
        expect(err.message).toBe(
          `Token usage limit reached for user ${alice.pk}: 30 of 20 tokens this day. Resets at 2026-11-24T00:00:00.000Z.`,
        )
        expect(calls).toBe(before.calls)
        expect(await Conversation.objects.count()).toBe(before.conversations)
        expect(reached).toHaveLength(1)
        expect(reached[0].error).toBe(err)
        await expect(new Helper().stream('three', { user: alice })).rejects.toBeInstanceOf(UsageLimitExceeded)

        vi.setSystemTime(new Date('2026-11-24T00:00:01Z'))
        expect((await new Helper().run('next day', { user: alice })).text).toBe('ok')
      } finally {
        usageLimitReached.disconnect(receiver)
      }
    })

    it('names the window that resets last when several are over', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-29T12:00:00Z'))
      limits({ user: { day: 10, month: 10 } })
      const alice = await makeUser('alice')
      await new Helper().run('one', { user: alice })
      const err = await new Helper().run('two', { user: alice }).catch((e) => e)
      expect(err).toMatchObject({ period: 'month', wait: 36 * 3600 })
      vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
      await new Helper().run('new month', { user: alice })
      expect(await rows()).toEqual([
        ['user', String(alice.pk), 'day', 15, 1],
        ['user', String(alice.pk), 'day', 15, 1],
        ['user', String(alice.pk), 'month', 15, 1],
        ['user', String(alice.pk), 'month', 15, 1],
      ])
    })

    it('usageWindow() is UTC days and months', () => {
      const at = new Date('2026-12-31T23:30:00-02:00') // 2027-01-01T01:30Z
      expect(usageWindow('day', at)).toEqual({
        start: '2027-01-01',
        resetsAt: new Date('2027-01-02T00:00:00Z'),
      })
      expect(usageWindow('month', at)).toEqual({
        start: '2027-01-01',
        resetsAt: new Date('2027-02-01T00:00:00Z'),
      })
    })

    it('counts the carried tenant too, with limits from a function (a billing plan)', async () => {
      registerContextCarrier(tenantCarrier as any)
      const plans: UsageSubject[] = []
      limits({
        user: { day: 1000 },
        tenant: async (s: UsageSubject) => {
          plans.push(s)
          return s.key === 'free' ? { month: 20 } : null
        },
      })
      const alice = await makeUser('alice')
      const bob = await makeUser('bob')
      await tenant.run('free', () => new Helper().run('one', { user: alice }))
      await tenant.run('free', () => new Helper().run('two', { user: bob }))
      const err = await tenant.run('free', () => new Helper().run('three', { user: alice })).catch((e) => e)
      expect(err).toBeInstanceOf(UsageLimitExceeded)
      expect(err.subject).toMatchObject({ scope: 'tenant', key: 'free' })
      expect(plans[0]).toMatchObject({ scope: 'tenant', key: 'free' })
      // A paid tenant (no limit) is still counted; runs without a tenant count only against the user.
      await tenant.run('paid', () => new Helper().run('four', { user: alice }))
      await new Helper().run('five', { user: alice })
      const tenantRows = (await rows()).filter((r) => r[0] === 'tenant' && r[2] === 'month')
      expect(tenantRows).toEqual([
        ['tenant', 'free', 'month', 30, 2],
        ['tenant', 'paid', 'month', 15, 1],
      ])
      const usage = await tenant.run('paid', () => getUsage({ user: alice }))
      expect(usage.map((w) => [w.scope, w.key, w.period, w.used, w.limit])).toEqual([
        ['user', String(alice.pk), 'day', 45, 1000],
        ['user', String(alice.pk), 'month', 45, null],
        ['tenant', 'paid', 'day', 15, null],
        ['tenant', 'paid', 'month', 15, null],
      ])
    })

    it('counts only the scopes named; one function covers every scope', async () => {
      registerContextCarrier(tenantCarrier as any)
      limits({ tenant: { day: 100 } })
      const alice = await makeUser('alice')
      await tenant.run('t1', () => new Helper().run('hi', { user: alice }))
      expect((await rows()).map((r) => r[0])).toEqual(['tenant', 'tenant'])
      await Usage.objects.all().delete()

      const seen: string[] = []
      limits((s: UsageSubject) => {
        seen.push(s.scope)
        return s.user.isAuthenticated ? null : { day: 1 }
      })
      await tenant.run('t1', () => new Helper().run('hi', { user: alice }))
      expect((await rows()).map((r) => r[0])).toEqual(['tenant', 'tenant', 'user', 'user'])
      expect(seen.sort()).toEqual(['tenant', 'user'])
    })

    it('counts anonymous runs per client address, or in one bucket without a request', async () => {
      limits({ anon: { day: 15 } })
      await new Helper().run('hi')
      expect(await rows()).toEqual([
        ['anon', '*', 'day', 15, 1],
        ['anon', '*', 'month', 15, 1],
      ])
      await expect(new Helper().run('again')).rejects.toBeInstanceOf(UsageLimitExceeded)
      const alice = await makeUser('alice')
      expect((await new Helper().run('users are not limited', { user: alice })).text).toBe('ok')
    })

    it('counts streamed runs when the stream ends', async () => {
      limits({ user: { day: 1000 } })
      const recorded: UsageRecordedArgs[] = []
      const receiver = async (a: UsageRecordedArgs) => void recorded.push(a)
      usageRecorded.connect(receiver)
      try {
        const alice = await makeUser('alice')
        const stream = await new Helper().stream('hi', { user: alice })
        for await (const _ of stream.textStream) {
          // drain
        }
        await stream.done
        expect((await rows())[0]).toEqual(['user', String(alice.pk), 'day', 15, 1])
        expect(recorded).toHaveLength(1)
        expect(recorded[0].tokens).toEqual({
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 0,
          totalTokens: 15,
        })
      } finally {
        usageRecorded.disconnect(receiver)
      }
    })

    it('concurrent runs lose no tokens (database increments)', async () => {
      limits({ user: {} })
      const alice = await makeUser('alice')
      const subjects = usageSubjects(alice)
      const agent = new Helper()
      const usage = { inputTokens: 7, outputTokens: 3, totalTokens: 10 } as any
      await Promise.all(Array.from({ length: 20 }, () => recordUsage(agent, alice, subjects, usage)))
      expect(await rows()).toEqual([
        ['user', String(alice.pk), 'day', 200, 20],
        ['user', String(alice.pk), 'month', 200, 20],
      ])
    })

    it('usageTokens() uses totalTokens, else input + output', () => {
      expect(usageTokens({ inputTokens: 4, outputTokens: 2 } as any).totalTokens).toBe(6)
      expect(
        usageTokens({
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 9,
          inputTokenDetails: { cacheReadTokens: 3 },
        } as any),
      ).toEqual({ inputTokens: 4, outputTokens: 2, cachedInputTokens: 3, totalTokens: 9 })
      expect(usageTokens(undefined).totalTokens).toBe(0)
    })

    it('never fails a run because of a counter write or a receiver', async () => {
      limits({ user: { day: 1000 } })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const bad = async () => {
        throw new Error('receiver bug')
      }
      usageRecorded.connect(bad)
      try {
        const alice = await makeUser('alice')
        expect((await new Helper().run('hi', { user: alice })).text).toBe('ok')
        expect(error).toHaveBeenCalled()
        vi.spyOn(Usage.objects, 'bulkCreate').mockRejectedValue(new Error('no such table: agents_usage'))
        expect((await new Helper().run('hi', { user: alice })).text).toBe('ok')
        expect(warn.mock.calls.length).toBeLessThanOrEqual(1)
      } finally {
        usageRecorded.disconnect(bad)
      }
    })

    it('chat view: 429 with Retry-After for JSON and SSE requests', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-23T22:00:00Z'))
      limits({ user: { day: 10 } })
      const alice = await makeUser('alice')
      h.api.credentials({ Authorization: `Token ${await tokenFor(alice)}` })
      const ok = await h.api.post('/agents/helper/chat/', { message: 'hi' })
      expect(ok.status).toBe(200)
      expect((await ok.json()).usage.totalTokens).toBe(15)

      const refused = await h.api.post('/agents/helper/chat/', { message: 'again' })
      expect(refused.status).toBe(429)
      expect(refused.headers.get('retry-after')).toBe('7200')
      expect(await refused.json()).toEqual({
        detail: 'Token usage limit reached for this day. Expected available in 7200 seconds.',
      })
      const conversations = await Conversation.objects.count()
      const sse = await h.api.post('/agents/helper/chat/?stream=1', { message: 'again' })
      expect(sse.status).toBe(429)
      expect(sse.headers.get('retry-after')).toBe('7200')
      expect(sse.headers.get('content-type')).toMatch(/json/)
      expect(await Conversation.objects.count()).toBe(conversations)
    })

    it('GET usage/ shows the requesting user their usage and limits', async () => {
      const alice = await makeUser('alice')
      h.api.credentials({ Authorization: `Token ${await tokenFor(alice)}` })
      expect(await (await h.api.get('/agents/usage/')).json()).toEqual({ results: [] })
      limits({ user: { month: 100 } })
      await new Helper().run('hi', { user: alice })
      const res = await h.api.get('/agents/usage/')
      expect(res.status).toBe(200)
      const [day, month] = (await res.json()).results
      expect(day).toMatchObject({ scope: 'user', period: 'day', used: 15, limit: null, remaining: null })
      expect(month).toMatchObject({ scope: 'user', period: 'month', used: 15, limit: 100, remaining: 85 })
      expect(typeof month.resetsAt).toBe('string')
      h.api.credentials()
      expect((await h.api.get('/agents/usage/')).status).toBe(401)
    })

    it('MCP ask_<agent>: an isError result with the reason and retryAfter', async () => {
      limits({ user: { day: 10 } })
      const alice = await makeUser('alice')
      const server = new McpServer({ agents: { helper: Helper } })
      const ok = await server.callTool('ask_helper', { message: 'hi' }, { user: alice })
      expect(ok.isError).toBe(false)
      const refused: any = await server.callTool('ask_helper', { message: 'again' }, { user: alice })
      expect(refused.isError).toBe(true)
      expect(refused.content[0].text).toMatch(
        /^Token usage limit reached for user \d+: 15 of 10 tokens this day\./,
      )
      expect(JSON.parse(refused.content[0].text.split('\n')[1])).toMatchObject({
        scope: 'user',
        period: 'day',
        limit: 10,
        used: 15,
        retryAfter: expect.any(Number),
      })
    })

    it('enqueue() (queue path) refuses up front; the consumer drops refused jobs instead of retrying', async () => {
      limits({ user: { day: 10 } })
      const alice = await makeUser('alice')
      const sent: any[] = []
      h.env.AGENTS_QUEUE = { send: async (body: unknown) => void sent.push(body) }
      ;(h.ctx.settings as any).AGENTS.QUEUE_BINDING = 'AGENTS_QUEUE'
      try {
        await router.create('helper').enqueue('first', { user: alice })
        await router.create('helper').enqueue('second', { user: alice }) // allowed: nothing counted yet
        expect(sent).toHaveLength(2)

        const stop = router.consumeQueue('agents-usage')
        try {
          const [handler] = taskHandlers.queuesFor('agents-usage')
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
          const msgs = sent.map((body, i) => ({
            id: String(i),
            timestamp: new Date(),
            body,
            ack: vi.fn(),
            retry: vi.fn(),
          }))
          await handler({ queue: 'agents-usage', messages: msgs, ackAll: vi.fn(), retryAll: vi.fn() }, h.ctx)
          expect(msgs.map((m) => [m.ack.mock.calls.length, m.retry.mock.calls.length])).toEqual([
            [1, 0],
            [1, 0],
          ])
          expect(warn).toHaveBeenCalledWith(expect.stringMatching(/refused: Token usage limit reached/))
        } finally {
          stop()
        }

        const conversations = await Conversation.objects.count()
        await expect(router.create('helper').enqueue('third', { user: alice })).rejects.toBeInstanceOf(
          UsageLimitExceeded,
        )
        expect(sent).toHaveLength(2)
        expect(await Conversation.objects.count()).toBe(conversations)
      } finally {
        delete h.env.AGENTS_QUEUE
      }
    })
  })
}

describe('@ghuri/agents/admin', () => {
  it('registers Usage and Run read-only', async () => {
    const { site } = await import('@ghuri/admin')
    const { RunAdmin, UsageAdmin } = await import('../src/admin')
    const { Run } = await import('../src/index')
    const get = (m: unknown) => (site as any).getModelAdmin?.(m) ?? (site as any)._registry?.get?.(m)
    expect(get(Usage)).toBeInstanceOf(UsageAdmin)
    expect(get(Run)).toBeInstanceOf(RunAdmin)
    expect(await get(Usage).hasAddPermission({} as any)).toBe(false)
  })
})
