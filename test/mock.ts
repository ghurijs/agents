import { MockLanguageModelV4 } from 'ai/test'

export type ScriptPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; input: unknown; toolCallId?: string }

/** One model step: parts, or a function of the prompt (to react to tool results). */
export type ScriptStep = ScriptPart[] | ((prompt: any[]) => ScriptPart[])

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

let callSeq = 0

/**
 * A scripted AI SDK mock model: every `doGenerate` / `doStream` call plays the next step. After the script
 * ends it answers 'done'.
 */
export function scriptedModel(steps: ScriptStep[]) {
  let i = 0
  const next = (prompt: any[]) => {
    const step = steps[i++] ?? [{ type: 'text', text: 'done' }]
    const parts = typeof step === 'function' ? step(prompt) : step
    const content = parts.map((p) =>
      p.type === 'tool-call'
        ? {
            type: 'tool-call' as const,
            toolCallId: p.toolCallId ?? `call_${++callSeq}`,
            toolName: p.toolName,
            input: JSON.stringify(p.input),
          }
        : p,
    )
    const finishReason = {
      unified: content.some((c) => c.type === 'tool-call') ? ('tool-calls' as const) : ('stop' as const),
      raw: undefined,
    }
    return { content, finishReason }
  }
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: async (options: any) => {
      const { content, finishReason } = next(options.prompt)
      return { content, finishReason, usage, warnings: [] } as any
    },
    doStream: async (options: any) => {
      const { content, finishReason } = next(options.prompt)
      const chunks: any[] = [{ type: 'stream-start', warnings: [] }]
      content.forEach((c: any, j: number) => {
        if (c.type === 'text') {
          const id = `t${j}`
          chunks.push({ type: 'text-start', id })
          for (const word of c.text.split(/(?<= )/)) chunks.push({ type: 'text-delta', id, delta: word })
          chunks.push({ type: 'text-end', id })
        } else chunks.push(c)
      })
      chunks.push({ type: 'finish', finishReason, usage })
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(c)
            controller.close()
          },
        }),
      } as any
    },
  })
}

/** Tool results the model received in its prompt (last tool message). */
export function toolOutputs(prompt: any[]): Array<{ toolName: string; type: string; value: any }> {
  const out: Array<{ toolName: string; type: string; value: any }> = []
  for (const m of prompt) {
    if (m.role !== 'tool') continue
    for (const p of m.content) {
      if (p.type === 'tool-result')
        out.push({ toolName: p.toolName, type: p.output.type, value: p.output.value })
    }
  }
  return out
}
