import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ["src/index.ts", "src/evals/index.ts", "src/admin.ts"],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: [/^@ghuri\//, /^node:/, 'cloudflare:workers'],
})
