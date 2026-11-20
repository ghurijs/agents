import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  answerMatches,
  calledTool,
  check,
  costOf,
  defineEval,
  formatEvalReport,
  judge,
  maxSteps,
  noToolErrors,
  notCalledTool,
  parseVerdict,
  runEval,
} from '../src/evals/index'
import { Agent, Conversation, ModelTools } from '../src/index'
import { backends, makeUser, useHarness } from './helpers'
import { scriptedModel } from './mock'
import { Order } from './models'

/** A model that answers every prompt by calling `orders_list` once, then saying how many orders there are. */
function ordersModel(id: string, opts: { skipTool?: boolean } = {}) {
  const m = scriptedModel(
    opts.skipTool
      ? [[{ type: 'text', text: 'You have no orders, I think.' }]]
      : [
          [{ type: 'tool-call', toolName: 'orders_list', input: { search: 'A-1' } }],
          (prompt) => {
            const tool = prompt.filter((p: any) => p.role === 'tool').at(-1)
            const count = tool?.content?.[0]?.output?.value?.count ?? '?'
            return [{ type: 'text', text: `You have ${count} order(s).` }]
          },
        ],
  ) as any
  m.modelId = id
  return m
}

function judgeModel(verdict: string) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'judge',
    doGenerate: async () =>
      ({
        content: [{ type: 'text', text: verdict }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }) as any,
  })
}

describe('eval helpers', () => {
  it('parses judge verdicts leniently', () => {
    expect(parseVerdict('Sure: {"pass": true, "reason": "ok"}')).toEqual({ pass: true, reason: 'ok' })
    expect(parseVerdict('{"pass": "yes"}')).toBeUndefined()
    expect(parseVerdict('no json')).toBeUndefined()
  })

  it('prices tokens per million, with cache reads at their own price', () => {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 }
    expect(costOf(usage, { input: 1, output: 5, cachedInput: 0.1 })).toBeCloseTo(0.6 + 0.04 + 0.5)
    expect(costOf(usage, { input: 1, output: 5 })).toBeCloseTo(1 + 0.5)
    expect(costOf(usage)).toBeNull()
  })
})

for (const using of backends) {
  describe(`runEval (${using})`, () => {
    const h = useHarness(() => ({ using }))
    afterEach(() => {
      ;(h.ctx.settings as any).AGENTS = undefined
      vi.unstubAllEnvs()
    })

    class Orders extends Agent {
      static override agentName = 'orders'
      override model = ordersModel('default')
      override tools = [new ModelTools(Order, { filter: (qs, user) => qs.filter({ customer: user.pk }) })]
    }

    function suite(models: any[]) {
      return defineEval({
        name: 'orders',
        agent: Orders,
        models,
        judgeModel: judgeModel('{"pass": true, "reason": "states the count"}'),
        prices: { 'mock:good': { input: 1, output: 2 } },
        async setup() {
          const alice = await makeUser('alice')
          await Order.objects.create({ number: 'A-1', customer: alice, total: '1.00' } as any)
          return { user: alice }
        },
        cases: [
          {
            name: 'counts orders',
            input: 'How many orders do I have?',
            checks: [
              calledTool('orders_list', { search: /A-/ }),
              notCalledTool('orders_delete'),
              noToolErrors(),
              answerMatches('1 order'),
              maxSteps(3),
              check('order still there', async () => (await Order.objects.count()) === 1),
              judge('Tells the user how many orders they have.'),
            ],
          },
        ],
      })
    }

    it('compares models: pass rate, tokens, cost and failures', async () => {
      const report = await runEval(suite([ordersModel('good'), ordersModel('lazy', { skipTool: true })]), {
        beforeEach: () => h.db.flush(),
      })
      expect(report.suite).toBe('orders')
      const good = report.byModel['mock:good']
      expect(good).toMatchObject({ passed: 1, total: 1, passRate: 1, inputTokens: 20, outputTokens: 10 })
      expect(good.cost).toBeCloseTo((20 * 1 + 10 * 2) / 1_000_000)
      expect(good.costPerPass).toBe(good.cost)
      const lazy = report.byModel['mock:lazy']
      expect(lazy).toMatchObject({ passed: 0, total: 1, passRate: 0, cost: null, costPerPass: null })
      const failed = report.attempts.find((a) => a.model === 'mock:lazy')!
      expect(failed.failures.map((f) => f.check)).toEqual([
        'calledTool(orders_list)',
        'answerMatches(1 order)',
      ])
      expect(failed.failures[0].reason).toBe('not called (tools called: none)')
      const text = formatEvalReport(report)
      expect(text).toContain('mock:good')
      expect(text).toContain('100%')
      expect(text).toContain('Failures:')
      expect(text).toContain('[mock:lazy] counts orders')
      // Eval runs keep no conversations.
      expect(await Conversation.objects.count()).toBe(0)
    })

    it('repeats runs and reads GHURI_EVAL_REPEAT / GHURI_EVAL_CASE', async () => {
      const seen: string[] = []
      const r = await runEval(suite([ordersModel('good')]), {
        repeat: 2,
        beforeEach: () => h.db.flush(),
        onAttempt: (a) => seen.push(`${a.case}#${a.attempt}`),
      })
      expect(seen).toEqual(['counts orders#1', 'counts orders#2'])
      expect(r.byModel['mock:good'].total).toBe(2)
      vi.stubEnv('GHURI_EVAL_REPEAT', '3')
      vi.stubEnv('GHURI_EVAL_CASE', 'nothing matches')
      const none = await runEval(suite([ordersModel('good')]), { beforeEach: () => h.db.flush() })
      expect(none.attempts).toEqual([])
    })

    it('reports a failing judge and a failed run without throwing', async () => {
      const s = suite([
        ordersModel('good'),
        new MockLanguageModelV4({
          provider: 'mock',
          modelId: 'down',
          doGenerate: async () => {
            throw new Error('provider down')
          },
        }),
      ])
      s.judgeModel = judgeModel('{"pass": false, "reason": "never gives a number"}')
      const report = await runEval(s, { beforeEach: () => h.db.flush() })
      const good = report.attempts.find((a) => a.model === 'mock:good')!
      expect(good.pass).toBe(false)
      expect(good.failures).toEqual([
        { check: 'judge(Tells the user how many orders they have.)', reason: 'never gives a number' },
      ])
      const down = report.attempts.find((a) => a.model === 'mock:down')!
      expect(down).toMatchObject({ pass: false, error: 'provider down', steps: 0 })
      expect(down.failures).toEqual([{ check: 'run', reason: 'provider down' }])
    })

    it('uses the agent model by default and string models through the registry', async () => {
      const r = await runEval(defineEval({ ...suite([]), models: undefined }), {
        beforeEach: () => h.db.flush(),
      })
      expect(Object.keys(r.byModel)).toEqual(['mock:default'])
    })
  })
}
