import { type GhuriContext, HttpError, runWithContext, tryGetContext, ValidationError } from '@ghuri/core'
import { APIException } from '@ghuri/rest'
import { ToolError } from '../errors'
import type { AgentTool, ToolContext } from './types'

/** Run `fn` inside `ctx` (tools may run from stream callbacks outside the request's async context). */
export function inContext<T>(ctx: GhuriContext | undefined, fn: () => T): T {
  if (!ctx || tryGetContext() === ctx) return fn()
  return runWithContext(ctx, fn)
}

function isDebug(): boolean {
  return !!tryGetContext()?.settings.DEBUG
}

/**
 * Normalize anything thrown by a tool into a `ToolError` the model / MCP client may see. Expected failures
 * (permission denied, not found, validation) keep their message; unexpected errors are reported generically
 * unless `DEBUG` is on (the real error is logged).
 */
export function toToolError(err: unknown, toolName?: string): ToolError {
  if (err instanceof ToolError) return err
  if (err instanceof APIException) {
    return new ToolError(`${err.message || 'Request failed.'} (HTTP ${err.statusCode})`, {
      status: err.statusCode,
      cause: err,
    })
  }
  if (err instanceof HttpError) {
    return new ToolError(`${err.message} (HTTP ${(err as any).status})`, {
      status: (err as any).status,
      cause: err,
    })
  }
  if (err instanceof ValidationError) {
    const detail = (err as any).messageDict ?? (err as any).messages
    return new ToolError(`Validation failed: ${JSON.stringify(detail ?? err.message)}`, {
      status: 400,
      detail,
      cause: err,
    })
  }
  if (err instanceof Error && err.name === 'AbortError') return new ToolError('Aborted.', { cause: err })
  console.error(`[ghuri.agents] tool ${toolName ?? ''} failed:`, err)
  const message = isDebug() && err instanceof Error ? err.message : 'The tool failed with an internal error.'
  return new ToolError(message, { status: 500, cause: err })
}

/** Validate arguments and run a tool, normalizing errors (used by agents and the MCP server). */
export async function runTool(tool: AgentTool, args: unknown, ctx: ToolContext): Promise<unknown> {
  try {
    const input = tool.parse ? tool.parse(args) : (args ?? {})
    return await tool.execute(input, ctx)
  } catch (err) {
    throw toToolError(err, tool.name)
  }
}
