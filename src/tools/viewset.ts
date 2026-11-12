import { ImproperlyConfigured } from '@ghuri/core'
import { RouterRegistration, SimpleRouter } from '@ghuri/rest'
import { ToolError } from '../errors'
import { cleanInputSchema, parametersToProperties, sanitizeToolName, snakeCase } from './schema'
import { type AgentTool, type JSONSchema, type ToolAnnotations, type ToolContext, Toolkit } from './types'

/** Friendly aliases accepted in `actions` lists. */
const ACTION_ALIASES: Record<string, string> = {
  delete: 'destroy',
  partial_update: 'partialUpdate',
  'partial-update': 'partialUpdate',
}

const STANDARD = new Set(['list', 'create', 'retrieve', 'update', 'partialUpdate', 'destroy'])

export interface ViewSetToolsOptions {
  /** Actions to expose (`['list', 'retrieve', 'create', 'partialUpdate', 'destroy', 'publish']`; `'delete'` is an
   * alias of `'destroy'`). Default: every routed action of the viewset. */
  actions?: string[]
  /** Tool name prefix (default: the router prefix, or the model's plural name: `posts` → `posts_list`). */
  prefix?: string
  /** Router basename when a viewset class is given (default: derived from `queryset`). */
  basename?: string
  /** Override tool descriptions per action. */
  descriptions?: Record<string, string>
  /**
   * OAuth scopes for MCP: for every tool (`['posts:read']`), or per action (`{ list: ['posts:read'], create:
   * ['posts:write'], '*': ['posts'] }`; `'*'` applies to actions without an entry).
   */
  scopes?: ToolScopes
}

/** Scopes for every tool, or per action name with `'*'` as the fallback. */
export type ToolScopes = string[] | Record<string, string[]>

/** The scopes of one action from a `ToolScopes` option. */
export function scopesFor(scopes: ToolScopes | undefined, ...names: string[]): string[] | undefined {
  if (!scopes) return undefined
  if (Array.isArray(scopes)) return scopes
  for (const n of names) if (scopes[n]) return scopes[n]
  return scopes['*']
}

export interface ActionToolSpec {
  /** Viewset action (`destroy`). */
  action: string
  /** Tool name suffix (`delete`). */
  suffix: string
  description?: string
}

function viewsetPrefix(viewset: any): string {
  let model: any
  try {
    const inst = new viewset()
    model = inst.queryset?.model ?? viewset.queryset?.model
  } catch {
    model = undefined
  }
  if (model?._meta)
    return sanitizeToolName(String(model._meta.verboseNamePlural).replace(/\s+/g, '_').toLowerCase())
  return sanitizeToolName(snakeCase(String(viewset.name).replace(/ViewSet$|View$/, '')))
}

/**
 * Tools for a REST viewset, executed through `router.registry[i].invoke()`: the viewset's permission classes,
 * throttles, queryset, filters, pagination, validation and serializers apply exactly as over HTTP, as the
 * requesting user. HTTP errors (403, 404, 400…) become tool errors the model can read.
 *
 * ```ts
 * new ViewSetTools(PostViewSet, { actions: ['list', 'retrieve', 'create'] })   // posts_list, posts_retrieve, …
 * new ViewSetTools(router.registry[0])                                         // every action of a registration
 * ```
 */
export class ViewSetTools extends Toolkit {
  readonly entry: RouterRegistration
  readonly opts: ViewSetToolsOptions
  readonly prefix: string
  protected specs?: ActionToolSpec[]

