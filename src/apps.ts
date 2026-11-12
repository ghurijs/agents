import { AppConfig } from '@ghuri/core'
import { Conversation, Message } from './models'

/**
 * The `agents` app: conversation memory (`Conversation`, `Message`). Add it to `INSTALLED_APPS` (after your
 * user model's app) to have agents load and save conversations automatically.
 */
export class AgentsConfig extends AppConfig {
  name = '@ghuri/agents'
  override label = 'agents'
  override verboseName = 'Agents'
  override models = { Conversation, Message }
}
