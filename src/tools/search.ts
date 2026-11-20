// Tool search: with many tools, send the model only a few up front plus `find_tools`, which loads the others it
// asks for. Fewer schemas per request cost fewer tokens and are easier for smaller models to choose from.

import type { ModelMessage } from 'ai'
import { describeTool } from './shaping'
import type { AgentTool } from './types'

export const FIND_TOOLS = 'find_tools'

export interface ToolSearchOptions {
  /** Tools sent from the start, by name (default none: everything else is found with `find_tools`). */
  alwaysLoaded?: string[]
  /** Most tools one search loads (default 5). */
  maxResults?: number
}

export function toolSearchOptions(
  value: boolean | ToolSearchOptions | undefined,
): ToolSearchOptions | undefined {
  if (!value) return undefined
  return value === true ? {} : value
}

const STOP = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'for',
  'and',
  'or',
  'in',
  'on',
  'by',
  'with',
  'my',
  'me',
  'i',
])

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
}

/** `products` ↔ `product`: compare words without a trailing plural `s` / `es`. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith('es') && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** Score tools against a query: words in the name count most, then the title and the description. */
export function searchTools(tools: AgentTool[], query: string, limit = 5): AgentTool[] {
  const q = [...new Set(terms(query).map(stem))]
  if (!q.length) return []
  const scored = tools.map((t) => {
    const name = new Set(terms(t.name.replace(/_/g, ' ')).map(stem))
    const title = new Set(terms(t.annotations?.title ?? '').map(stem))
    const desc = new Set(terms(t.description).map(stem))
    let score = 0
    for (const w of q) {
      if (name.has(w)) score += 3
      else if (title.has(w)) score += 2
      else if (desc.has(w)) score += 1
    }
    return { t, score }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.t)
}

/** Description of `find_tools`: how to use it and the names of every tool it can load. */
export function findToolsDescription(deferred: AgentTool[]): string {
  return (
    'Load more tools. Only some tools are available until you load them: describe what you need to do ' +
    '(`query`), or give exact tool names (`names`). The loaded tools can be called from your next step on.\n\n' +
    `Tools you can load: ${deferred.map((t) => t.name).join(', ')}`
  )
}

export const FIND_TOOLS_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'What you want to do, e.g. "change the price of a product".' },
    names: { type: 'array', items: { type: 'string' }, description: 'Exact names of tools to load.' },
  },
} as const

/** Run a search: the tools to load (by `names` first, then by `query`) and a short result for the model. */
export function runFindTools(
  deferred: AgentTool[],
  input: { query?: unknown; names?: unknown },
  limit = 5,
): { loaded: Array<{ name: string; description: string }>; message?: string } {
  const byName = new Map(deferred.map((t) => [t.name, t]))
  const picked = new Map<string, AgentTool>()
  const unknown: string[] = []
  if (Array.isArray(input.names)) {
    for (const n of input.names) {
      const t = byName.get(String(n))
      if (t) picked.set(t.name, t)
      else unknown.push(String(n))
    }
  }
  if (typeof input.query === 'string' && input.query.trim()) {
    for (const t of searchTools(deferred, input.query, limit)) picked.set(t.name, t)
  }
  const loaded = [...picked.values()].map((t) => ({ name: t.name, description: describeTool(t) }))
  const notes: string[] = []
  if (unknown.length) notes.push(`No tool named ${unknown.join(', ')}.`)
  if (!loaded.length)
    notes.push(`Nothing matched. Tools you can load: ${deferred.map((t) => t.name).join(', ')}`)
  return { loaded, ...(notes.length ? { message: notes.join(' ') } : {}) }
}

/** Tool names loaded by earlier `find_tools` calls in these messages (history and earlier steps). */
export function loadedToolNames(messages: ModelMessage[]): Set<string> {
  const names = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue
    for (const part of m.content as any[]) {
      if (part?.type !== 'tool-result' || part.toolName !== FIND_TOOLS) continue
      const value = part.output?.value ?? part.output
      const loaded = value && typeof value === 'object' ? (value as any).loaded : undefined
      if (Array.isArray(loaded))
        for (const l of loaded) if (l && typeof l.name === 'string') names.add(l.name)
    }
  }
  return names
}
