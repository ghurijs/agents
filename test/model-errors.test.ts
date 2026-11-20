import { NotAuthenticated, NotFound, PermissionDenied, Throttled } from '@ghuri/rest'
import { APICallError, RetryError } from 'ai'
import { describe, expect, it } from 'vitest'
import { ModelUnavailable, modelCallError } from '../src/index'

function callError(statusCode: number, headers: Record<string, string> = {}) {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://gw.example/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
    isRetryable: statusCode === 429,
  })
}

describe('modelCallError()', () => {
  it('turns a 429 into Throttled with Retry-After seconds', () => {
    const err = modelCallError(callError(429, { 'retry-after': '30' }))
    expect(err).toBeInstanceOf(Throttled)
    expect((err as Throttled).wait).toBe(30)
    expect((err as Throttled).message).toContain('usage limit')
  })

  it('finds the 429 inside a RetryError (after the AI SDK gave up retrying)', () => {
    const last = callError(429)
    const err = modelCallError(
      new RetryError({
        message: 'Failed after 3 attempts',
        reason: 'maxRetriesExceeded',
        errors: [last, last],
      }),
    )
    expect(err).toBeInstanceOf(Throttled)
    expect((err as Throttled).wait).toBeNull()
  })

  it('turns bad keys and billing failures into ModelUnavailable', () => {
    for (const status of [401, 402, 403])
      expect(modelCallError(callError(status))).toBeInstanceOf(ModelUnavailable)
  })

  it('leaves other errors alone', () => {
    const server = callError(500)
    expect(modelCallError(server)).toBe(server)
    const other = new NotFound()
    expect(modelCallError(other)).toBe(other)
    for (const api of [new PermissionDenied(), new NotAuthenticated()]) expect(modelCallError(api)).toBe(api)
    const plain = new Error('x')
    expect(modelCallError(plain)).toBe(plain)
  })
})
