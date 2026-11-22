// @ghuri/agents/admin — import from your project's admin module to see token usage and run traces in the admin:
//   import '@ghuri/agents/admin'
import { ModelAdmin, site } from '@ghuri/admin'
import type { Context } from 'hono'
import { Run, Usage } from './models'

/**
 * Token usage per subject and window (read-only). Deleting a row resets that subject's count for the window.
 */
export class UsageAdmin extends ModelAdmin<Usage> {
  override listDisplay = ['scope', 'key', 'period', 'start', 'totalTokens', 'runs', 'updatedAt']
  override listFilter = ['scope', 'period']
  override searchFields = ['key']
  override dateHierarchy = 'start'
  override readonlyFields = [
    'scope',
    'key',
    'period',
    'start',
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'totalTokens',
    'runs',
    'updatedAt',
  ]

  override async hasAddPermission(_c: Context): Promise<boolean> {
    return false
  }
}

/** Run traces (`AGENTS.TRACE_RUNS`), read-only. */
export class RunAdmin extends ModelAdmin<Run> {
  override listDisplay = [
    'agent',
    'model',
    'status',
    'inputTokens',
    'outputTokens',
    'steps',
    'durationMs',
    'createdAt',
  ]
  override listFilter = ['status', 'agent', 'model']
  override searchFields = ['agent', 'model', 'error']
  override dateHierarchy = 'createdAt'
  override readonlyFields = [
    'agent',
    'model',
    'conversation',
    'user',
    'status',
    'finishReason',
    'steps',
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'usage',
    'toolCalls',
    'messages',
    'context',
    'error',
    'durationMs',
    'createdAt',
  ]

  override async hasAddPermission(_c: Context): Promise<boolean> {
    return false
  }
}

site.register(Usage, UsageAdmin)
site.register(Run, RunAdmin)
