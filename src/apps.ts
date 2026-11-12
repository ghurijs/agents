import { AppConfig, tryGetContext } from '@ghuri/core'
import { Migration, migrationsFromModule } from '@ghuri/orm/migrations'
import * as agentsMigrations from './migrations/index'
import { Conversation, Message } from './models'

/**
 * The agents migrations, adapted to `AUTH_USER_MODEL`: `Conversation.user` points at the custom user model
 * and the migration depends on its app instead of `auth` (Django's `swappable_dependency`).
 */
function migrationsForUserModel(): Record<string, unknown> {
  const label = tryGetContext()?.settings.AUTH_USER_MODEL as string | undefined
  if (!label || label.toLowerCase() === 'auth.user') return agentsMigrations
  const userApp = label.split('.')[0]
  const out: Record<string, Migration> = {}
  for (const [name, m] of migrationsFromModule(agentsMigrations) ?? []) {
    const operations = m.operations.map((op: any) => {
      if (!op.fields) return op
      const fields = Object.fromEntries(
        Object.entries(op.fields as Record<string, any>).map(([k, f]) => {
          const to = f?.options?.to ?? f?.to
          if (typeof to !== 'string' || to.toLowerCase() !== 'auth.user') return [k, f]
          return [k, f.options ? { ...f, options: { ...f.options, to: label } } : { ...f, to: label }]
        }),
      )
      return Object.assign(Object.create(Object.getPrototypeOf(op)), op, { fields })
    })
    const dependencies = m.dependencies.filter((d) => d[0] !== 'auth')
    if (!dependencies.some((d) => d[0] === userApp)) dependencies.push([userApp, '__first__'] as const)
    const adapted = new Migration({ dependencies, operations, initial: m.initial })
    adapted.name = m.name || name
    out[adapted.name] = adapted
  }
  return { migrations: out }
}

/** `path` when running from the TypeScript sources (makemigrations), undefined in dist / on Workers. */
function appPath(): string | undefined {
  const meta = import.meta as ImportMeta & { dirname?: string; filename?: string }
  if (!meta.dirname || !/[\\/]src$/.test(meta.dirname) || !/\.[cm]?ts$/.test(meta.filename ?? ''))
    return undefined
  return meta.dirname
}

/**
 * The `agents` app: conversation memory (`Conversation`, `Message`) and its migrations. Add it to
 * `INSTALLED_APPS` (after your user model's app) and run `ghuri migrate` to have agents load and save
 * conversations automatically.
 */
export class AgentsConfig extends AppConfig {
  name = '@ghuri/agents'
  override label = 'agents'
  override verboseName = 'Agents'
  override path = appPath()
  override migrations = migrationsForUserModel()
  override models = { Conversation, Message }
}
