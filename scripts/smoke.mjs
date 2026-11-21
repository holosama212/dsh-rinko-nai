// 冒烟测试：假 ctx 跑 apply()，不联网、不需要 Key，验证工具/路由/系统提示是否挂上。
// 用法：node scripts/smoke.mjs   （或 npm run smoke）
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rinko-smoke-'))
const mod = await import('../lib/index.js')

const tools = []
const routes = []
let spName = null
const ctx = {
  tools: { register(t) { tools.push(t.name); return () => {} } },
  webServer: { register(r) { routes.push(r.kind + ' ' + r.path); return () => {} } },
  systemPrompt: { context(o) { spName = o && o.name; return () => {} } },
  logger: { info() {}, warn() {} },
  effect(fn) { fn(); return () => {} },
}

mod.apply(ctx)

const checks = [
  ['name = rinko-nai', mod.name === 'rinko-nai'],
  ['inject 含 webServer', Array.isArray(mod.inject) && mod.inject.includes('webServer')],
  ['工具 rinko_nai_image', tools.includes('rinko_nai_image')],
  ['工具 rinko_nai_status', tools.includes('rinko_nai_status')],
  ['同源路由 /api/rinko-nai', routes.some((r) => r.includes('/api/rinko-nai'))],
  ['系统提示 inline-display', spName === 'rinko-nai:inline-display'],
]

let ok = true
for (const [label, pass] of checks) {
  console.log((pass ? '✓ ' : '✗ ') + label)
  if (!pass) ok = false
}
console.log(ok ? 'smoke ok' : 'smoke FAILED')
if (!ok) process.exit(1)