  constructor(target: any, opts: ViewSetToolsOptions = {}) {
    super()
    this.opts = opts
    if (target instanceof RouterRegistration) {
      this.entry = target
      this.prefix = sanitizeToolName(opts.prefix ?? (target.prefix.replace(/\//g, '_') || target.basename))
    } else if (typeof target === 'function') {
      this.prefix = sanitizeToolName(opts.prefix ?? viewsetPrefix(target))
      const router = new SimpleRouter()
      this.entry = router.register(this.prefix, target, opts.basename ? { basename: opts.basename } : {})
    } else {
      throw new TypeError('ViewSetTools expects a viewset class or a router registry entry.')
    }
  }

  /** The (action, tool suffix) pairs to expose. */
  actionSpecs(): ActionToolSpec[] {
    if (this.specs) return this.specs
    const available = this.entry.actions
    const wanted = this.opts.actions ?? available
    this.specs = wanted.map((name) => {
      const action = ACTION_ALIASES[name] ?? name
      if (!available.includes(action)) {
        throw new ImproperlyConfigured(
          `${this.entry.viewset.name} has no routed action '${name}' (available: ${available.join(', ')}).`,
        )
      }
      return { action, suffix: snakeCase(name), description: this.opts.descriptions?.[name] }
    })
    return this.specs
  }

  getTools(): AgentTool[] {
    return this.actionSpecs().map((spec) => {
      const t = this.buildTool(spec)
      const scopes = scopesFor(this.scopeOption(), spec.suffix, spec.action)
      return scopes?.length ? { ...t, scopes: [...scopes] } : t
    })
  }

  /** The `scopes` option. */
  protected scopeOption(): ToolScopes | undefined {
    return this.opts.scopes
  }

  get model(): any {
    return this.entry.model
  }

  protected modelNames(): { one: string; many: string } {
    const meta = this.model?._meta
    return {
      one: meta ? String(meta.verboseName) : this.entry.basename,
      many: meta ? String(meta.verboseNamePlural) : this.prefix,
    }
  }

  protected lookup(): { kwarg: string; param: string; schema: JSONSchema } {
    const view = this.entry.viewFor('retrieve')
    const field = view.lookupField ?? 'pk'
    const kwarg = view.lookupUrlKwarg ?? field
    const param = kwarg === 'pk' ? 'id' : kwarg
    let schema: JSONSchema = { type: ['integer', 'string'] }
    const meta = this.model?._meta
    const modelField = meta && (field === 'pk' ? meta.pk : meta.getForwardField?.(field))
    if (modelField && typeof modelField.jsonSchema === 'function') {
      try {
        const s = modelField.jsonSchema()
        schema = { type: s.type ?? ['integer', 'string'], ...(s.format ? { format: s.format } : {}) }
      } catch {
        // keep the generic schema
      }
    }
    const { one } = this.modelNames()
    return { kwarg, param, schema: { ...schema, description: `Identifier (${field}) of the ${one}.` } }
  }

  protected describe(
    spec: ActionToolSpec,
    endpoint: { detail: boolean; extra: boolean; description?: string },
  ) {
    if (spec.description) return spec.description
    const { one, many } = this.modelNames()
    switch (spec.action) {
      case 'list':
        return `List ${many}. Supports the filters, search, ordering and pagination parameters below; returns the matching ${many}.`
      case 'retrieve':
        return `Get one ${one} by id.`
      case 'create':
        return `Create a ${one}. Returns the created ${one}.`
      case 'update':
        return `Replace a ${one} (all writable fields required). Returns the updated ${one}.`
      case 'partialUpdate':
        return `Update some fields of a ${one}; omitted fields are left unchanged. Returns the updated ${one}.`
      case 'destroy':
        return `Delete a ${one} by id. This cannot be undone.`
    }
    const extra = this.entry.extraActions.find((a) => a.name === spec.action)
    const desc = endpoint.description ?? (extra?.kwargs.description as string | undefined)
    if (desc) return desc
    return endpoint.detail
      ? `Run the '${spec.action}' action on one ${one}.`
      : `Run the '${spec.action}' action on ${many}.`
  }

  protected buildTool(spec: ActionToolSpec): AgentTool {
    const endpoints = this.entry.endpoints.filter((e) => e.action === spec.action)
    const endpoint = endpoints[0]
    const methods = [...new Set(endpoints.map((e) => e.method))]
    const extra = !STANDARD.has(spec.action)
    const properties: Record<string, JSONSchema> = {}
    const required: string[] = []
    const lookup = endpoint.detail ? this.lookup() : undefined
    if (lookup) {
      properties[lookup.param] = lookup.schema
      required.push(lookup.param)
    }
    const hasBodyMethod = methods.some((m) => ['POST', 'PUT', 'PATCH'].includes(m))
    let bodyKeys: string[] = []
    let nestData = false
    let queryKeys: string[] = []
    let freeQuery = false

    if (hasBodyMethod) {
      const kwargs = this.entry.extraActions.find((a) => a.name === spec.action)?.kwargs ?? {}
      const useSerializer = !extra || kwargs.serializerClass
      const schema = useSerializer
        ? this.entry.jsonSchema(spec.action, { mode: 'input', partial: spec.action === 'partialUpdate' })
        : undefined
      if (schema) {
        const body = cleanInputSchema(schema)
        const props = body.properties as Record<string, JSONSchema>
        nestData = !!lookup && lookup.param in props
        if (nestData) {
          properties.data = { ...body, description: 'Field values.' }
          if ((body.required as string[] | undefined)?.length) required.push('data')
        } else {
          Object.assign(properties, props)
          for (const r of (body.required as string[] | undefined) ?? []) required.push(r)
          bodyKeys = Object.keys(props)
        }
      } else {
        nestData = true
        properties.data = {
          type: 'object',
          description: 'Request body (JSON object), if the action takes one.',
        }
      }
    }
    if (spec.action === 'list') {
      const params = this.listParameters()
      const { properties: qp, required: qr } = parametersToProperties(params)
      for (const [k, v] of Object.entries(qp)) if (!(k in properties)) properties[k] = v
      required.push(...qr.filter((r) => !required.includes(r)))
      queryKeys = Object.keys(qp)
    } else if (methods.includes('GET') && extra) {
      freeQuery = true
      properties.query = { type: 'object', description: 'Optional query string parameters.' }
    }
    if (methods.length > 1) {
      properties.method = { type: 'string', enum: methods, description: 'HTTP method of the action.' }
    }

    const inputSchema: JSONSchema = { type: 'object', properties }
    if (required.length) inputSchema.required = required
    const annotations: ToolAnnotations = {
      title: `${this.prefix} ${spec.suffix}`.replace(/_/g, ' '),
      readOnlyHint: methods.every((m) => m === 'GET' || m === 'HEAD'),
      destructiveHint: spec.action === 'destroy' || methods.includes('DELETE'),
      idempotentHint: methods.every((m) => ['GET', 'HEAD', 'PUT', 'DELETE'].includes(m)),
      openWorldHint: false,
    }
    const entry = this.entry
    return {
      name: sanitizeToolName(`${this.prefix}_${spec.suffix}`),
      description: this.describe(spec, endpoint),
      inputSchema,
      annotations,
      parse: (value: unknown) => {
        if (value === undefined || value === null) return {}
        if (typeof value !== 'object' || Array.isArray(value))
          throw new ToolError('Arguments must be an object.')
        const missing = required.filter((r) => (value as any)[r] === undefined)
        if (lookup && missing.includes(lookup.param))
          throw new ToolError(`Missing required argument '${lookup.param}'.`, { status: 400 })
        return value
      },
      execute: async (input: Record<string, any>, ctx: ToolContext) => {
        const args = { ...(input ?? {}) }
        const kwargs: Record<string, unknown> = {}
        if (lookup) {
          kwargs[lookup.kwarg] = args[lookup.param]
          delete args[lookup.param]
        }
        const method = typeof args.method === 'string' ? args.method.toUpperCase() : undefined
        delete args.method
        let query: Record<string, unknown> | undefined
        let data: unknown
        if (spec.action === 'list') {
          query = {}
          for (const k of queryKeys) if (args[k] !== undefined && args[k] !== null) query[k] = args[k]
        } else if (freeQuery && args.query && typeof args.query === 'object') {
          query = args.query
          delete args.query
        }
        if (hasBodyMethod && method !== 'GET') {
          if (nestData) data = args.data ?? {}
          else {
            data = {}
            for (const k of bodyKeys) if (k in args) (data as any)[k] = args[k]
          }
        }
        // Anonymous users are passed as "no credentials" so views answer 401-style errors like over HTTP.
        const user = ctx.user?.isAuthenticated ? ctx.user : null
        const res = await entry.invoke(spec.action, { user, kwargs, query, data, method })
        return toolResult(res.status, res.data)
      },
    }
  }

  /** OpenAPI query parameters of the list action (filter backends + paginator). */
  protected listParameters(): Array<Record<string, unknown>> {
    const view = this.entry.viewFor('list')
    const out: Array<Record<string, unknown>> = []
    const backends: any[] =
      typeof view.getFilterBackends === 'function' ? view.getFilterBackends() : (view.filterBackends ?? [])
    for (const B of backends) {
      const b = new B()
      if (typeof b.getSchemaOperationParameters === 'function')
        out.push(...b.getSchemaOperationParameters(view))
    }
    const paginator = view.paginator
    if (paginator && typeof paginator.getSchemaOperationParameters === 'function')
      out.push(...paginator.getSchemaOperationParameters(view))
    const seen = new Set<string>()
    return out.filter((p) => {
      const name = String(p.name)
      if (seen.has(name)) return false
      seen.add(name)
      return true
    })
  }
}

/** Map an `invoke()` result to a tool result, throwing `ToolError` for 4xx / 5xx. */
export function toolResult(status: number, data: unknown): unknown {
  if (status >= 400) throw new ToolError(errorMessage(status, data), { status, detail: data })
  if (status === 204 || data === null || data === '') return { success: true, status }
  return data
}

function errorMessage(status: number, data: unknown): string {
  const detail =
    data && typeof data === 'object' && typeof (data as any).detail === 'string'
      ? (data as any).detail
      : typeof data === 'string' && data
        ? data
        : status === 400
          ? `Validation failed: ${JSON.stringify(data)}`
          : undefined
  return `${detail ?? 'Request failed.'} (HTTP ${status})`
}
