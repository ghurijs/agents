import { GhuriError } from '@ghuri/core'

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
