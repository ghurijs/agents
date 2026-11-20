// Tool shaping: what a model sees of a tool (description with examples), how its arguments are checked before
// it runs, and how much of its result goes back. Smaller models do much better with tight schemas, clear errors
// they can correct, and short results.

import type { AgentTool, JSONSchema } from './types'

// ---------------------------------------------------------------------------------------------------------------
// Descriptions

/** Most examples shown per tool. */
export const MAX_TOOL_EXAMPLES = 3

/** The tool's description as models see it: its `description`, then up to three `Example input:` lines. */
export function describeTool(tool: Pick<AgentTool, 'description' | 'examples'>): string {
  const examples = (tool.examples ?? []).slice(0, MAX_TOOL_EXAMPLES)
  if (!examples.length) return tool.description
  const lines = examples.map((e) => `Example input: ${JSON.stringify(e)}`)
  return `${tool.description}\n\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------------------------------------------
// Argument checks

function typesOf(schema: JSONSchema): string[] {
  const t = schema.type
  const list = Array.isArray(t) ? (t as string[]) : typeof t === 'string' ? [t] : []
  if (schema.nullable === true && !list.includes('null')) list.push('null')
  return list
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean' || value === 'true' || value === 'false'
    case 'integer':
      return (
        (typeof value === 'number' && Number.isInteger(value)) ||
        (typeof value === 'string' && /^-?\d+$/.test(value.trim()))
      )
    case 'number':
      return (
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
      )
    case 'array':
      return Array.isArray(value)
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value)
    default:
      return true
  }
}

function enumValues(schema: JSONSchema): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum as unknown[]
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key]
    if (Array.isArray(options) && options.every((o: any) => o && 'const' in o)) {
      return options.map((o: any) => o.const)
    }
  }
  return undefined
}

function fmt(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * Check arguments against the top level of a tool's JSON Schema: unknown arguments, missing required ones, values
 * outside an `enum` and wrong types (numeric strings count as numbers, `"true"` / `"false"` as booleans). Returns
 * the problems, empty when the arguments are fine. Nested objects are left to the tool's own validation.
 */
export function checkToolInput(schema: JSONSchema, input: unknown): string[] {
  if (input === undefined || input === null) input = {}
  if (typeof input !== 'object' || Array.isArray(input)) return ['arguments must be a JSON object']
  const args = input as Record<string, unknown>
  const props = (schema.properties ?? undefined) as Record<string, JSONSchema> | undefined
  const problems: string[] = []
  const allowed = props ? Object.keys(props) : []
  if (props && schema.additionalProperties !== true && typeof schema.additionalProperties !== 'object') {
    for (const key of Object.keys(args)) {
      if (!(key in props)) {
        problems.push(
          `unknown argument '${key}' (${allowed.length ? `allowed: ${allowed.join(', ')}` : 'this tool takes no arguments'})`,
        )
      }
    }
  }
  for (const key of (schema.required as string[] | undefined) ?? []) {
    if (args[key] === undefined) problems.push(`missing required argument '${key}'`)
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = props?.[key]
    if (!prop || value === undefined) continue
    const types = typesOf(prop)
    if (value === null) {
      if (types.length && !types.includes('null')) problems.push(`'${key}' must not be null`)
      continue
    }
    const values = enumValues(prop)
    if (values && !values.some((v) => v === value || String(v) === String(value))) {
      problems.push(`'${key}' must be one of ${values.map(fmt).join(', ')} (got ${fmt(value)})`)
      continue
    }
    if (types.length && !types.some((t) => matchesType(value, t))) {
      problems.push(`'${key}' must be ${types.filter((t) => t !== 'null').join(' or ')} (got ${fmt(value)})`)
    }
  }
  return problems
}

// ---------------------------------------------------------------------------------------------------------------
// Results

/** Fields to keep in results: for every action, or per action name with `'*'` as the fallback. */
export type ResultFields = string[] | Record<string, string[]>

export interface ResultShape {
  /** Keep only these top-level fields of each object (each row of a list). */
  fields?: string[]
  /** Leave out `null`, empty strings and empty arrays / objects, at every level. */
  compact?: boolean
}

/** The fields of one action from a `ResultFields` option. */
export function resultFieldsFor(fields: ResultFields | undefined, ...names: string[]): string[] | undefined {
  if (!fields) return undefined
  if (Array.isArray(fields)) return fields
  for (const n of names) if (fields[n]) return fields[n]
  return fields['*']
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
}

function pick(obj: unknown, fields: string[]): unknown {
  if (!isPlainObject(obj)) return obj
  const out: Record<string, unknown> = {}
  for (const f of fields) if (f in obj) out[f] = obj[f]
  return out
}

function isEmpty(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (isPlainObject(v) && Object.keys(v).length === 0)
  )
}

/** Drop `null`, `''`, `[]` and `{}` values recursively (`0` and `false` are kept). */
export function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactValue)
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    const c = compactValue(v)
    if (!isEmpty(c)) out[k] = c
  }
  return out
}

/**
 * Shape a tool result: `fields` keeps only those fields of the object, of each item of an array, or of each row in
 * `results` of a paginated list (`{ count, next, previous, results }` keeps its paging keys); `compact` then drops
 * empty values.
 */
export function shapeResult(data: unknown, shape: ResultShape): unknown {
  let out = data
  const fields = shape.fields
  if (fields?.length) {
    if (Array.isArray(out)) out = out.map((r) => pick(r, fields))
    else if (isPlainObject(out) && Array.isArray(out.results)) {
      out = { ...out, results: out.results.map((r) => pick(r, fields)) }
    } else out = pick(out, fields)
  }
  return shape.compact ? compactValue(out) : out
}
