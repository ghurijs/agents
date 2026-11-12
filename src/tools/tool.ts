import { ImproperlyConfigured } from '@ghuri/core'
import type { z } from 'zod'
import { makeParser, sanitizeToolName, toJSONSchema } from './schema'
import type { AgentTool, JSONSchema, ToolAnnotations, ToolContext } from './types'

/** Marker on methods decorated with `@tool`. */
export const TOOL: unique symbol = Symbol.for('ghuri.agents.tool') as any
/** Options carried by the decorator returned from `tool()` (for `static tools = {...}` and standalone tools). */
export const TOOL_OPTIONS: unique symbol = Symbol.for('ghuri.agents.toolOptions') as any

type InputOf<S> = S extends z.ZodType ? z.output<S> : Record<string, any>

export interface ToolOptions<S = z.ZodType | JSONSchema | undefined> {
  /** Tool name (default: the method / key name). Sanitized to `[A-Za-z0-9_-]{1,64}`. */
  name?: string
  /** What the tool does — the model reads this to decide when to call it. */
  description: string
  /** Arguments: a Zod object schema (validated) or a JSON Schema object. Omit for no arguments. */
  input?: S
  /** JSON Schema of the result (advertised over MCP as `outputSchema`). */
  output?: JSONSchema
  annotations?: ToolAnnotations
  /** Standalone tools: the implementation (methods decorated with `@tool` don't need it). */
  execute?: (input: InputOf<S>, ctx: ToolContext) => unknown
}

/** A `tool()` result: a TC39 / legacy method decorator that also carries its options. */
export interface ToolDecorator<S = any> {
  (value: any, context?: any, descriptor?: PropertyDescriptor): any
  readonly [TOOL_OPTIONS]: ToolOptions<S>
}

function mark(fn: any, name: string, opts: ToolOptions): void {
  if (typeof fn !== 'function') throw new TypeError('@tool() can only decorate methods.')
  fn[TOOL] = { ...opts, name: opts.name ?? name }
}

/**
 * Declare a tool. Three forms:
 *
 * ```ts
 * class SupportAgent extends Agent {
 *   // 1. decorator (standard TC39 decorators)
 *   @tool({ description: 'Refund an order', input: z.object({ orderId: z.number() }) })
 *   async refund({ orderId }, ctx) { ... }
 *
 *   // 2. without decorators: options in a static map, implementation in the method of the same name
 *   static tools = { refund: tool({ description: 'Refund an order', input: z.object({ orderId: z.number() }) }) }
 *
 *   // 3. standalone, with `execute`
 *   tools = [tool({ name: 'now', description: 'Current time', execute: () => new Date().toISOString() })]
 * }
 * ```
 */
export function tool<S extends z.ZodType | JSONSchema | undefined = undefined>(
  opts: ToolOptions<S>,
): ToolDecorator<S> {
  if (!opts || typeof opts.description !== 'string')
    throw new TypeError('tool() requires a `description` string.')
  const decorator = ((value: any, context?: any, descriptor?: PropertyDescriptor) => {
    if (descriptor && typeof descriptor.value === 'function') {
      mark(descriptor.value, String(context), opts as ToolOptions)
      return descriptor
    }
    if (typeof value === 'function') {
      const name =
        context && typeof context === 'object' && 'name' in context ? String(context.name) : value.name
      mark(value, name, opts as ToolOptions)
      return value
    }
    throw new TypeError('@tool() can only decorate methods.')
  }) as ToolDecorator<S>
  Object.defineProperty(decorator, TOOL_OPTIONS, { value: opts })
  return decorator
}

export function isToolDecorator(value: unknown): value is ToolDecorator {
  return typeof value === 'function' && TOOL_OPTIONS in value
}

/** Build a normalized `AgentTool` from options and an implementation. */
export function defineTool(
  name: string,
  opts: ToolOptions<any>,
  execute: (input: any, ctx: ToolContext) => unknown,
): AgentTool {
  return {
    name: sanitizeToolName(opts.name ?? name),
    description: opts.description,
    inputSchema: toJSONSchema(opts.input),
    ...(opts.output ? { outputSchema: opts.output } : {}),
    ...(opts.annotations ? { annotations: opts.annotations } : {}),
    parse: makeParser(opts.input),
    execute,
  }
}

/** A standalone `tool({ ..., execute })` → `AgentTool` (`key` names tools declared in a map). */
export function standaloneTool(decorator: ToolDecorator, key?: string): AgentTool {
  const opts = decorator[TOOL_OPTIONS]
  if (typeof opts.execute !== 'function') {
    throw new ImproperlyConfigured(
      `tool('${opts.name ?? key ?? opts.description}') has no \`execute\`: use it as a method decorator or pass execute.`,
    )
  }
  const name = opts.name ?? key
  if (!name) throw new ImproperlyConfigured(`A standalone tool needs a \`name\` (${opts.description}).`)
  return defineTool(name, opts, opts.execute)
}

/**
 * Tools declared on a class: `@tool` methods and `static tools = { name: tool({...}) }` entries, bound to
 * `instance` (methods receive `(input, ctx)` with `this` = the instance).
 */
export function collectDeclaredTools(instance: object): AgentTool[] {
  const cls = instance.constructor as any
  const found = new Map<string, AgentTool>()
  const chain: any[] = []
  for (let p = Object.getPrototypeOf(instance); p && p !== Object.prototype; p = Object.getPrototypeOf(p))
    chain.unshift(p)
  for (const proto of chain) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue
      const fn = Object.getOwnPropertyDescriptor(proto, key)?.value
      if (typeof fn === 'function' && fn[TOOL]) {
        const opts = fn[TOOL] as ToolOptions
        found.set(
          key,
          defineTool(opts.name ?? key, opts, (input, ctx) => (instance as any)[key](input, ctx)),
        )
      }
    }
  }
  const staticChain: any[] = []
  for (let c = cls; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) staticChain.unshift(c)
  for (const c of staticChain) {
    if (!Object.hasOwn(c, 'tools') || !c.tools || typeof c.tools !== 'object' || Array.isArray(c.tools))
      continue
    for (const [key, spec] of Object.entries(c.tools as Record<string, any>)) {
      const opts: ToolOptions | undefined = isToolDecorator(spec)
        ? spec[TOOL_OPTIONS]
        : spec && typeof spec === 'object' && typeof spec.description === 'string'
          ? spec
          : undefined
      if (!opts) continue
      if (typeof opts.execute === 'function') {
        found.set(key, defineTool(opts.name ?? key, opts, opts.execute))
        continue
      }
      if (typeof (instance as any)[key] !== 'function') {
        throw new ImproperlyConfigured(`${c.name}.tools.${key}: the class has no method named '${key}'.`)
      }
      found.set(
        key,
        defineTool(opts.name ?? key, opts, (input, ctx) => (instance as any)[key](input, ctx)),
      )
    }
  }
  return [...found.values()]
}
