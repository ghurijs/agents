import { GhuriError } from '@ghuri/core'
import type { UsagePeriod } from './models'
import type { UsageSubject } from './usage'

/** Base class of `@ghuri/agents` errors. */
export class AgentError extends GhuriError {}

/**
 * A tool failed in a way the model should see (permission denied, validation error, not found…). Thrown from a
 * tool's `execute`, it becomes a tool error for the model (the run continues) and `isError: true` over MCP.
 */
export class ToolError extends AgentError {
  /** HTTP-like status (403, 400, 404…) when the error came from a view. */
  status?: number
  /** Structured details (DRF error body, validation errors…). */
  detail?: unknown

  constructor(message: string, opts: { status?: number; detail?: unknown; cause?: unknown } = {}) {
    super(message, { cause: opts.cause })
    this.status = opts.status
    this.detail = opts.detail
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    }
  }
}

/** Tool input did not match the tool's schema. */
export class ToolInputError extends ToolError {
  constructor(message: string, detail?: unknown) {
    super(message, { status: 400, detail })
  }
}

/** A tool name that no agent / MCP server exposes. */
export class UnknownToolError extends AgentError {}

/** A `'provider:model'` string could not be resolved. */
export class ModelResolutionError extends AgentError {}

/**
 * A run was refused because a subject (the user, the tenant or the anonymous client) used its token budget for the
 * period (`AGENTS.USAGE_LIMITS`). The chat view answers `429` with `Retry-After: wait`; MCP returns a tool error.
 */
export class UsageLimitExceeded extends AgentError {
  /** Who is over the limit. */
  readonly subject: UsageSubject
  readonly period: UsagePeriod
  /** The limit in tokens. */
  readonly limit: number
  /** Tokens used in the window so far. */
  readonly used: number
  /** When the window ends (UTC). */
  readonly resetsAt: Date
  /** Seconds until `resetsAt`. */
  readonly wait: number

  constructor(opts: {
    subject: UsageSubject
    period: UsagePeriod
    limit: number
    used: number
    resetsAt: Date
    wait: number
  }) {
    super(
      `Token usage limit reached for ${opts.subject.scope} ${opts.subject.key}: ${opts.used} of ${opts.limit} tokens this ${opts.period}. Resets at ${opts.resetsAt.toISOString()}.`,
    )
    this.subject = opts.subject
    this.period = opts.period
    this.limit = opts.limit
    this.used = opts.used
    this.resetsAt = opts.resetsAt
    this.wait = opts.wait
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      scope: this.subject.scope,
      period: this.period,
      limit: this.limit,
      used: this.used,
      resetsAt: this.resetsAt.toISOString(),
      retryAfter: this.wait,
    }
  }
}
