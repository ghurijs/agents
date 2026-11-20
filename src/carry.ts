import * as core from '@ghuri/core'

// Context carriers (`captureContext` / `restoreContext`) arrived in a later @ghuri/core alpha. Reading them off the
// namespace keeps @ghuri/agents working with older core releases, where nothing is carried.

/** The current context's carried values (`{ tenant: '42' }`), or `{}`. */
export function captureCarried(): Record<string, string> {
  const capture = (core as any).captureContext as (() => Record<string, string>) | undefined
  return capture ? capture() : {}
}

/** Run `fn` with carried values active again (as is when there are none or core cannot restore them). */
export function restoreCarried<R>(
  carried: Record<string, string> | null | undefined,
  fn: () => Promise<R>,
): Promise<R> {
  const restore = (core as any).restoreContext as
    | ((c: Record<string, string> | null | undefined, f: () => Promise<R>) => Promise<R>)
    | undefined
  return restore ? restore(carried, fn) : fn()
}
