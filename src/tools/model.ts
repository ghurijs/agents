import type { RequestUser } from '@ghuri/core'
import {
  FieldFilter,
  ModelSerializer,
  ModelViewSet,
  OrderingFilter,
  PageNumberPagination,
  type PermissionClass,
  SearchFilter,
} from '@ghuri/rest'
import { sanitizeToolName } from './schema'
import { type ActionToolSpec, type ToolScopes, ViewSetTools } from './viewset'

export type ModelToolAction = 'list' | 'retrieve' | 'create' | 'update' | 'delete'

/** ModelTools action → generated viewset action (`update` is a partial update: only the given fields change). */
const ACTIONS: Record<ModelToolAction, string> = {
  list: 'list',
  retrieve: 'retrieve',
  create: 'create',
  update: 'partialUpdate',
  delete: 'destroy',
}

export interface ModelToolsOptions {
  /** Tools to generate (default `['list', 'retrieve']`: read-only unless you opt into writes). */
  actions?: ModelToolAction[]
  /** Serializer class (default: a `ModelSerializer` with `fields: '__all__'`). */
  serializer?: any
  /** Scope the queryset to the requesting user: `(qs, user) => qs.filter({ owner: user.pk })`. Applies to
   * every action (list, retrieve, update, delete), so other users' rows are invisible (404). */
  filter?: (qs: any, user: RequestUser) => any
  /** Enable `search` over these fields (SearchFilter lookups: `'title'`, `'^slug'`, `'=email'`). */
  searchFields?: string[]
  /** Fields the model may order by (`ordering=-createdAt`); `'__all__'` for any readable field. */
  orderingFields?: string[] | '__all__'
  /** Default ordering. */
  ordering?: string | string[]
  /** Exact-match filters (FieldFilter): `['status']` or `{ createdAt: ['gte', 'lte'] }`. */
  filterFields?: string[] | Record<string, string[]>
  /** Page size of `list` (default 20; the model may request up to `maxPageSize` with `pageSize`). */
  pageSize?: number
  maxPageSize?: number
  /** REST permission classes checked for every call (default `REST_FRAMEWORK.DEFAULT_PERMISSION_CLASSES`). */
  permissionClasses?: PermissionClass[]
  /** Extra values saved on create / update, e.g. the owner: `(user) => ({ owner: user.pk })`. */
  saveKwargs?: (
    user: RequestUser,
    action: 'create' | 'update',
  ) => Record<string, unknown> | Promise<Record<string, unknown>>
  /** Tool name prefix (default: the model's plural verbose name: `posts`). */
  prefix?: string
  /** Override tool descriptions per action. */
  descriptions?: Partial<Record<ModelToolAction, string>>
  /** OAuth scopes for MCP: for every tool, or per action (`{ list: ['posts:read'], create: ['posts:write'] }`). */
  scopes?: ToolScopes
}

function defaultSerializer(model: any): any {
  const cls = class extends ModelSerializer {
    static override Meta = { model, fields: '__all__' as const }
  }
  Object.defineProperty(cls, 'name', { value: `${model._meta.objectName}Serializer` })
  return cls
}

/** Build the ModelViewSet behind a `ModelTools`. */
function buildViewSet(model: any, opts: ModelToolsOptions): any {
  const serializer = opts.serializer ?? defaultSerializer(model)
  const backends: any[] = []
  if (opts.filterFields) backends.push(FieldFilter)
  if (opts.searchFields?.length) backends.push(SearchFilter)
  if (opts.orderingFields || opts.ordering) backends.push(OrderingFilter)
  const pageSize = opts.pageSize ?? 20
  const maxPageSize = opts.maxPageSize ?? Math.max(100, pageSize)
  const Paginator = class AgentPagination extends PageNumberPagination {
    override pageSize = pageSize
    override pageSizeQueryParam = 'pageSize'
    override maxPageSize = maxPageSize
  }
  const ViewSet = class extends ModelViewSet {
    override queryset = model
    override serializerClass = serializer
    override filterBackends = backends
    override paginationClass = Paginator as any
    override searchFields = opts.searchFields
    override orderingFields = opts.orderingFields
    override ordering = opts.ordering
    override filtersetFields = opts.filterFields

    constructor() {
      super()
      if (opts.permissionClasses) this.permissionClasses = opts.permissionClasses
    }

    override getQueryset(): any {
      const qs = super.getQueryset()
      return opts.filter ? opts.filter(qs, this.request.user) : qs
    }

    override async performCreate(serializer: any): Promise<void> {
      await serializer.save(opts.saveKwargs ? await opts.saveKwargs(this.request.user, 'create') : {})
    }

    override async performUpdate(serializer: any): Promise<void> {
      await serializer.save(opts.saveKwargs ? await opts.saveKwargs(this.request.user, 'update') : {})
    }
  }
  Object.defineProperty(ViewSet, 'name', { value: `${model._meta.objectName}ToolsViewSet` })
  return ViewSet
}

/**
 * CRUD tools for a model: `posts_list`, `posts_retrieve`, `posts_create`, `posts_update`, `posts_delete`.
 * Built on a generated `ModelViewSet`, so serializers (validation, read-only fields), permission classes,
 * filters and pagination behave exactly like your REST API, and every call runs as the requesting user.
 *
 * ```ts
 * new ModelTools(Order, {
 *   actions: ['list', 'retrieve'],
 *   serializer: OrderSerializer,
 *   filter: (qs, user) => qs.filter({ customer: user.pk }),
 *   searchFields: ['number'], orderingFields: ['createdAt'],
 * })
 * ```
 */
export class ModelTools extends ViewSetTools {
  readonly modelClass: any
  readonly modelOptions: ModelToolsOptions

  constructor(model: any, opts: ModelToolsOptions = {}) {
    if (!model?._meta) throw new TypeError('ModelTools expects a model class.')
    const prefix =
      opts.prefix ??
      sanitizeToolName(String(model._meta.verboseNamePlural).replace(/\s+/g, '_').toLowerCase())
    super(buildViewSet(model, opts), { prefix, basename: model._meta.modelName })
    this.modelClass = model
    this.modelOptions = opts
  }

  protected override scopeOption(): ToolScopes | undefined {
    return this.modelOptions.scopes
  }

  override actionSpecs(): ActionToolSpec[] {
    if (!this.specs) {
      const actions = this.modelOptions.actions ?? ['list', 'retrieve']
      this.specs = actions.map((a) => {
        const action = ACTIONS[a]
        if (!action)
          throw new TypeError(`ModelTools: unknown action '${a}' (use ${Object.keys(ACTIONS).join(', ')}).`)
        return { action, suffix: a, description: this.modelOptions.descriptions?.[a] }
      })
    }
    return this.specs
  }
}
