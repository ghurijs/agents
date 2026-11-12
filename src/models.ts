import { apps, tryGetContext } from '@ghuri/core'
import {
  CASCADE,
  CharField,
  DateTimeField,
  ForeignKey,
  JSONField,
  type Manager,
  Model,
  type ModelClass,
  UUIDField,
} from '@ghuri/orm'

/** The (swappable) user model: `AUTH_USER_MODEL`, default `auth.User`. Resolved lazily. */
function userModel(): ModelClass {
  const label = (tryGetContext()?.settings.AUTH_USER_MODEL as string | undefined) ?? 'auth.User'
  return apps.getModel(label) as ModelClass
}

function newConversationId(): string {
  return crypto.randomUUID()
}

function emptyMetadata(): Record<string, unknown> {
  return {}
}

/** A chat thread between a user and one agent (table `agents_conversation`). */
export class Conversation extends Model({
  id: new UUIDField({ primaryKey: true, default: newConversationId, editable: false }),
  user: new ForeignKey(userModel, {
    null: true,
    blank: true,
    onDelete: CASCADE,
    relatedName: 'agentConversations',
  }),
  agent: new CharField({ maxLength: 100, dbIndex: true }),
  title: new CharField({ maxLength: 200, blank: true, default: '' }),
  metadata: new JSONField({ default: emptyMetadata, blank: true }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
  updatedAt: new DateTimeField({ autoNow: true }),
}) {
  declare static objects: Manager<Conversation>
  static Meta = { appLabel: 'agents', ordering: ['-updatedAt'], verboseName: 'conversation' }

  toString(): string {
    return this.title || String(this.id)
  }
}

/** Roles stored in `Message.role` (AI SDK model message roles). */
export const MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const
export type MessageRole = (typeof MESSAGE_ROLES)[number]

/**
 * One AI SDK model message of a conversation (table `agents_message`). `content` is the message content as
 * JSON: a string, or parts (text, tool calls with their inputs, tool results / errors).
 */
export class Message extends Model({
  conversation: new ForeignKey(() => Conversation, { onDelete: CASCADE, relatedName: 'messages' }),
  role: new CharField({ maxLength: 20, choices: MESSAGE_ROLES.map((r) => [r, r] as [string, string]) }),
  content: new JSONField({ null: true }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
}) {
  declare static objects: Manager<Message>
  declare conversationId: string
  static Meta = { appLabel: 'agents', ordering: ['id'], verboseName: 'message' }
}
