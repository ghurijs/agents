import { AppConfig } from '@ghuri/core'
import * as agentsMigrations from './migrations/index'
import { Conversation, Message, Run } from './models'

/** `path` when running from the TypeScript sources (makemigrations), undefined in dist / on Workers. */
function appPath(): string | undefined {
  const meta = import.meta as ImportMeta & { dirname?: string; filename?: string }
  if (!meta.dirname || !/[\\/]src$/.test(meta.dirname) || !/\.[cm]?ts$/.test(meta.filename ?? ''))
    return undefined
  return meta.dirname
}

/**
 * The `agents` app: conversation memory (`Conversation`, `Message`), run traces (`Run`) and their migrations.
 * `Conversation` is swappable with `AGENTS.CONVERSATION_MODEL`. Add it to
 * `INSTALLED_APPS` (after your user model's app) and run `ghuri migrate` to have agents load and save
 * conversations automatically.
 */
export class AgentsConfig extends AppConfig {
  name = '@ghuri/agents'
  override label = 'agents'
  override verboseName = 'Agents'
  override path = appPath()
  // Relations to the user and conversation models are written with `swappableModel()` /
  // `swappableDependency()`, so the same files follow `AUTH_USER_MODEL` and `AGENTS.CONVERSATION_MODEL`.
  override migrations = agentsMigrations
  override models = { Conversation, Message, Run }
}
