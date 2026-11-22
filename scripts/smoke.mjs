// 冒烟测试：假 ctx 跑 apply()，不联网、不需要 Key。
// 覆盖两种 profile：
//   A. 完整（有 webServer + systemPrompt）→ 工具/路由/系统提示都挂上
//   B. headless/tui（只有 tools）→ 不能崩，工具照常挂上，路由/提示跳过
// 用法：node scripts/smoke.mjs   （或 npm run smoke）
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rinko-smoke-'))
const mod = await import('../lib/index.js')

function makeCtx(services) {
  const tools = []
  const routes = []
  let spName = null
  const ctx = {
    tools: { register(t) { tools.push(t.name); return () => {} } },
    logger: { info() {}, warn() {} },
    effect(fn) { fn(); return () => {} },
  }
  if (services.webServer) ctx.webServer = { register(r) { routes.push(r.kind + ' ' + r.path); return () => {} } }
  if (services.systemPrompt) ctx.systemPrompt = { context(o) { spName = o && o.name; return () => {} } }
  // 模拟 Cordis 的可选作用域注入：依赖都在才跑回调，否则跳过（不抛错）
  ctx.inject = (deps, cb) => {
    if (deps.every((d) => ctx[d])) cb(ctx)
  }
  return { ctx, tools, routes, getSp: () => spName }
}

let ok = true
function check(label, pass) { console.log((pass ? '✓ ' : '✗ ') + label); if (!pass) ok = false }

// A. 完整 profile
const A = makeCtx({ webServer: true, systemPrompt: true })
mod.apply(A.ctx)
check('A 工具 rinko_nai_image', A.tools.includes('rinko_nai_image'))
check('A 工具 rinko_nai_status', A.tools.includes('rinko_nai_status'))
check('A 工具 rinko_nai_parallel', A.tools.includes('rinko_nai_parallel'))
check('A 工具 rinko_nai_img2img', A.tools.includes('rinko_nai_img2img'))
check('A 工具 rinko_nai_batch', A.tools.includes('rinko_nai_batch'))
check('A 同源路由 /api/rinko-nai', A.routes.some((r) => r.includes('/api/rinko-nai')))
check('A 系统提示 inline-display', A.getSp() === 'rinko-nai:inline-display')

// B. headless/tui：只有 tools
const B = makeCtx({})
let threw = null
try { mod.apply(B.ctx) } catch (e) { threw = e }
check('B headless 不抛错', !threw)
check('B 工具仍挂上', B.tools.includes('rinko_nai_image') && B.tools.includes('rinko_nai_status'))
check('B 无路由（跳过）', B.routes.length === 0)
check('B 无系统提示（跳过）', B.getSp() === null)

// inject 只声明必需项：webServer/systemPrompt 不应出现在必需 inject 里
check('inject 只含 tools（webServer 可选）', Array.isArray(mod.inject) && mod.inject.includes('tools') && !mod.inject.includes('webServer'))

console.log(ok ? 'smoke ok' : 'smoke FAILED')
if (!ok) process.exit(1)
