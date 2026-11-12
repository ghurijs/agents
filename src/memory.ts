import { apps, type RequestUser } from '@ghuri/core'
import type { ModelMessage } from 'ai'
import { ToolError } from './errors'
import { Conversation, Message } from './models'

/** The conversation does not exist, belongs to another agent, or is not owned by the user. */
export class ConversationNotFound extends ToolError {
  constructor(message: string) {
    super(message, { status: 404 })
  }
}

/** Is conversation memory available (the `agents` app installed)? */
export function memoryAvailable(): boolean {
  try {
    return apps.ready && apps.isInstalled('agents')
  } catch {
    return false
  }
}

/** `user.pk` for authenticated users, otherwise null (anonymous conversations have no owner). */
export function ownerPk(user: RequestUser | null | undefined): unknown {
  return user?.isAuthenticated ? user.pk : null
}

/** Is `user` the owner of `conversation`? (Anonymous conversations are owned by anonymous users.) */
export function isOwner(conversation: Conversation, user: RequestUser | null | undefined): boolean {
  const owner = conversation.userId ?? null
  const pk = ownerPk(user)
  if (owner === null || pk === null) return owner === null && pk === null
  return String(owner) === String(pk)
}

/** A user's conversation with `agent`, or `ConversationNotFound`. */
export async function getConversation(
  agent: string,
  id: string,
  user: RequestUser | null | undefined,
): Promise<Conversation> {
  let conv: Conversation | null = null
  try {
    conv = await Conversation.objects.filter({ id: String(id), agent }).first()
  } catch {
    conv = null
  }
  if (!conv || !isOwner(conv, user)) throw new ConversationNotFound(`Conversation '${id}' not found.`)
  return conv
}

/** Start a conversation owned by `user`. */
export async function createConversation(
  agent: string,
  user: RequestUser | null | undefined,
  opts: { title?: string; metadata?: Record<string, unknown> } = {},
): Promise<Conversation> {
  const pk = ownerPk(user)
  return Conversation.objects.create({
    agent,
    title: (opts.title ?? '').slice(0, 200),
    metadata: opts.metadata ?? {},
    ...(pk !== null ? { userId: pk } : {}),
  } as any)
}

/** The stored messages of a conversation, as AI SDK model messages (oldest first). */
export async function loadMessages(conversation: Conversation | string): Promise<ModelMessage[]> {
  const id = typeof conversation === 'string' ? conversation : String(conversation.pk)
  const rows = await Message.objects.filter({ conversation: id }).orderBy('id')
  return rows.map((r: any) => ({ role: r.role, content: r.content }) as ModelMessage)
}

/** JSON-safe copy of a message's content (binary file data is base64-encoded). */
function jsonContent(content: unknown): unknown {
  return JSON.parse(
    JSON.stringify(content, (_k, v) => {
      if (v instanceof Uint8Array) {
        let s = ''
        for (const b of v) s += String.fromCharCode(b)
        return btoa(s)
      }
      if (v instanceof URL) return v.toString()
      return v
    }),
  )
}

/** Append messages to a conversation and touch its `updatedAt`. */
export async function saveMessages(conversation: Conversation, messages: ModelMessage[]): Promise<void> {
  if (!messages.length) return
  await Message.objects.bulkCreate(
    messages.map(
      (m) =>
        new Message({
          conversationId: String(conversation.pk),
          role: m.role,
          content: jsonContent(m.content),
        } as any),
    ),
  )
  await conversation.save({ updateFields: ['updatedAt'] })
}

/** A short title from the first user message. */
export function titleFrom(input: string | ModelMessage[]): string {
  let text = ''
  if (typeof input === 'string') text = input
  else {
    const first = input.find((m) => m.role === 'user')
    const c = first?.content
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) text = c.map((p: any) => (p.type === 'text' ? p.text : '')).join(' ')
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}
