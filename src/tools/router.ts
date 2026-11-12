import type { BaseRouter, RouterRegistration } from '@ghuri/rest'
import { type AgentTool, Toolkit } from './types'
import { ViewSetTools } from './viewset'

export interface RouterToolsOptions {
  /** Only these registrations (by prefix or basename), or a predicate. */
  include?: string[] | ((entry: RouterRegistration) => boolean)
  /** Skip these registrations (by prefix or basename), or tool names (`posts_destroy`). */
  exclude?: string[] | ((entry: RouterRegistration) => boolean)
  /** Restrict actions per registration: `{ posts: ['list', 'retrieve'] }`. */
  actions?: Record<string, string[]>
  /** Only read-only actions (GET). */
  readOnly?: boolean
}

function matches(entry: RouterRegistration, spec: string[] | ((e: RouterRegistration) => boolean)): boolean {
  if (typeof spec === 'function') return spec(entry)
  return spec.includes(entry.prefix) || spec.includes(entry.basename)
}

/**
 * Expose a whole REST API as tools: one `ViewSetTools` per router registration.
 *
 * ```ts
 * new RouterTools(router, { exclude: ['users'], readOnly: true })
 * ```
 */
export class RouterTools extends Toolkit {
  constructor(
    readonly router: BaseRouter,
    readonly opts: RouterToolsOptions = {},
  ) {
    super()
  }

  /** The `ViewSetTools` of each included registration. */
  toolkits(): ViewSetTools[] {
    const out: ViewSetTools[] = []
    for (const entry of this.router.registry) {
      if (this.opts.include && !matches(entry, this.opts.include)) continue
      if (this.opts.exclude && matches(entry, this.opts.exclude)) continue
      let actions = this.opts.actions?.[entry.prefix] ?? this.opts.actions?.[entry.basename]
      if (this.opts.readOnly) {
        const safe = new Set(entry.endpoints.filter((e) => e.method === 'GET').map((e) => e.action))
        actions = (actions ?? entry.actions).filter((a) => safe.has(a))
      }
      if (actions && !actions.length) continue
      out.push(new ViewSetTools(entry, actions ? { actions } : {}))
    }
    return out
  }

  getTools(): AgentTool[] {
    const excluded = Array.isArray(this.opts.exclude) ? new Set(this.opts.exclude) : undefined
    return this.toolkits()
      .flatMap((t) => t.getTools())
      .filter((t) => !excluded?.has(t.name))
  }
}
