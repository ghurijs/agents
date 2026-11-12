import { z } from 'zod'
import { ToolInputError } from '../errors'
import type { JSONSchema } from './types'

/** Make `name` a valid LLM / MCP tool name: `[A-Za-z0-9_-]{1,64}`. */
export function sanitizeToolName(name: string): string {
  const s = name
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return (s || 'tool').slice(0, 64)
}

/** `partialUpdate` → `partial_update`. */
export function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

/** Is `value` a Zod (v4) schema? */
export function isZodSchema(value: unknown): value is z.ZodType {
  return (
    !!value &&
    typeof value === 'object' &&
    '_zod' in (value as object) &&
    typeof (value as z.ZodType).safeParse === 'function'
  )
}

/** JSON Schema of a tool input given as a Zod schema, a JSON Schema object or nothing (no arguments). */
export function toJSONSchema(input: unknown): JSONSchema {
  if (input === undefined || input === null) return { type: 'object', properties: {} }
  if (isZodSchema(input)) {
    const schema = z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }) as JSONSchema
    delete schema.$schema
    return schema
  }
  if (typeof input === 'object') return { ...(input as JSONSchema) }
  throw new TypeError('Tool input must be a Zod schema or a JSON Schema object.')
}

/** A parser for tool arguments: Zod schemas validate and coerce; JSON Schemas only require an object. */
export function makeParser(input: unknown): (value: unknown) => unknown {
  if (isZodSchema(input)) {
    return (value: unknown) => {
      const res = input.safeParse(value ?? {})
      if (!res.success) {
        const issues = res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
        const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')
        throw new ToolInputError(`Invalid arguments: ${summary}`, issues)
      }
      return res.data
    }
  }
  return (value: unknown) => {
    if (value === undefined || value === null) return {}
    if (typeof value !== 'object' || Array.isArray(value))
      throw new ToolInputError('Tool arguments must be a JSON object.')
    return value
  }
}

/** Remove `readOnly` properties and output-only keywords so a serializer schema is usable as tool input. */
export function cleanInputSchema(schema: JSONSchema | undefined): JSONSchema {
  if (!schema) return { type: 'object', properties: {} }
  const { title: _t, ...rest } = schema
  return { ...rest, type: 'object', properties: { ...((schema.properties as object) ?? {}) } }
}

/** OpenAPI parameter objects (`{ name, schema, description, required }`) → JSON Schema properties. */
export function parametersToProperties(params: Array<Record<string, unknown>>): {
  properties: Record<string, JSONSchema>
  required: string[]
} {
  const properties: Record<string, JSONSchema> = {}
  const required: string[] = []
  for (const p of params) {
    if (p.in && p.in !== 'query') continue
    const name = String(p.name)
    properties[name] = {
      ...((p.schema as JSONSchema) ?? { type: 'string' }),
      ...(p.description ? { description: String(p.description) } : {}),
    }
    if (p.required) required.push(name)
  }
  return { properties, required }
}
