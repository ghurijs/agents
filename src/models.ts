import {
  CASCADE,
  CharField,
  DateField,
  DateTimeField,
  ForeignKey,
  getSwappableModel,
  JSONField,
  type Manager,
  Model,
  type ModelClass,
  PositiveBigIntegerField,
  PositiveIntegerField,
  SET_NULL,
  TextField,
  UUIDField,
} from '@ghuri/orm'

/** The (swappable) user model: `AUTH_USER_MODEL`, default `auth.User`. Resolved lazily. */
function userModel(): ModelClass {
  return getSwappableModel('AUTH_USER_MODEL', 'auth.User')
}

/** Default of `AGENTS.CONVERSATION_MODEL`. */
export const DEFAULT_CONVERSATION_MODEL = 'agents.Conversation'

/**
 * The active conversation model (`AGENTS.CONVERSATION_MODEL`, default `agents.Conversation`). Use it instead of
 * importing `Conversation` in code that should follow a swapped model.
 */
export function getConversationModel(): ConversationModelClass {
  return getSwappableModel('AGENTS.CONVERSATION_MODEL', DEFAULT_CONVERSATION_MODEL) as ConversationModelClass
}

function newConversationId(): string {
  return crypto.randomUUID()
}

function emptyMetadata(): Record<string, unknown> {
  return {}
}

function newRunId(): string {
  return crypto.randomUUID()
}

function emptyList(): unknown[] {
  return []
}

/**
 * The fields of a conversation, for a project's own conversation model (`AGENTS.CONVERSATION_MODEL`):
 *
 * ```ts
 * export class Conversation extends StoreModel({ ...conversationFields }) {
 *   static Meta = { ordering: ['-updatedAt'] }
 * }
 * ```
 */
export const conversationFields = {
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
}

/** Abstract base with `conversationFields` (Django's abstract models): `class Conversation extends AbstractConversation`. */
export class AbstractConversation extends Model(conversationFields) {
  static Meta = { abstract: true, ordering: ['-updatedAt'], verboseName: 'conversation' }

  toString(): string {
    return this.title || String(this.id)
  }
}

/** What agents need from a conversation model: `conversationFields` and a manager. */
export type ConversationModelClass = ModelClass<AbstractConversation> & {
  objects: Manager<AbstractConversation>
}

/**
 * A chat thread between a user and one agent (table `agents_conversation`). Swappable: set
 * `AGENTS.CONVERSATION_MODEL` to use your own model (e.g. a tenant-scoped one) instead.
 */
export class Conversation extends Model(conversationFields) {
  declare static objects: Manager<Conversation>
  static Meta = {
    appLabel: 'agents',
    ordering: ['-updatedAt'],
    verboseName: 'conversation',
    swappable: 'AGENTS.CONVERSATION_MODEL',
  }

  toString(): string {
    return this.title || String(this.id)
  }
}

/** Relation target of `Message` / `Run`: the active conversation model, typed as the default one. */
const conversationModel = getConversationModel as unknown as () => typeof Conversation

/** Roles stored in `Message.role` (AI SDK model message roles). */
export const MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const
export type MessageRole = (typeof MESSAGE_ROLES)[number]

/**
 * One AI SDK model message of a conversation (table `agents_message`). `content` is the message content as
 * JSON: a string, or parts (text, tool calls with their inputs, tool results / errors).
 */
