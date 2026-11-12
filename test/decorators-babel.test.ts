// Regression: legacy decorators as compiled by Babel with decorator metadata (jiti — the `ghuri` CLI's
// TypeScript loader) pass the class prototype in place of the property descriptor.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { TOOL, tool } from '../src/tools/tool'

function applyBabelLegacy(proto: any, key: string, decorators: Array<(...a: any[]) => any>): void {
  const metadata = (t: unknown) => t
  const desc = Object.getOwnPropertyDescriptor(proto, key)!
  const result = [...decorators, metadata, metadata]
    .slice()
    .reverse()
    .reduce((d: any, dec) => dec(proto, key, d) || d, { ...desc })
  Object.defineProperty(proto, key, result)
}

describe('@tool compiled by Babel (legacy + metadata)', () => {
  it('marks the method and keeps it callable', () => {
    class A {
      async refund({ orderId }: { orderId: number }) {
        return { orderId }
      }
    }
    const before = A.prototype.refund
    applyBabelLegacy(A.prototype, 'refund', [
      tool({ description: 'Refund an order', input: z.object({ orderId: z.number() }) }),
    ])
    expect(A.prototype.refund).toBe(before)
    expect((A.prototype.refund as any)[TOOL]).toMatchObject({
      name: 'refund',
      description: 'Refund an order',
    })
  })
})
