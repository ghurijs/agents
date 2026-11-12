import type { RequestUser } from '@ghuri/core'
import type { APIRequest } from '@ghuri/rest'

/** A JSON Schema object (draft 2020-12). */
export type JSONSchema = Record<string, unknown>

/** Who and what a tool runs for. Every tool executes as `user`. */
export interface ToolContext {
  /** The requesting user (tools never escalate beyond this user's permissions). */
  user: RequestUser
  /** The agent running the tool (absent for direct MCP calls). */
  agent?: unknown
  conversationId?: string
  toolCallId?: string
  signal?: AbortSignal
  /** The REST request of the HTTP chat / MCP call, when there is one. */
  request?: APIRequest
}

/** MCP tool annotations (hints for clients; also useful for UIs). */
export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/**
 * A normalized tool, the common currency of agents (AI SDK tools) and the MCP server. `ModelTools`,
 * `ViewSetTools`, `RouterTools`, `tool()` and `@tool` methods all produce these.
 */
export interface AgentTool {
  /** Sanitized name (`posts_list`), unique within an agent / MCP server. */
  name: string
  description: string
  /** JSON Schema of the arguments (always `type: 'object'`). */
  inputSchema: JSONSchema
  /** JSON Schema of the result, when known. */
  outputSchema?: JSONSchema
  annotations?: ToolAnnotations
  /** Validate / coerce raw arguments; throws `ToolInputError`. Defaults to accepting any object. */
  parse?(input: unknown): unknown
  /** Run the tool. Throw `ToolError` for failures the model should see. */
  execute(input: any, ctx: ToolContext): unknown
}

/** A collection of tools (`ModelTools`, `ViewSetTools`, `RouterTools`, or your own). */
export abstract class Toolkit {
  abstract getTools(): AgentTool[]
}

export function isToolkit(value: unknown): value is Toolkit {
  return !!value && typeof (value as Toolkit).getTools === 'function'
}

export function isAgentTool(value: unknown): value is AgentTool {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as AgentTool).name === 'string' &&
    typeof (value as AgentTool).execute === 'function' &&
    typeof (value as AgentTool).inputSchema === 'object'
  )
}