export class Message extends Model({
  conversation: new ForeignKey(conversationModel, { onDelete: CASCADE, relatedName: 'messages' }),
  role: new CharField({ maxLength: 20, choices: MESSAGE_ROLES.map((r) => [r, r] as [string, string]) }),
  content: new JSONField({ null: true }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
}) {
  declare static objects: Manager<Message>
  declare conversationId: string
  static Meta = { appLabel: 'agents', ordering: ['id'], verboseName: 'message' }
}

/** `Run.status` values. */
export const RUN_STATUSES = ['ok', 'error'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/**
 * One agent run (table `agents_run`): the model, token usage, tool calls, outcome and timing. Written only when
 * `AGENTS.TRACE_RUNS` is on; the base for usage reports, evals and comparing models.
 */
export class Run extends Model({
  id: new UUIDField({ primaryKey: true, default: newRunId, editable: false }),
  agent: new CharField({ maxLength: 100, dbIndex: true }),
  /** `'<provider>:<model-id>'` as the agent named it. */
  model: new CharField({ maxLength: 200, blank: true, default: '' }),
  conversation: new ForeignKey(conversationModel, {
    null: true,
    blank: true,
    onDelete: SET_NULL,
    relatedName: 'runs',
  }),
  user: new ForeignKey(userModel, { null: true, blank: true, onDelete: SET_NULL, relatedName: 'agentRuns' }),
  status: new CharField({ maxLength: 10, choices: RUN_STATUSES.map((r) => [r, r] as [string, string]) }),
  finishReason: new CharField({ maxLength: 30, blank: true, default: '' }),
  steps: new PositiveIntegerField({ default: 0 }),
  inputTokens: new PositiveIntegerField({ null: true, blank: true }),
  outputTokens: new PositiveIntegerField({ null: true, blank: true }),
  cachedInputTokens: new PositiveIntegerField({ null: true, blank: true }),
  /** The AI SDK usage object as reported by the provider. */
  usage: new JSONField({ null: true, blank: true }),
  /** `[{ toolName, input, error? }]` (outputs are left out; they can be large). */
  toolCalls: new JSONField({ default: emptyList, blank: true }),
  /** The run's messages (input and response), with `AGENTS.TRACE_RUNS: { messages: true }` only. */
  messages: new JSONField({ null: true, blank: true }),
  /** Carried request context (`{ tenant: '42' }`). */
  context: new JSONField({ default: emptyMetadata, blank: true }),
  error: new TextField({ blank: true, default: '' }),
  durationMs: new PositiveIntegerField({ null: true, blank: true }),
  createdAt: new DateTimeField({ autoNowAdd: true, dbIndex: true }),
}) {
  declare static objects: Manager<Run>
  static Meta = { appLabel: 'agents', ordering: ['-createdAt'], verboseName: 'run' }

  toString(): string {
    return `${this.agent} ${this.status} (${String(this.id)})`
  }
}

/** `Usage.scope` values: who a run counts against. */
export const USAGE_SCOPES = ['user', 'tenant', 'anon'] as const
export type UsageScope = (typeof USAGE_SCOPES)[number]

/** `Usage.period` values: the windows tokens are counted in (UTC). */
export const USAGE_PERIODS = ['day', 'month'] as const
export type UsagePeriod = (typeof USAGE_PERIODS)[number]

/**
 * Token usage of one subject (a user, a tenant or an anonymous client) in one window (a UTC day or month), table
 * `agents_usage`. Written after every run while `AGENTS.USAGE_LIMITS` is set and read before every run to enforce
 * the limits; `getUsage()` reports it.
 */
export class Usage extends Model({
  scope: new CharField({ maxLength: 10, choices: USAGE_SCOPES.map((s) => [s, s] as [string, string]) }),
  /** The user pk, the tenant pk or the anonymous client's address (`'*'`: anonymous runs without a request). */
  key: new CharField({ maxLength: 100 }),
  period: new CharField({ maxLength: 10, choices: USAGE_PERIODS.map((p) => [p, p] as [string, string]) }),
  /** First day of the window (UTC): the day itself, or the first of the month. */
  start: new DateField(),
  inputTokens: new PositiveBigIntegerField({ default: 0 }),
  outputTokens: new PositiveBigIntegerField({ default: 0 }),
  cachedInputTokens: new PositiveBigIntegerField({ default: 0 }),
  /** What limits are compared to: the runs' total tokens (input + output). */
  totalTokens: new PositiveBigIntegerField({ default: 0 }),
  runs: new PositiveIntegerField({ default: 0 }),
  updatedAt: new DateTimeField({ autoNow: true }),
}) {
  declare static objects: Manager<Usage>
  static Meta = {
    appLabel: 'agents',
    ordering: ['-start', 'scope', 'key'],
    verboseName: 'usage',
    verboseNamePlural: 'usage',
    uniqueTogether: [['scope', 'key', 'period', 'start']],
  }

  toString(): string {
    return `${this.scope} ${this.key} ${this.period} ${this.start}`
  }
}
