import { transform } from 'esbuild'
import { defineConfig } from 'vitest/config'

// Vite 8 transpiles TypeScript with oxc, which does not lower TC39 (stage 3) decorators yet. `@tool` (and
// `@action` in test viewsets) use standard decorators (what tsup/esbuild/wrangler emit), so lower them with
// esbuild first — the same trick as @ghuri/rest.
export default defineConfig({
  plugins: [
    {
      name: 'ghuri-standard-decorators',
      enforce: 'pre',
      async transform(code, id) {
        if (!/\.tsx?$/.test(id) || id.includes('node_modules') || !/^\s*@\w/m.test(code)) return null
        const out = await transform(code, {
          loader: id.endsWith('.tsx') ? 'tsx' : 'ts',
          target: 'es2022',
          sourcemap: true,
          sourcefile: id,
          jsx: 'automatic',
          jsxImportSource: 'hono/jsx',
        })
        return { code: out.code, map: out.map }
      },
    },
  ],
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // PGlite databases are slow to start on busy machines.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
