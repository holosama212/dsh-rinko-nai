/**
 * dsh-rinko-nai —— YesNAI（nai.rinko.ai）出图插件 · 宿主半
 *
 * 三件事：
 *   1. 工具：`rinko_nai_image`（出图 / 询价）、`rinko_nai_status`（通道状态）
 *   2. 同源 API：`/api/rinko-nai/*`（state / config / login / logout / test / generate / file）
 *   3. 登录即用：账号密码 → 登录换 token → 自动建一把名为 dsh-rinko-nai 的 API Key →
 *      出图全走这把 Key（网站生成端点只认 ynai- Key，不认登录 token，实测 401）。
 *
 * 接口依据（网站 /docs + 控制台 JS 实测）：
 *   · POST {base}/api/ynai/auth/login            {username,password} → {message,data:{access_token}}（7 天有效）
 *   · GET  {base}/api/ynai/user/self             账户信息（余额/图包/积分都这里）
 *   · GET  {base}/api/ynai/user/balance          {data:{balance_gems}}
 *   · GET  {base}/api/ynai/tokens                Key 列表（登录 token）
 *   · POST {base}/api/ynai/tokens                新建 Key {name} → {data:{token:"ynai-…",record}}
 *   · POST {base}/api/ynai/tokens/{id}/key       重新取某把 Key 的明文（= 控制台「Show key」）
 *   · POST {base}/v1/nai/generate-image          出图（Bearer ynai- Key）→ {job, images[b64], image_format}
 *   · POST {base}/ai/generate-image/quote        免费询价
 *   · GET  {base}/v1/models                      模型表（无需鉴权）
 *
 * 本文件只 import node: 内置模块；`@deepseek-ai/dsh-tools` 从宿主树解析（link: 包裸名解析不到）。
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, statSync, unlinkSync, chmodSync } from 'node:fs'
import { inflateSync, inflateRawSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join, resolve as pathResolve, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

function loadDefineTool() {
  const candidates = []
  const push = (p) => { if (p && !candidates.includes(p)) candidates.push(p) }
  try {
    const argv1 = process.argv[1] ? String(process.argv[1]).replace(/\\/g, '/') : ''
    if (argv1) {
      const nm = argv1.lastIndexOf('/node_modules/')
      if (nm >= 0) push(join(argv1.slice(0, nm), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
      const i = argv1.lastIndexOf('/')
      if (i >= 0) push(join(argv1.slice(0, i), '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  } catch { /* ignore */ }
  const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
  for (const home of homes) {
    push(join(home, 'package.json'))
    for (const profile of ['web', 'desktop', 'default']) {
      push(join(home, 'profiles', profile, 'package.json'))
      push(join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  push(join(process.cwd(), 'package.json'))
  for (const pkg of candidates) {
    try {
      if (!existsSync(pkg)) continue
      const mod = createRequire(pkg)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch { /* try next */ }
  }
  return null
}

const hostDefineTool = loadDefineTool()
const defineTool = typeof hostDefineTool === 'function'
  ? hostDefineTool
  : (() => {
      try { console.warn('[rinko-nai] 未能从宿主解析 @deepseek-ai/dsh-tools，工具注册降级为直通（宿主 API 可能已变）') } catch { /* ignore */ }
      return (tool) => tool
    })()

export const name = 'rinko-nai'
export const inject = ['tools']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'rinko-nai')
const CONFIG_PATH = join(DATA_DIR, 'config.json')
const MEDIA_DIR = join(DSH_HOME, 'media', 'rinko-nai')
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSET_DIR = join(PLUGIN_DIR, 'assets')
const API_PREFIX = '/api/rinko-nai'

/** 本插件在网站上自动创建的 Key 的名字（别人登录后也会建自己的这把）。 */
const KEY_NAME = 'dsh-rinko-nai'

/** 支持的站点（同一套接口，账号体系独立、Gems 独立）。 */
const SITES = {
  nai: { id: 'nai', label: 'YesNAI 公益站', baseUrl: 'https://nai.rinko.ai' },
  ynai: { id: 'ynai', label: 'YesNAI 主站', baseUrl: 'https://ynai.rinko.ai' },
}
const SITE_IDS = Object.keys(SITES)

function defaultSite(id) {
  return { baseUrl: SITES[id].baseUrl, apiKey: '', apiKeys: [], keySource: 'manual', username: '', password: '' }
}

const DEFAULT_CONFIG = {
  enabled: true,
  activeSite: 'nai',
  sites: { nai: defaultSite('nai'), ynai: defaultSite('ynai') },
  model: 'nai-diffusion-4-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  scale: 5,
  sampler: 'k_euler_ancestral',
  noise_schedule: 'karras',
  negativePrompt: '',
  promptSuffix: '',
  ucPreset: 0,
  qualityToggle: true,
}

let config = { ...DEFAULT_CONFIG, sites: { nai: defaultSite('nai'), ynai: defaultSite('ynai') } }
/** 登录会话 token（7 天过期，只做内存缓存；Key 才是长期凭据）。按站点分别缓存。 */
let loginCache = { nai: { token: '', at: 0 }, ynai: { token: '', at: 0 } }
let lastGeneration = null
let PKG_VERSION = '0.0.0'
try { PKG_VERSION = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version || PKG_VERSION } catch { /* ignore */ }
const bridge = { lastSeen: null, count: 0, build: 'v' + PKG_VERSION }

// ---- 配置 ---------------------------------------------------------------

function normalizeSite(site, id) {
  const base = defaultSite(id)
  const s = site && typeof site === 'object' ? site : {}
  return {
    baseUrl: typeof s.baseUrl === 'string' && s.baseUrl.trim() !== '' ? s.baseUrl.trim().replace(/\/+$/, '') : base.baseUrl,
    apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
    apiKeys: Array.isArray(s.apiKeys) ? s.apiKeys.map((k) => String(k || '').trim()).filter(Boolean) : [],
    keySource: s.keySource === 'auto' ? 'auto' : 'manual',
    username: typeof s.username === 'string' ? s.username : '',
    password: typeof s.password === 'string' ? s.password : '',
  }
}

/** 旧版单一 baseUrl 的配置迁到 sites 里，别让老用户丢凭据。 */
function migrateConfig(raw) {
  const out = {
    ...DEFAULT_CONFIG,
    sites: { nai: defaultSite('nai'), ynai: defaultSite('ynai') },
  }
  if (!raw || typeof raw !== 'object') return out
  const shared = ['enabled', 'model', 'width', 'height', 'steps', 'scale', 'sampler', 'noise_schedule', 'negativePrompt', 'promptSuffix', 'ucPreset', 'qualityToggle']
  for (const k of shared) if (k in raw) out[k] = raw[k]
  if (raw.sites && typeof raw.sites === 'object') {
    out.sites.nai = normalizeSite(raw.sites.nai, 'nai')
    out.sites.ynai = normalizeSite(raw.sites.ynai, 'ynai')
    if (SITE_IDS.includes(raw.activeSite)) out.activeSite = raw.activeSite
    return out
  }
  // 旧扁平结构：按 baseUrl 判断归到哪个站
  let target = 'nai'
  const oldBase = String(raw.baseUrl || '')
  if (oldBase.indexOf('ynai.rinko.ai') >= 0) target = 'ynai'
  out.sites[target] = normalizeSite({
    baseUrl: oldBase || SITES[target].baseUrl,
    apiKey: raw.apiKey,
    keySource: raw.keySource,
    username: raw.username,
    password: raw.password,
  }, target)
  out.activeSite = target
  return out
}

let configMtime = 0

function loadConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    config = migrateConfig(raw)
    try { configMtime = statSync(CONFIG_PATH).mtimeMs } catch { /* ignore */ }
  } catch { /* 坏文件当默认值 */ }
}

/** 配置热加载：外部改了 config.json（比如手动填 Key）无需重启，按 mtime 近零成本重读。 */
function maybeReloadConfig() {
  try {
    const m = statSync(CONFIG_PATH).mtimeMs
    if (m !== configMtime) loadConfig()
  } catch { /* 文件不存在就忽略 */ }
}

function saveConfig() {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const tmp = CONFIG_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
    renameSync(tmp, CONFIG_PATH)
    try { configMtime = statSync(CONFIG_PATH).mtimeMs } catch { /* ignore */ }
    try { chmodSync(CONFIG_PATH, 0o600) } catch { /* Windows 忽略 */ }
  } catch { /* 写不进不影响本次运行 */ }
}

function masked(value) {
  const s = String(value || '')
  if (s === '') return ''
  if (s.length <= 10) return s.slice(0, 3) + '…'
  return s.slice(0, 10) + '…' + s.slice(-4)
}

function activeSiteKey() {
  return SITE_IDS.includes(config.activeSite) ? config.activeSite : 'nai'
}

/** 当前站点的配置对象。 */
function site() {
  maybeReloadConfig()
  const id = activeSiteKey()
  if (!config.sites[id]) config.sites[id] = defaultSite(id)
  return config.sites[id]
}

/** 给设置页的配置：Key/密码只回掩码和「有没有」。 */
function publicConfig() {
  const id = activeSiteKey()
  const s = site()
  const sitesPublic = {}
  for (const sid of SITE_IDS) {
    const st = config.sites[sid] || defaultSite(sid)
    sitesPublic[sid] = {
      id: sid,
      label: SITES[sid].label,
      baseUrl: st.baseUrl,
      apiKey: '',
      apiKeyMasked: masked(st.apiKey),
      hasKey: st.apiKey !== '',
      extraKeys: (Array.isArray(st.apiKeys) ? st.apiKeys : []).length,
      extraKeysMasked: (Array.isArray(st.apiKeys) ? st.apiKeys : []).map(masked),
      keySource: st.keySource,
      username: st.username,
      hasPassword: st.password !== '',
      loggedIn: st.username !== '' && st.password !== '',
    }
  }
  return {
    ...config,
    apiKey: '',
    password: '',
    baseUrl: s.baseUrl,
    activeSite: id,
    sites: sitesPublic,
    apiKeyMasked: masked(s.apiKey),
    hasKey: s.apiKey !== '',
    hasPassword: s.password !== '',
    loggedIn: s.username !== '' && s.password !== '',
  }
}

const SHARED_WRITABLE = [
  'model', 'width', 'height', 'steps', 'scale', 'sampler', 'noise_schedule',
  'negativePrompt', 'promptSuffix', 'ucPreset', 'qualityToggle', 'enabled',
]

function applyUpdate(body, opts = {}) {
  const src = body && typeof body === 'object' ? body : {}
  const next = { ...config, sites: { ...config.sites } }
  for (const key of SHARED_WRITABLE) {
    if (!(key in src)) continue
    const v = src[key]
    if (key === 'model' || key === 'sampler' || key === 'noise_schedule') {
      if (typeof v === 'string' && v.trim() !== '') next[key] = v.trim()
      continue
    }
    if (key === 'negativePrompt' || key === 'promptSuffix') { if (typeof v === 'string') next[key] = v; continue }
    if (key === 'width' || key === 'height' || key === 'steps' || key === 'scale' || key === 'ucPreset') {
      const n = Number(v)
      if (Number.isFinite(n)) next[key] = n
      continue
    }
    if (key === 'qualityToggle' || key === 'enabled') next[key] = Boolean(v)
  }
  // 切站点
  if (typeof src.activeSite === 'string' && SITE_IDS.includes(src.activeSite)) next.activeSite = src.activeSite
  // 站点级字段：作用于「当前站点」（含刚切的站点）
  const targetId = SITE_IDS.includes(src.activeSite) ? src.activeSite : (SITE_IDS.includes(next.activeSite) ? next.activeSite : activeSiteKey())
  const cur = { ...(next.sites[targetId] || defaultSite(targetId)) }
  if (typeof src.baseUrl === 'string' && src.baseUrl.trim() !== '') cur.baseUrl = src.baseUrl.trim().replace(/\/+$/, '')
  if (typeof src.apiKey === 'string' && src.apiKey.trim() !== '') { cur.apiKey = src.apiKey.trim(); cur.keySource = 'manual' }
  if (typeof src.username === 'string') cur.username = src.username.trim()
  if (typeof src.password === 'string' && src.password.trim() !== '') cur.password = src.password.trim()
  if (Array.isArray(src.apiKeys)) cur.apiKeys = src.apiKeys.map((k) => String(k || '').trim()).filter(Boolean)
  else if (typeof src.apiKeys === 'string') cur.apiKeys = src.apiKeys.split(/[\r\n,]+/).map((k) => k.trim()).filter(Boolean)
  if (opts.clearKeys === true) cur.apiKeys = []
  if (opts.clearKey === true) { cur.apiKey = ''; cur.keySource = 'manual' }
  if (opts.clearPassword === true) cur.password = ''
  next.sites[targetId] = cur
  if (opts.clearKey === true || opts.clearPassword === true) loginCache[targetId] = { token: '', at: 0 }
  config = next
  saveConfig()
  return publicConfig()
}

// ---- HTTP 基础 ----------------------------------------------------------

function baseUrl() {
  const raw = String(site().baseUrl || SITES[activeSiteKey()].baseUrl).trim()
  return raw.replace(/\/+$/, '') || SITES[activeSiteKey()].baseUrl
}

/** 允许外部浏览器打开的域名（只放行本插件支持的站点，防止被当跳板 ）。 */
function allowedOrigins() {
  const set = new Set()
  for (const id of SITE_IDS) {
    try { set.add(new URL((config.sites[id] && config.sites[id].baseUrl) || SITES[id].baseUrl).host) } catch { /* ignore */ }
  }
  return set
}

/** 用系统默认浏览器打开网址（Windows: start；macOS: open；Linux: xdg-open）。 */
function openExternal(url) {
  const u = new URL(String(url))
  if (!allowedOrigins().has(u.host)) throw new Error('不在允许的站点范围内：' + u.host)
  const opener = process.platform === 'win32'
    ? { cmd: 'cmd', args: ['/c', 'start', '', u.toString()] }
    : process.platform === 'darwin'
      ? { cmd: 'open', args: [u.toString()] }
      : { cmd: 'xdg-open', args: [u.toString()] }
  const child = spawn(opener.cmd, opener.args, { detached: true, stdio: 'ignore' })
  child.unref()
  return u.toString()
}

function escapeAttr(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 清理过期的支付跳转临时页（pay-*.html），避免越攒越多。 */
function cleanupPayFiles(maxAgeMs) {
  let names = []
  try { names = readdirSync(DATA_DIR) } catch { return }
  const now = Date.now()
  for (const name of names) {
    if (!/^pay-\d+\.html$/.test(name)) continue
    const full = join(DATA_DIR, name)
    try { if (now - statSync(full).mtimeMs > maxAgeMs) unlinkSync(full) } catch { /* ignore */ }
  }
}

// ---- 图片元数据解析（法术解析 / 从图片导入参数） --------------------------

function decodePngTextData(type, data) {
  if (type === 'tEXt') {
    const z = data.indexOf(0)
    if (z < 0) return null
    return { keyword: data.toString('latin1', 0, z), text: data.toString('utf8', z + 1) }
  }
  if (type === 'zTXt') {
    const z = data.indexOf(0)
    if (z < 0 || z + 2 > data.length) return null
    const keyword = data.toString('latin1', 0, z)
    const compMethod = data[z + 1]
    let body = data.subarray(z + 2)
    if (compMethod === 0) { try { body = inflateSync(body) } catch { return { keyword, text: '' } } }
    return { keyword, text: body.toString('utf8') }
  }
  if (type === 'iTXt') {
    let p = 0
    const kend = data.indexOf(0, p); if (kend < 0) return null
    const keyword = data.toString('latin1', p, kend); p = kend + 1
    const compFlag = data[p]; p += 1; p += 1 // compFlag, compMethod
    const lend = data.indexOf(0, p); p = lend + 1
    const tend = data.indexOf(0, p); p = tend + 1
    let body = data.subarray(p)
    if (compFlag === 1) { try { body = inflateSync(body) } catch { return { keyword, text: '' } } }
    return { keyword, text: body.toString('utf8') }
  }
  return null
}

function readPngTexts(buf) {
  const out = {}
  let pos = 8
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const dataStart = pos + 8
    if (dataStart + len > buf.length) break
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const pair = decodePngTextData(type, buf.subarray(dataStart, dataStart + len))
      if (pair && pair.keyword) out[pair.keyword] = pair.text
    }
    if (type === 'IEND') break
    pos = dataStart + len + 4
  }
  return out
}

function parseA1111(text) {
  if (!text || typeof text !== 'string') return {}
  const out = {}
  const lines = text.trim().split(/\r?\n/)
  const last = lines[lines.length - 1] || ''
  let paramsPart = ''
  let promptPart = text.trim()
  if (/Steps:\s*\d+/i.test(last)) { paramsPart = last; promptPart = lines.slice(0, -1).join('\n').trim() }
  const negLine = promptPart.indexOf('Negative prompt:')
  if (negLine >= 0) {
    out.prompt = promptPart.slice(0, negLine).trim()
    out.negative = promptPart.slice(negLine + 'Negative prompt:'.length).trim()
  } else if (promptPart) { out.prompt = promptPart }
  const g = (re) => { const m = paramsPart.match(re); return m ? m[1].trim() : undefined }
  const steps = g(/Steps:\s*(\d+)/i); if (steps) out.steps = Number(steps)
  const scale = g(/CFG scale:\s*([\d.]+)/i); if (scale) out.scale = Number(scale)
  const seed = g(/Seed:\s*(\d+)/i); if (seed) out.seed = Number(seed)
  const sampler = g(/Sampler:\s*([^,]+)/i); if (sampler) out.sampler = sampler.trim()
  const size = paramsPart.match(/Size:\s*(\d+)\s*x\s*(\d+)/i); if (size) { out.width = Number(size[1]); out.height = Number(size[2]) }
  const model = g(/Model:\s*([^,]+)/i); if (model) out.model = model.trim()
  return out
}

function parseJpegExif(buf) {
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return null
  let i = 2
  let exifStart = -1
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker === 0xda) break
    const size = buf.readUInt16BE(i + 2)
    if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 8) === 'Exif') { exifStart = i + 10; break }
    i += 2 + size
  }
  if (exifStart < 0) return null
  const tiff = buf.subarray(exifStart)
  const le = tiff.toString('latin1', 0, 2) === 'II'
  const u16 = (o) => le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)
  const u32 = (o) => le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)
  const out = {}
  try {
    const ifd0 = u32(4)
    const n = u16(ifd0)
    for (let k = 0; k < n; k++) {
      const e = ifd0 + 2 + k * 12
      const tag = u16(e)
      const type = u16(e + 2)
      const count = u32(e + 4)
      let valOff = e + 8
      if (type === 2 && count > 4) valOff = u32(e + 8)
      if (tag === 0x010e) out.description = tiff.toString('utf8', valOff, valOff + count).replace(/\0+$/, '')
      if (tag === 0x9286) {
        const body = tiff.subarray(valOff + 8, valOff + count)
        out.userComment = body.toString('utf8').replace(/\0+$/, '').trim()
      }
    }
  } catch { return out }
  return out
}

function extractImageParams(buf) {
  if (!buf || !buf.length) return { ok: false, error: '没收到图片数据' }
  const params = {}
  const meta = { keys: [] }
  let format = 'unknown'
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG'
  const isJpeg = buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8
  if (isPng) {
    const texts = readPngTexts(buf)
    meta.keys = Object.keys(texts)
    if (texts.Comment) {
      try {
        const j = JSON.parse(texts.Comment)
        format = 'novelai'
        if (j.prompt) params.prompt = j.prompt
        if (j.uc) params.negative = j.uc
        else if (j.negative_prompt) params.negative = j.negative_prompt
        if (j.steps) params.steps = j.steps
        if (j.scale !== undefined) params.scale = j.scale
        if (j.seed !== undefined) params.seed = j.seed
        if (j.sampler) params.sampler = j.sampler
        if (j.width) params.width = j.width
        if (j.height) params.height = j.height
        if (j.noise_schedule) params.noise_schedule = j.noise_schedule
        if (j.model_name) params.model = j.model_name
      } catch { /* not json */ }
    }
    if (!params.prompt && texts.parameters) {
      const a = parseA1111(texts.parameters)
      Object.keys(a).forEach((k) => { if (a[k] !== undefined && params[k] === undefined) params[k] = a[k] })
      if (a.prompt) format = 'a1111'
    }
    if (!params.prompt && texts.Description) { params.prompt = texts.Description; if (format === 'unknown') format = 'a1111' }
    if (texts.Software) meta.software = texts.Software
    if (texts.Source) meta.source = texts.Source
    if (texts['YesNAI-Provenance']) {
      try {
        const prov = JSON.parse(texts['YesNAI-Provenance'])
        meta.provenance = { job_id: prov.job_id, image_sha256: prov.image_sha256 }
        if (prov.metadata) {
          const m = JSON.parse(Buffer.from(prov.metadata, 'base64').toString('utf8'))
          const gp = m.generation && m.generation.parameters ? m.generation.parameters : null
          if (gp) {
            if (params.seed === undefined && gp.seed !== undefined) params.seed = gp.seed
            if (!params.sampler && gp.sampler) params.sampler = gp.sampler
            if (!params.negative && gp.negative_prompt) params.negative = gp.negative_prompt
            if (!params.model && m.generation.model) params.model = m.generation.model
          }
        }
      } catch { /* ignore */ }
    }
  } else if (isJpeg) {
    const exif = parseJpegExif(buf)
    if (exif) {
      meta.keys = Object.keys(exif)
      if (exif.userComment && /Steps:/i.test(exif.userComment)) {
        const a = parseA1111(exif.userComment); Object.assign(params, a); format = 'a1111'
      } else if (exif.userComment) { params.prompt = exif.userComment; format = 'a1111' }
      if (!params.prompt && exif.description) params.prompt = exif.description
    }
  } else {
    return { ok: false, error: '暂支持 PNG / JPEG（NovelAI、A1111 格式）。其它格式还没支持。' }
  }
  const found = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== '').length
  if (found === 0) return { ok: false, error: '这张图里没读到生成参数（可能被抹掉元数据了）。', meta }
  return { ok: true, format, params, meta }
}

// ---- 图片工具箱（放大 / 增强 / 标注） -------------------------------------

const TOOL_DEFS = {
  upscale: { path: '/ai/upscale', req_type: null },
  emotion: { path: '/ai/augment-image', req_type: 'emotion' },
  'bg-removal': { path: '/ai/augment-image', req_type: 'bg-removal' },
  colorize: { path: '/ai/augment-image', req_type: 'colorize' },
  declutter: { path: '/ai/augment-image', req_type: 'declutter' },
  lineart: { path: '/ai/augment-image', req_type: 'lineart' },
  sketch: { path: '/ai/augment-image', req_type: 'sketch' },
  'wd-tagger': { path: '/ai/annotate-image', req_type: 'wd-tagger' },
  canny: { path: '/ai/annotate-image', req_type: 'canny' },
  depth: { path: '/ai/annotate-image', req_type: 'depth' },
  openpose: { path: '/ai/annotate-image', req_type: 'openpose' },
}

async function requestRaw(path, options = {}) {
  const { method = 'POST', body, token, timeoutMs = 180000, connectTimeoutMs = 20000 } = options
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const controller = new AbortController()
  let phase = 'connect'
  let timer = setTimeout(() => controller.abort(), connectTimeoutMs)
  try {
    const resp = await fetch(baseUrl() + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal })
    clearTimeout(timer)
    phase = 'body'
    timer = setTimeout(() => controller.abort(), timeoutMs)
    const buffer = Buffer.from(await resp.arrayBuffer())
    return { ok: resp.ok, status: resp.status, contentType: resp.headers.get('content-type') || '', buffer }
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || String(error.message || '').includes('abort'))
    const proxyTip = '（若反复超时，建议开启代理后再试，例如 Clash 的“全局/TUN”模式）'
    if (aborted && phase === 'connect') throw new Error(`${path} 连接站点超时（${Math.round(connectTimeoutMs / 1000)}s）—— 网络连不上，请检查网络或代理后重试${proxyTip}`)
    if (aborted) throw new Error(`${path} 等待站点响应超时（${Math.round(timeoutMs / 1000)}s）—— 站点较慢或网络不稳${proxyTip}`)
    throw new Error(`${path} 请求失败：${error && error.message ? error.message : error} —— 网络连不上，请检查网络或代理后重试`)
  } finally {
    clearTimeout(timer)
  }
}

function detectImageSize(buf) {
  if (buf && buf.length > 24 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf && buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const m = buf[i + 1]
      const len = buf.readUInt16BE(i + 2)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      i += 2 + len
    }
  }
  return null
}

/** 极简 ZIP 解包（stored / deflate），够用于站点工具返回的 ZIP。 */
function unzipEntries(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let k = 0; k < count; k++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      let data = buf.subarray(dataStart, dataStart + compSize)
      if (method === 8) { try { data = inflateRawSync(data) } catch { data = Buffer.alloc(0) } }
      out.push({ name, data: Buffer.from(data) })
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function saveBuffer(data, prefix) {
  mkdirSync(MEDIA_DIR, { recursive: true })
  const at = stamp()
  const file = join(MEDIA_DIR, `${prefix}-${at}-${Math.floor(Math.random() * 100000)}.png`)
  writeFileSync(file, data)
  return file
}

async function runImageTool(tool, image, opts) {
  const def = TOOL_DEFS[tool]
  if (!def) return { ok: false, error: '未知工具：' + tool }
  const b64 = String(image || '').replace(/^data:[^,]*,/, '')
  if (!b64) return { ok: false, error: '没有收到图片' }
  const srcBuf = Buffer.from(b64, 'base64')
  const { token } = await credentials()
  let body
  if (tool === 'upscale') {
    const size = detectImageSize(srcBuf) || {}
    body = {
      image: b64,
      width: Number(opts && opts.width) || size.width || 1024,
      height: Number(opts && opts.height) || size.height || 1024,
      scale: Number(opts && opts.scale) === 2 ? 2 : 4,
    }
  } else {
    body = { image: b64, req_type: def.req_type }
  }
  const r = await requestRaw(def.path, { method: 'POST', body, token, timeoutMs: 240000 })
  if (!r.ok) {
    let msg = 'HTTP ' + r.status
    try { msg += ' · ' + describeError(r.status, JSON.parse(r.buffer.toString('utf8'))) } catch { /* ignore */ }
    return { ok: false, error: msg }
  }
  const ct = (r.contentType || '').toLowerCase()
  const isZip = r.buffer.length > 4 && r.buffer[0] === 0x50 && r.buffer[1] === 0x4b
  if (isZip) {
    const entries = unzipEntries(r.buffer) || []
    const files = []
    for (const en of entries) {
      if (/\.(png|jpe?g|webp)$/i.test(en.name)) files.push(saveBuffer(en.data, 'tool-' + tool))
    }
    if (!files.length) return { ok: false, error: '工具返回了 ZIP 但没有图片' }
    return { ok: true, tool, files }
  }
  if (ct.includes('json')) {
    try { return { ok: true, tool, data: JSON.parse(r.buffer.toString('utf8')) } }
    catch { return { ok: true, tool, text: r.buffer.toString('utf8').slice(0, 2000) } }
  }
  const files = [saveBuffer(r.buffer, 'tool-' + tool)]
  return { ok: true, tool, files }
}



/**
 * epay 是「POST 表单跳转」的支付网关：下单后拿到 pay_url + 一组隐藏参数，
 * 前端要构造表单 POST 过去。这里把表单写成本地 HTML，再用系统浏览器打开，
 * 让用户在真实浏览器里完成支付（付款仍在网关页面，插件不碰钱）。
 */
function openPaymentForm(payUrl, params) {
  try {
    const pu = new URL(payUrl)
    if (!/^https?:$/.test(pu.protocol)) throw new Error('支付网关协议异常')
  } catch (error) {
    throw new Error('支付网关地址无效：' + String((error && error.message) || error))
  }
  const inputs = Object.keys(params || {})
    .map((k) => `<input type="hidden" name="${escapeAttr(k)}" value="${escapeAttr(params[k])}">`)
    .join('\n')
  const html = `<!doctype html><meta charset="utf-8"><title>正在跳转支付…</title>
<body style="font-family:system-ui;padding:32px;color:#333">
<p>正在跳转到支付页面，如果没有自动跳转，请点下面按钮。</p>
<form id="pay" action="${escapeAttr(payUrl)}" method="POST" target="_self">
${inputs}
<button type="submit" style="padding:10px 22px;font-size:15px;border-radius:8px;border:1px solid #888;cursor:pointer">前往支付</button>
</form>
<script>document.getElementById('pay').submit()</script>
</body>`
  try { cleanupPayFiles(60 * 60 * 1000) } catch { /* ignore */ }
  mkdirSync(DATA_DIR, { recursive: true })
  const file = join(DATA_DIR, 'pay-' + Date.now() + '.html')
  writeFileSync(file, html, 'utf8')
  const opener = process.platform === 'win32'
    ? { cmd: 'cmd', args: ['/c', 'start', '', file] }
    : process.platform === 'darwin'
      ? { cmd: 'open', args: [file] }
      : { cmd: 'xdg-open', args: [file] }
  spawn(opener.cmd, opener.args, { detached: true, stdio: 'ignore' }).unref()
  return file
}

const ERROR_HINTS = {
  INVALID_API_TOKEN: 'API Key 无效或已停用（网站控制台 → API 密钥）',
  MODEL_NOT_ALLOWED: '这把 API Key 的模型白名单里没有该模型',
  API_TOKEN_DAILY_GEMS_LIMIT_EXCEEDED: '这把 Key 今日 Gems 额度已用尽',
  API_TOKEN_TOTAL_GEMS_LIMIT_EXCEEDED: '这把 Key 的 Gems 总额度已用尽',
  TOKEN_FREE_ONLY: '这把 Key 只允许免费出图，付费请求被拒',
  INSUFFICIENT_GEMS: '账户 Gems 余额不足',
}

function describeError(status, data) {
  const errObj = data && typeof data === 'object' ? data.error : null
  const code = (errObj && (errObj.code || errObj.type)) || (data && data.code) || ''
  const msg = (errObj && errObj.message) || (data && data.message) || ''
  const parts = [`HTTP ${status}`]
  if (code) parts.push(String(code))
  const hint = code ? ERROR_HINTS[code] : ''
  if (hint) parts.push(hint)
  else if (status === 502 || status === 503 || status === 504) parts.push('网站上游暂时不可用，过一会儿再试')
  else if (status === 429) parts.push('被限流：请求太频繁或这把 Key 今日额度用尽，稍等再试')
  if (msg) parts.push(String(msg).slice(0, 300))
  return parts.join(' · ')
}

/**
 * 带一次重试的请求包装：只对「连接层抖动」（fetch failed / ECONNRESET）重试，
 * 不改写 HTTP 语义（502/401 这类服务端明确答复照原样返回）。新建 Key 那种
 * 非幂等调用显式传 retries: 0，避免一次抖动建出两把。
 */
async function request(path, options = {}) {
  const retries = options.retries === undefined ? 1 : Math.max(0, Number(options.retries) || 0)
  let attempt = 0
  for (;;) {
    try {
      return await requestOnce(path, options)
    } catch (error) {
      const message = String((error && error.message) || error)
      const transient = message.includes('请求失败') || message.includes('fetch failed') || message.includes('ECONNRESET') || message.includes('socket hang up')
      if (attempt >= retries || !transient) throw error
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
    }
  }
}

async function requestOnce(path, options = {}) {
  const { method = 'GET', body, token, timeoutMs = 180000, connectTimeoutMs = 20000, headers: extraHeaders } = options
  const headers = { ...(extraHeaders || {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const controller = new AbortController()
  let phase = 'connect'
  let timer = setTimeout(() => controller.abort(), connectTimeoutMs)
  try {
    const resp = await fetch(baseUrl() + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    // 收到响应头：连接已建立，切到「等待响应体」的时限
    clearTimeout(timer)
    phase = 'body'
    timer = setTimeout(() => controller.abort(), timeoutMs)
    const text = await resp.text()
    let data = null
    if (text !== '') {
      try { data = JSON.parse(text) } catch { data = null }
    }
    return { ok: resp.ok, status: resp.status, data, text }
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || String(error.message || '').includes('abort'))
    const proxyTip = '（若反复超时，建议开启代理后再试，例如 Clash 的“全局/TUN”模式）'
    if (aborted && phase === 'connect') {
      throw new Error(`${path} 连接站点超时（${Math.round(connectTimeoutMs / 1000)}s）—— 网络连不上，请检查网络或代理后重试${proxyTip}`)
    }
    if (aborted) {
      throw new Error(`${path} 等待站点响应超时（${Math.round(timeoutMs / 1000)}s）—— 站点较慢或网络不稳${proxyTip}`)
    }
    throw new Error(`${path} 请求失败：${error && error.message ? error.message : error} —— 网络连不上，请检查网络或代理后重试`)
  } finally {
    clearTimeout(timer)
  }
}

/** 网站的返回形状统一剥一层：{message,data:…} → data。 */
function unwrap(data) {
  if (data && typeof data === 'object' && 'data' in data && !('error' in data)) return data.data
  return data
}

/** 取二进制（画廊缩略图/原图代理用），不走 JSON 解析。 */
async function requestBinary(path, options = {}) {
  const { token, timeoutMs = 30000 } = options
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(baseUrl() + path, { headers, signal: controller.signal })
    const buffer = Buffer.from(await resp.arrayBuffer())
    return {
      ok: resp.ok,
      status: resp.status,
      contentType: resp.headers.get('content-type') || 'application/octet-stream',
      buffer,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 账户总览：余额 + 图包额度规则 + 自动 Key 的用量。 */
async function runAccount() {
  const account = await fetchAccount()
  const out = { ok: true, account: account.account || null, balance: account.balance || null }
  if (account.selfError) out.selfError = account.selfError
  try {
    const packs = await sessionRequest('/api/ynai/image-packs', { timeoutMs: 30000 })
    if (packs.ok) out.packs = unwrap(packs.data) || packs.data
    else out.packsError = describeError(packs.status, packs.data)
  } catch (error) { out.packsError = String((error && error.message) || error) }
  try {
    const tokens = await listTokens()
    const mine = tokens.find((t) => t && t.name === KEY_NAME && t.status === 'active')
    out.autoKey = mine
      ? {
          id: mine.id,
          used_gems_today: mine.used_gems_today,
          used_gems_total: mine.used_gems_total,
          daily_gems_limit: mine.daily_gems_limit,
          total_gems_limit: mine.total_gems_limit,
          max_gems_per_request: mine.max_gems_per_request,
          allowed_models: mine.allowed_models,
        }
      : null
    out.tokenCount = tokens.length
  } catch (error) { out.tokenListError = String((error && error.message) || error) }
  return out
}

/** 站内画廊（公开作品）：支持 offset / limit / rating。 */
async function runGallery(query) {
  const limit = Math.min(48, Math.max(1, Number(query.limit) || 12))
  const offset = Math.max(0, Number(query.offset) || 0)
  const rating = String(query.rating || '').trim()
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  if (rating !== '') params.set('rating', rating)
  const r = await sessionRequest('/api/ynai/gallery/artworks?' + params.toString(), { timeoutMs: 40000 })
  if (!r.ok) return { ok: false, error: describeError(r.status, r.data) }
  const data = unwrap(r.data) || {}
  const items = Array.isArray(data.items) ? data.items : []
  return {
    ok: true,
    total: Number(data.total || items.length),
    offset,
    limit,
    rating,
    items: items.map((item) => ({
      id: item.public_id,
      title: item.title || '',
      rating: item.rating || '',
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
      author: item.author ? (item.author.display_name || item.author.username || '') : '',
      width: item.width,
      height: item.height,
      views: item.view_count,
      likes: item.like_count,
      thumb: item.thumbnail_url || '',
      media: item.media_url || '',
      published: item.published_at || '',
    })),
  }
}

/** Gems 流水。 */
async function runLedger(query) {
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 12))
  const r = await sessionRequest('/api/ynai/wallet/ledger?limit=' + limit, { timeoutMs: 30000 })
  if (!r.ok) return { ok: false, error: describeError(r.status, r.data) }
  const data = unwrap(r.data) || {}
  const items = Array.isArray(data.items) ? data.items : []
  return {
    ok: true,
    items: items.map((item) => ({
      id: item.id,
      type: item.event_type || '',
      amount: item.amount_gems,
      balanceAfter: item.balance_after_gems,
      note: item.note || '',
      at: item.created_at || '',
    })),
  }
}

/** 站内活动（公益站常有主题活动），只读。 */
async function runActivities(query) {
  const limit = Math.min(30, Math.max(1, Number(query.limit) || 10))
  const r = await sessionRequest('/api/ynai/activities?limit=' + limit, { timeoutMs: 30000 })
  if (!r.ok) return { ok: false, error: describeError(r.status, r.data) }
  const data = unwrap(r.data) || {}
  const items = Array.isArray(data.items) ? data.items : []
  return {
    ok: true,
    items: items.map((a) => ({
      id: a.id,
      title: a.title || '',
      summary: a.summary || '',
      description: a.description || '',
      status: a.status || '',
      phase: a.phase || '',
      startsAt: a.starts_at || '',
      endsAt: a.ends_at || '',
      enrolled: a.enrolled === true,
      awardedGems: a.awarded_gems,
    })),
  }
}

/** 充值信息（是否开启在线充值、支付方式、金额档、比例）。 */
async function runTopupInfo() {
  const r = await sessionRequest('/api/ynai/payments/topup-info', { timeoutMs: 25000 })
  if (!r.ok) return { ok: false, error: describeError(r.status, r.data) }
  return { ok: true, info: unwrap(r.data) || r.data }
}

/** 充值报价：给定金额（分）估算 Gems。 */
async function runTopupQuote(moneyCents) {
  const cents = Math.round(Number(moneyCents))
  if (!Number.isFinite(cents) || cents <= 0) return { ok: false, error: '金额无效' }
  const r = await sessionRequest('/api/ynai/payments/quote', { method: 'POST', body: { money_cents: cents }, timeoutMs: 25000 })
  if (!r.ok) return { ok: false, error: describeError(r.status, r.data) }
  return { ok: true, quote: unwrap(r.data) || r.data }
}

/** 下单并打开支付页（epay 表单跳转）。钱在网关页面付，插件只负责发起。 */
async function runCreatePay(moneyCents, method) {
  const cents = Math.round(Number(moneyCents))
  if (!Number.isFinite(cents) || cents <= 0) return { ok: false, error: '金额无效' }
  const payMethod = String(method || 'alipay')
  const r = await sessionRequest('/api/ynai/payments/epay/order', {
    method: 'POST',
    body: { money_cents: cents, payment_method: payMethod },
    timeoutMs: 30000,
  })
  if (!r.ok) return { ok: false, error: describeError(r.status, r.data) }
  const order = unwrap(r.data) || r.data || {}
  if (!order.pay_url || !order.params) return { ok: false, error: '下单成功但没拿到支付地址' }
  const file = openPaymentForm(order.pay_url, order.params)
  return {
    ok: true,
    orderId: order.id,
    tradeNo: order.trade_no,
    gems: order.gems,
    moneyCents: order.money_cents,
    expiresAtUnix: order.expires_at_unix,
    openedFile: file,
  }
}

/** 买图包：{packs: n}，直接扣 Gems 换图包张数。 */
async function runBuyPacks(packs) {
  const n = Math.round(Number(packs))
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: '图包数量无效' }
  const r = await sessionRequest('/api/ynai/image-packs/purchase', {
    method: 'POST',
    body: { packs: n },
    timeoutMs: 30000,
    retries: 0, // 花钱的操作不重试，避免重复购买
  })
  if (!r.ok) return { ok: false, error: describeError(r.status, r.data) }
  const data = unwrap(r.data) || r.data || {}
  return { ok: true, result: data }
}


async function login(username, password) {
  const r = await request('/api/ynai/auth/login', {
    method: 'POST',
    body: { username, password },
    timeoutMs: 30000,
  })
  const payload = unwrap(r.data) || {}
  const token = payload.access_token
  if (!r.ok || !token) throw new Error('登录失败：' + describeError(r.status, r.data))
  loginCache[activeSiteKey()] = { token, at: Date.now() }
  return token
}

function siteCache() {
  const id = activeSiteKey()
  if (!loginCache[id]) loginCache[id] = { token: '', at: 0 }
  return loginCache[id]
}

async function ensureLoginToken() {
  const s = site()
  const label = SITES[activeSiteKey()].label
  if (!s.username || !s.password) throw new Error(`${label} 账号密码没填全（设置 → Rinko NAI → 登录）`)
  const cache = siteCache()
  if (cache.token !== '' && Date.now() - cache.at < 24 * 60 * 60 * 1000) return cache.token
  return login(s.username, s.password)
}

/** 清掉当前站点的登录缓存。 */
function resetLogin() { loginCache[activeSiteKey()] = { token: '', at: 0 } }

/**
 * 带登录态的请求：遇到 401（缓存的登录 token 提前失效）自动重新登录并重试一次，
 * 免去用户手动"重新获取 Key"才能恢复账号信息。
 */
async function sessionRequest(path, options = {}) {
  let session = await ensureLoginToken()
  let r = await request(path, Object.assign({}, options, { token: session }))
  if (!r.ok && r.status === 401) {
    resetLogin()
    session = await ensureLoginToken()
    r = await request(path, Object.assign({}, options, { token: session }))
  }
  return r
}

async function fetchAccount() {
  const out = {}
  try {
    const self = await sessionRequest('/api/ynai/user/self', { timeoutMs: 20000 })
    if (self.ok) out.account = unwrap(self.data) || self.data
    else out.selfError = describeError(self.status, self.data)
  } catch (error) { out.selfError = String((error && error.message) || error) }
  try {
    const balance = await sessionRequest('/api/ynai/user/balance', { timeoutMs: 20000 })
    if (balance.ok) out.balance = unwrap(balance.data) || balance.data
    else out.balanceError = describeError(balance.status, balance.data)
  } catch (error) { out.balanceError = String((error && error.message) || error) }
  return out
}

async function listTokens() {
  const r = await sessionRequest('/api/ynai/tokens', { timeoutMs: 20000 })
  if (!r.ok) throw new Error('读 Key 列表失败：' + describeError(r.status, r.data))
  const arr = unwrap(r.data)
  return Array.isArray(arr) ? arr : []
}

/**
 * 拿一把可用的 ynai- Key：
 *   1. 手动填过 Key → 直接用；
 *   2. 登录态下找同名 active Key → POST /tokens/{id}/key 重新取明文；
 *   3. 没有 → POST /tokens 新建一把（免费，不扣费）。
 * 自动取到的 Key 会存进 config（keySource='auto'），之后重启不用重新登录。
 */
async function obtainApiKey() {
  const s = site()
  if (s.apiKey !== '') {
    return { token: s.apiKey, kind: s.keySource === 'auto' ? 'auto-key' : 'api-key' }
  }
  const tokens = await listTokens()
  const mine = tokens.find((t) => t && t.name === KEY_NAME && t.status === 'active')
  let key = ''
  let r
  if (mine) {
    r = await sessionRequest(`/api/ynai/tokens/${mine.id}/key`, { method: 'POST', timeoutMs: 20000 })
    if (r.ok) {
      const payload = unwrap(r.data) || {}
      key = payload.key || payload.token || ''
    }
    if (key === '') throw new Error('重新取 Key 失败：' + describeError(r.status, r.data))
  } else {
    r = await sessionRequest('/api/ynai/tokens', {
      method: 'POST',
      body: { name: KEY_NAME },
      timeoutMs: 20000,
      // 建 Key 不是幂等操作：一次连接抖动就重发会多建一把同名 Key，这里不重试
      retries: 0,
    })
    if (!r.ok) throw new Error('自动创建 Key 失败：' + describeError(r.status, r.data))
    const payload = unwrap(r.data) || {}
    key = payload.token || payload.key || ''
  }
  if (key === '') throw new Error('网站没返回 Key 明文')
  s.apiKey = key
  s.keySource = 'auto'
  saveConfig()
  return { token: key, kind: 'auto-key' }
}

/** 出图凭据：手动 Key 优先；否则登录链路自动建/取。 */
async function credentials() {
  const s = site()
  if (s.apiKey !== '') {
    return { token: s.apiKey, kind: s.keySource === 'auto' ? 'auto-key' : 'api-key' }
  }
  if (s.username && s.password) return obtainApiKey()
  throw new Error(`${SITES[activeSiteKey()].label} 还没有配置凭据：设置 → Rinko NAI 用账号密码登录（会自动建 Key），或手动填 ynai- API Key`)
}

/** 自动 Key 失效时的恢复：清掉旧 Key → 重新登录 → 重新取/建。 */
async function recoverAutoKey() {
  const s = site()
  loginCache[activeSiteKey()] = { token: '', at: 0 }
  if (s.keySource === 'auto') s.apiKey = ''
  else throw new Error('手动填的 Key 失效了，请到设置页换一把')
  saveConfig()
  return obtainApiKey()
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

/**
 * 当前站点可用 Key 池（主 Key + 额外 Key，去重）。
 * 站点对单 Key 有并发限制，多 Key 时每把 Key 同时只跑一张 → 靠 Key 数提升并发。
 */
async function keyPool() {
  const s = site()
  const list = []
  const push = (k, kind) => {
    const v = String(k || '').trim()
    if (v && !list.some((x) => x.token === v)) list.push({ token: v, kind: kind || 'api-key' })
  }
  if (s.apiKey) push(s.apiKey, s.keySource === 'auto' ? 'auto-key' : 'api-key')
  for (const k of (Array.isArray(s.apiKeys) ? s.apiKeys : [])) push(k, 'api-key')
  if (list.length === 0) {
    if (s.username && s.password) {
      const c = await obtainApiKey()
      push(c.token, c.kind)
    } else {
      throw new Error(`${SITES[activeSiteKey()].label} 还没有配置凭据：设置 → Rinko NAI 用账号密码登录（会自动建 Key），或手动填 ynai- API Key`)
    }
  }
  return list
}

/** 一键多 Key：登录态下为当前账号批量新建 N 把 API Key，并入多 Key 池。 */
async function mintKeys(count) {
  const s = site()
  const n = Math.max(1, Math.min(10, Math.round(Number(count) || 4)))
  const created = []
  const errors = []
  for (let i = 0; i < n; i++) {
    try {
      const r = await sessionRequest('/api/ynai/tokens', {
        method: 'POST',
        body: { name: `${KEY_NAME}-${Date.now().toString(36)}-${i}` },
        timeoutMs: 20000,
        retries: 0,
      })
      if (!r.ok) { errors.push(describeError(r.status, r.data)); continue }
      const payload = unwrap(r.data) || {}
      const key = payload.token || payload.key || ''
      if (key) created.push(key)
      else errors.push('站点没返回 Key 明文')
    } catch (e) { errors.push(String((e && e.message) || e)) }
  }
  const existing = Array.isArray(s.apiKeys) ? s.apiKeys.slice() : []
  for (const k of created) if (k !== s.apiKey && existing.indexOf(k) < 0) existing.push(k)
  s.apiKeys = existing
  saveConfig()
  return {
    ok: created.length > 0,
    created: created.length,
    extraKeys: s.apiKeys.length,
    masked: s.apiKeys.map(masked),
    errors: errors.length ? errors : undefined,
  }
}

// ---- 出图 ---------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function buildPayload(args) {
  const rawPrompt = String((args && args.prompt) || '').trim()
  if (rawPrompt === '') throw new Error('prompt 是空的')
  const suffix = String(config.promptSuffix || '').trim()
  const input = suffix === '' ? rawPrompt : rawPrompt + ', ' + suffix
  const negative = String(
    args && args.negative !== undefined && String(args.negative).trim() !== ''
      ? args.negative
      : config.negativePrompt || '',
  ).trim()
  const seedArg = args && args.seed !== undefined && args.seed !== null && String(args.seed).trim() !== ''
    ? Math.floor(Number(args.seed))
    : NaN
  const seed = Number.isFinite(seedArg) && seedArg >= 0 ? seedArg : Math.floor(Math.random() * 4294967295)
  const payload = {
    input,
    model: String((args && args.model) || config.model || 'nai-diffusion-4-5-full'),
    action: 'generate',
    parameters: {
      width: clampInt(args && args.width, 64, 1600, clampInt(config.width, 64, 1600, 832)),
      height: clampInt(args && args.height, 64, 1600, clampInt(config.height, 64, 1600, 1216)),
      steps: clampInt(args && args.steps, 1, 50, clampInt(config.steps, 1, 50, 28)),
      n_samples: clampInt(args && args.count, 1, 4, 1),
      sampler: String((args && args.sampler) || config.sampler || 'k_euler_ancestral'),
      scale: Number.isFinite(Number(args && args.scale)) ? Number(args.scale) : Number(config.scale) || 5,
      seed,
      negative_prompt: negative,
      noise_schedule: String((args && args.noise_schedule) || config.noise_schedule || 'karras'),
      qualityToggle: config.qualityToggle !== false,
      ucPreset: Number(config.ucPreset) || 0,
    },
  }
  return { payload, seed }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function safeName(value) {
  const text = String(value || '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return text.slice(0, 48)
}

/** 按文件头嗅探图片扩展名（不同模型可能回 png/jpg/webp）。 */
function sniffImageExt(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (buf.length >= 6 && buf.toString('latin1', 0, 3) === 'GIF') return 'gif'
  return 'png'
}

function writeImages(images, prefix) {
  mkdirSync(MEDIA_DIR, { recursive: true })
  const at = stamp()
  const paths = []
  images.forEach((b64, index) => {
    const buf = Buffer.from(String(b64), 'base64')
    const ext = sniffImageExt(buf)
    let file = join(MEDIA_DIR, `${prefix}-${at}-${index}.${ext}`)
    let n = 0
    // 同一秒内重复出图（批量循环/快速重试）别让后一张盖掉前一张
    while (existsSync(file)) { n += 1; file = join(MEDIA_DIR, `${prefix}-${at}-${index}-r${n}.${ext}`) }
    writeFileSync(file, buf)
    paths.push(file)
  })
  return paths
}

function parseImages(data) {
  // 2026-11-20 实测：出图成功时网站回 job.status = "charged"（不是 "succeeded"），
  // 原版死等 "succeeded" 导致 200 也被当失败。改成：有图就算成功，缺图才报错。
  const job = (data && data.job) || {}
  const images = Array.isArray(data && data.images) ? data.images : []
  if (images.length === 0) {
    throw new Error('这次没出成功：' + JSON.stringify({ status: job.status, cost_gems: job.cost_gems }).slice(0, 300))
  }
  return { job, images }
}

/** 网站语义错误（JSON、带 code/message）→ 不盲目重试；空体 / CDN "error code: xxx" → 算抽风，可重试。 */
function isStructuredError(r) {
  const d = r && r.data
  if (d && typeof d === 'object') return true
  const t = String((r && r.text) || '').trim()
  if (t === '') return false
  if (/^error code:/i.test(t)) return false
  return true
}

async function runGenerate(args) {
  if (args && args.quote === true) {
    const { token, kind } = await credentials()
    const { payload } = buildPayload(args)
    const r = await request('/ai/generate-image/quote', { method: 'POST', body: payload, token, timeoutMs: 30000 })
    if (!r.ok && r.status === 401 && kind === 'auto-key') {
      const recovered = await recoverAutoKey()
      const r2 = await request('/ai/generate-image/quote', { method: 'POST', body: payload, token: recovered.token, timeoutMs: 30000 })
      if (!r2.ok) throw new Error('询价失败：' + describeError(r2.status, r2.data))
      return { ok: true, quote: unwrap(r2.data) || r2.data || {}, model: payload.model }
    }
    if (!r.ok) throw new Error('询价失败：' + describeError(r.status, r.data))
    return { ok: true, quote: unwrap(r.data) || r.data || {}, model: payload.model }
  }
  const pool = await keyPool()
  const { payload, seed } = buildPayload(args)
  // 免费档 / 单 Key 都只能一张一张出；多 Key 时每把 Key 同时跑一张，按 Key 数并发。
  const wanted = clampInt(args && args.count, 1, 4, 1)
  const prefix = safeName(args && args.name) || 'rinko'
  const paths = []
  let lastJob = null
  let lastFormat = 'png'
  let totalCost = 0
  let firstError = null
  const baseSeed = Number(payload.parameters.seed) || 0
  // 单张生成：给定 Key，成功返回 {job,images,format}，失败抛错。幂等键每张复用。
  async function generateOne(index, keyObj) {
    const p = JSON.parse(JSON.stringify(payload))
    p.parameters.n_samples = 1
    p.parameters.seed = (baseSeed + index) % 4294967295
    const idemKey = randomUUID()
    let key = keyObj.token
    const call = (retries) => request('/v1/nai/generate-image', {
      method: 'POST',
      body: p,
      token: key,
      timeoutMs: 180000,
      retries,
      headers: { 'Idempotency-Key': idemKey },
    })
    let r = await call(1)
    // 自动 Key 失效 → 重新登录换一把（仅对 auto-key）
    if (!r.ok && r.status === 401 && keyObj.kind === 'auto-key') {
      const recovered = await recoverAutoKey()
      key = recovered.token
      keyObj.token = key
      if (recovered.kind) keyObj.kind = recovered.kind
      r = await call(0)
    }
    // 429 限流 → 退避重试一次
    if (!r.ok && r.status === 429) { await sleep(2500); r = await call(0) }
    if (!r.ok) throw new Error('生成失败：' + describeError(r.status, r.data))
    const { job, images } = parseImages(r.data)
    return { job, images, format: (r.data && r.data.image_format) || 'png' }
  }

  // 按「波次」并发：每波最多 = Key 数（一把 Key 同时只跑一张）。
  for (let start = 0; start < wanted; start += pool.length) {
    const wave = []
    for (let j = 0; j < pool.length && start + j < wanted; j++) wave.push({ index: start + j, keyObj: pool[j % pool.length] })
    const settled = await Promise.allSettled(wave.map((w) => generateOne(w.index, w.keyObj)))
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        const { job, images, format } = s.value
        if (job) lastJob = job
        lastFormat = format
        totalCost += Number((job && job.cost_gems) || 0)
        try { paths.push(...writeImages(images, prefix)) } catch (e) { if (!firstError) firstError = e }
      } else if (!firstError) firstError = s.reason
    }
    // 只有单 Key 时，失败一次就别继续硬打（省时间）
    if (firstError && pool.length === 1) break
  }
  if (paths.length === 0) throw (firstError || new Error('生成失败'))
  const result = {
    ok: true,
    paths,
    count: paths.length,
    job: lastJob,
    job_id: String((lastJob && lastJob.job_id) || ''),
    cost_gems: totalCost,
    model: payload.model,
    seed,
    image_format: lastFormat,
    authKind: (pool[0] && pool[0].kind) || 'api-key',
    keysUsed: pool.length,
    mediaDir: MEDIA_DIR,
  }
  if (firstError) result.partial = String((firstError && firstError.message) || firstError)
  lastGeneration = {
    at: new Date().toISOString(),
    paths,
    job_id: result.job_id,
    cost_gems: result.cost_gems,
    model: result.model,
  }
  return result
}

/** 网站模型表缓存（5 分钟）。/v1/models 不需要鉴权，失败时回退到静态清单。 */
let modelCache = { at: 0, list: [] }
const FALLBACK_MODELS = [
  'nai-diffusion-5-full',
  'nai-diffusion-5-curated',
  'nai-diffusion-5-full-inpainting',
  'nai-diffusion-5-curated-inpainting',
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-4-5-full-inpainting',
  'nai-diffusion-4-5-curated-inpainting',
  'nai-diffusion-4-full',
  'nai-diffusion-4-curated',
  'nai-diffusion-4-full-inpainting',
  'nai-diffusion-4-curated-inpainting',
  'nai-diffusion-3',
  'nai-diffusion-3-furry',
  'nai-diffusion-3-inpainting',
  'nai-diffusion-3-furry-inpainting',
]

async function listModels() {
  if (modelCache.list.length > 0 && Date.now() - modelCache.at < 5 * 60 * 1000) return modelCache.list
  try {
    const r = await request('/v1/models', { timeoutMs: 15000 })
    if (r.ok && r.data && Array.isArray(r.data.data)) {
      const list = r.data.data.map((item) => item.id).filter(Boolean)
      if (list.length > 0) { modelCache = { at: Date.now(), list }; return list }
    }
  } catch { /* 回退 */ }
  return modelCache.list.length > 0 ? modelCache.list : FALLBACK_MODELS
}

async function runStatus() {
  const s = site()
  const out = {
    ok: true,
    site: activeSiteKey(),
    siteLabel: SITES[activeSiteKey()].label,
    baseUrl: baseUrl(),
    hasKey: s.apiKey !== '',
    keySource: s.keySource,
    loggedIn: Boolean(s.username && s.password),
    username: s.username || '',
    model: config.model,
    mediaDir: MEDIA_DIR,
    lastGeneration,
  }
  try {
    const models = await request('/v1/models', { timeoutMs: 20000 })
    if (models.ok && models.data && Array.isArray(models.data.data)) {
      out.models = models.data.data.map((item) => item.id)
      out.modelsOk = true
    } else {
      out.modelsOk = false
      out.modelsError = describeError(models.status, models.data)
    }
  } catch (error) {
    out.modelsOk = false
    out.modelsError = String((error && error.message) || error)
  }
  if (s.apiKey !== '') {
    try {
      const { payload } = buildPayload({ prompt: 'quote check' })
      const quote = await request('/ai/generate-image/quote', {
        method: 'POST',
        body: payload,
        token: s.apiKey,
        timeoutMs: 25000,
      })
      const qcode = (quote.data && quote.data.error && (quote.data.error.code || quote.data.error.type)) || ''
      if (quote.ok) {
        out.keyValid = true
        const q = unwrap(quote.data) || quote.data || {}
        out.quoteSample = { total_gems: q.total_gems, balance_gems: q.balance_gems, pricing_mode: q.pricing_mode }
      } else if (quote.status === 401 || qcode === 'INVALID_API_TOKEN') {
        out.keyValid = false
        out.keyError = describeError(quote.status, quote.data)
      } else {
        // Key 被接受，只是该模型/参数/额度不可用（如 403 MODEL_NOT_ALLOWED），不算 Key 坏
        out.keyValid = true
        out.keyWarning = describeError(quote.status, quote.data)
      }
    } catch (error) {
      // 网络异常不能判定 Key 坏，标为“未知”
      out.keyValid = undefined
      out.keyError = String((error && error.message) || error)
    }
  }
  if (s.username && s.password) {
    try {
      const account = await fetchAccount()
      if (account.account) out.account = account.account
      if (account.balance) out.balance = account.balance
      if (account.selfError) out.selfError = account.selfError
      try {
        const tokens = await listTokens()
        out.tokenCount = tokens.length
        const mine = tokens.find((t) => t && t.name === KEY_NAME && t.status === 'active')
        out.autoKeyRecord = mine
          ? { id: mine.id, status: mine.status, used_gems_today: mine.used_gems_today, allowed_models: mine.allowed_models }
          : null
      } catch (error) {
        out.tokenListError = String((error && error.message) || error)
      }
    } catch (error) {
      out.loginError = String((error && error.message) || error)
    }
  }
  return out
}

// ---- 小工具 -------------------------------------------------------------

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolvePromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolvePromise({})
      try { resolvePromise(JSON.parse(text)) } catch { resolvePromise({}) }
    })
    req.on('error', () => resolvePromise({}))
  })
}

// ---- 插件入口 -----------------------------------------------------------

export function apply(ctx) {
  try { mkdirSync(DATA_DIR, { recursive: true }) } catch { /* ignore */ }
  loadConfig()

  const log = (message) => { try { ctx.logger?.info?.(`[rinko-nai] ${message}`) } catch { /* ignore */ } }

  // ---- 0. 系统提示：出图后请在对话里内嵌显示 ----
  // systemPrompt 走可选作用域注入：headless/tui 没有该服务时不报错，只是不加这条提示。
  try {
    const registerPrompt = (sc) => {
      sc.effect(() => {
        try {
          return sc.systemPrompt.context({
            name: 'rinko-nai:inline-display',
            order: 205,
            text: () => '当调用工具 rinko_nai_image 成功并返回图片路径后，务必在回复中用 Markdown 图片语法把图片直接内嵌显示（例如：![生成图](<绝对路径>)；把路径里的反斜杠换成 /；含空格的路径用尖括号包起来）。不要只发文件卡片或纯路径文字——用户要的是在对话里直接看到图。',
          })
        } catch { return () => {} }
      })
    }
    if (typeof ctx.inject === 'function') ctx.inject(['systemPrompt'], registerPrompt)
    else if (ctx.systemPrompt) registerPrompt(ctx)
  } catch { /* ignore */ }

  // ---- 1. 工具 ---------------------------------------------------------

  try {
    ctx.tools.register(defineTool({
      name: 'rinko_nai_image',
      description:
        '用 YesNAI 画图（主站 nai.rinko.ai / 姊妹站 ynai.rinko.ai，默认用设置页当前激活的站点）。提示词用逗号分隔的英文 tag，先把角色定妆串（发色、耳尾、服装、体型）写全，' +
        '再写画面与镜头。生成后图片存成本地 PNG，返回绝对路径 —— 之后用 present（Web）或 dsh_im_return_file（IM）把文件发给对方。' +
        '传 quote=true 只询价不出图（免费），用来确认这一张要花多少 Gems。' +
        '凭据在 设置 → Rinko NAI：账号密码登录会自动建 Key；默认参数也在那里配。一次出 1–4 张。',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: '正面提示词。英文 tag，逗号分隔：`1girl, solo, silver hair, fox ears, purple kimono, ...`',
        },
        negative: { type: 'string', description: '负面提示词；留空用设置页的默认负面词。' },
        model: {
          type: 'string',
          description: '模型 ID：nai-diffusion-4-5-full / nai-diffusion-4-5-curated / nai-diffusion-4-full / nai-diffusion-3-furry 等；留空用设置页默认。',
        },
        width: { type: 'number', description: '宽（64–1600），留空用设置页默认。' },
        height: { type: 'number', description: '高（64–1600），留空用设置页默认。' },
        count: { type: 'number', description: '一次出几张（1–4），默认 1。n>1 会按张计费。' },
        steps: { type: 'number', description: '采样步数（1–50），留空用设置页默认。' },
        scale: { type: 'number', description: '提示词引导强度（CFG），常用 3–7，留空用设置页默认。' },
        sampler: { type: 'string', description: '采样器，常用 k_euler_ancestral / k_dpmpp_2m；留空用设置页默认。' },
        seed: { type: 'number', description: '随机种子；留空随机（结果里会回填实际使用的种子）。' },
        name: { type: 'string', description: '文件名前缀（可选），方便在 media/rinko-nai 里认出来。' },
        quote: { type: 'boolean', description: 'true = 只询价不出图。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            paths: { type: 'array', items: { type: 'string' } },
          },
        },
        render(_args, value) {
          const v = value && typeof value === 'object' ? value : {}
          if (v.ok === false) return [{ type: 'text', text: '✗ ' + String(v.message || '没出成') }]
          if (v.quote && typeof v.quote === 'object') {
            const cost = v.quote.total_gems !== undefined ? v.quote.total_gems : (v.quote.job && v.quote.job.cost_gems)
            return [{ type: 'text', text: `✓ 报价 ${cost === undefined ? '（接口没给数字）' : cost + ' Gems'} · ${v.model || ''}` }]
          }
          const paths = Array.isArray(v.paths) ? v.paths : []
          const lines = [`✓ 出了 ${paths.length} 张 · ${v.cost_gems || 0} Gems · seed ${v.seed} · ${v.model || ''}${v.job_id ? ' · ' + v.job_id : ''}`]
          for (const p of paths) lines.push('  ' + p)
          if (v.partial) lines.push('⚠ 中途有失败（已出的保留）：' + v.partial)
          // 给出可直接粘贴的 Markdown 图片语法，模型照抄即可在对话里内嵌显示
          if (paths.length > 0) {
            lines.push('对话内直接显示请原样使用：')
            for (const p of paths) lines.push('![生成图](<' + String(p).replace(/\\/g, '/') + '>)')
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        try {
          return await runGenerate(args || {})
        } catch (error) {
          return { ok: false, message: String((error && error.message) || error) }
        }
      },
    }))
    log('工具 rinko_nai_image 已挂上')
  } catch (error) {
    log('注册 rinko_nai_image 失败：' + String((error && error.message) || error))
  }

  try {
    ctx.tools.register(defineTool({
      name: 'rinko_nai_status',
      description:
        '查 Rinko NAI 出图通道的状态：可用模型列表、凭据与账户（Key 是否有效、Gems 余额、图包张数、自动建的 Key 的今日用量）、' +
        '最近一次生成记录。出图报错先跑它排障。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' } } },
        render(_args, value) {
          const v = value && typeof value === 'object' ? value : {}
          if (v.ok === false) return [{ type: 'text', text: '✗ ' + String(v.message || '状态读取失败') }]
          const lines = []
          lines.push(`通道：${v.baseUrl || ''}`)
          lines.push(`凭据：${v.hasKey ? (v.keySource === 'auto' ? '自动 Key（登录建的）' : '手动 Key') : '无 Key'}${v.loggedIn ? ` · 已登录 ${v.username}` : ''}${v.keyValid === true ? ' · Key 有效' : v.keyValid === false ? ' · Key 无效：' + (v.keyError || '') : ''}`)
          if (v.account) lines.push(`账户：${v.account.username || ''} · Gems ${v.account.balance_gems ?? '?'} · 图包 ${v.account.image_pack_credits ?? '?'} 张 · 累计请求 ${v.account.request_count ?? '?'}`)
          if (v.selfError) lines.push('账户读取失败：' + v.selfError)
          if (v.modelsOk === true) lines.push(`模型 ${(v.models || []).length} 个：${(v.models || []).slice(0, 8).join(', ')}${(v.models || []).length > 8 ? ' …' : ''}`)
          else lines.push(`模型表读取失败：${v.modelsError || ''}`)
          if (v.quoteSample) lines.push('当前默认参数报价：' + JSON.stringify(v.quoteSample).slice(0, 240))
          if (v.autoKeyRecord) lines.push(`自动 Key：#${v.autoKeyRecord.id} · 今日已用 ${v.autoKeyRecord.used_gems_today} Gems`)
          if (v.lastGeneration) lines.push(`最近一次：${v.lastGeneration.at} · ${(v.lastGeneration.paths || []).length} 张 · ${v.lastGeneration.cost_gems || 0} Gems`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute() {
        try {
          return await runStatus()
        } catch (error) {
          return { ok: false, message: String((error && error.message) || error) }
        }
      },
    }))
    log('工具 rinko_nai_status 已挂上')
  } catch (error) {
    log('注册 rinko_nai_status 失败：' + String((error && error.message) || error))
  }

  // ---- 2. 同源 API（设置页用） -----------------------------------------
  // webServer 走可选作用域注入：headless/tui 没有 webServer 时只跳过路由，工具照常可用。
  const registerRoutes = (webCtx) => {
    try {
      webCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        const send = (status, payload, type = 'application/json; charset=utf-8') => {
          res.statusCode = status
          res.setHeader('content-type', type)
          res.setHeader('cache-control', 'no-store')
          res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
        }
        let route = '/'
        let search = new URLSearchParams()
        try {
          const parsed = new URL(req.url || '/', 'http://127.0.0.1')
          route = parsed.pathname.slice(API_PREFIX.length) || '/'
          search = parsed.searchParams
        } catch { /* keep defaults */ }
        try {
          bridge.lastSeen = new Date().toISOString()
          bridge.count += 1

          if (route === '/state' && req.method === 'GET') {
            let models = []
            try { models = await listModels() } catch { models = FALLBACK_MODELS }
            return send(200, {
              ok: true,
              config: publicConfig(),
              mediaDir: MEDIA_DIR,
              configPath: CONFIG_PATH,
              bridge,
              lastGeneration,
              models,
            })
          }

          if (route === '/models' && req.method === 'GET') {
            try {
              const models = await listModels()
              return send(200, { ok: true, models })
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error), models: FALLBACK_MODELS })
            }
          }

          if (route === '/config' && (req.method === 'POST' || req.method === 'PUT')) {
            const body = await readBody(req)
            const config2 = applyUpdate(body, {
              clearKey: body.clearKey === true,
              clearPassword: body.clearPassword === true,
              clearKeys: body.clearKeys === true,
            })
            return send(200, { ok: true, config: config2 })
          }

          if (route === '/keys/mint' && req.method === 'POST') {
            const body = await readBody(req)
            try { return send(200, await mintKeys(body.count)) } catch (error) { return send(200, { ok: false, error: String((error && error.message) || error) }) }
          }

          if (route === '/asset/sticker' && req.method === 'GET') {
            const f = join(ASSET_DIR, 'sticker.webp')
            if (!existsSync(f)) return send(404, { ok: false, error: '贴图不存在' })
            const bytes = readFileSync(f)
            res.statusCode = 200
            res.setHeader('content-type', 'image/webp')
            res.setHeader('cache-control', 'public, max-age=86400')
            return res.end(bytes)
          }

          // 从图片解析生成参数（法术解析）
          if (route === '/extract' && req.method === 'POST') {
            const body = await readBody(req, 30 * 1024 * 1024)
            try {
              const raw = String(body.data || body.base64 || '')
              const b64 = raw.replace(/^data:[^,]*,/, '')
              const buf = Buffer.from(b64, 'base64')
              return send(200, extractImageParams(buf))
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          // 图片工具箱：放大 / 增强 / 标注
          if (route === '/tools' && req.method === 'POST') {
            const body = await readBody(req, 30 * 1024 * 1024)
            try {
              return send(200, await runImageTool(String(body.tool || ''), body.image || body.data, body.opts || {}))
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (route === '/open' && req.method === 'POST') {
            const body = await readBody(req)
            let url = String(body.url || '').trim()
            if (url === '' && typeof body.kind === 'string') {
              const sid = SITE_IDS.includes(body.site) ? body.site : activeSiteKey()
              const base = String((config.sites[sid] && config.sites[sid].baseUrl) || SITES[sid].baseUrl).replace(/\/+$/, '')
              const pathMap = { register: '/register', console: '/conso', login: '/login', keys: '/conso' }
              const p = pathMap[body.kind] || '/'
              url = base + p
            }
            try {
              const opened = openExternal(url)
              return send(200, { ok: true, url: opened })
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (route === '/site' && (req.method === 'POST' || req.method === 'PUT')) {
            const body = await readBody(req)
            const id = String(body.site || body.activeSite || '').trim()
            if (!SITE_IDS.includes(id)) return send(400, { ok: false, error: '未知站点：' + id })
            config.activeSite = id
            saveConfig()
            let models = []
            try { models = await listModels() } catch { models = FALLBACK_MODELS }
            return send(200, { ok: true, config: publicConfig(), models })
          }

          if (route === '/login' && req.method === 'POST') {
            const body = await readBody(req)
            const username = String(body.username || '').trim()
            const password = String(body.password || '')
            const wantSite = SITE_IDS.includes(body.site) ? body.site : activeSiteKey()
            if (username === '' || password === '') return send(400, { ok: false, error: '账号或密码是空的' })
            config.activeSite = wantSite
            try {
              await login(username, password)
              const s = site()
              s.username = username
              s.password = password
              saveConfig()
              const account = await fetchAccount(siteCache().token)
              let keyInfo = { keyReady: false }
              try {
                const { token: key, kind } = await obtainApiKey()
                keyInfo = { keyReady: true, keyMasked: masked(key), keySource: kind }
              } catch (error) {
                keyInfo = { keyReady: false, keyError: String((error && error.message) || error) }
              }
              return send(200, {
                ok: true,
                site: wantSite,
                siteLabel: SITES[wantSite].label,
                account: account.account || null,
                balance: account.balance || null,
                selfError: account.selfError || null,
                ...keyInfo,
              })
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (route === '/logout' && req.method === 'POST') {
            const s = site()
            if (s.keySource === 'auto') s.apiKey = ''
            s.password = ''
            s.username = ''
            loginCache[activeSiteKey()] = { token: '', at: 0 }
            saveConfig()
            return send(200, { ok: true, config: publicConfig() })
          }

          if (route === '/rekey' && req.method === 'POST') {
            try {
              const s = site()
              loginCache[activeSiteKey()] = { token: '', at: 0 }
              if (s.keySource === 'auto') s.apiKey = ''
              saveConfig()
              const { token: key, kind } = await obtainApiKey()
              return send(200, { ok: true, keyMasked: masked(key), keySource: kind })
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (route === '/account' && req.method === 'GET') {
            try {
              const result = await runAccount()
              return send(200, result)
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (route === '/activities' && req.method === 'GET') {
            try {
              return send(200, await runActivities({ limit: search.get('limit') }))
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (route === '/topup-info' && req.method === 'GET') {
            try {
              return send(200, await runTopupInfo())
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (route === '/topup-quote' && req.method === 'POST') {
            const body = await readBody(req)
            try {
              return send(200, await runTopupQuote(body.money_cents))
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (route === '/pay' && req.method === 'POST') {
            const body = await readBody(req)
            try {
              return send(200, await runCreatePay(body.money_cents, body.payment_method))
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (route === '/packs/purchase' && req.method === 'POST') {
            const body = await readBody(req)
            try {
              return send(200, await runBuyPacks(body.packs))
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (route === '/gallery' && req.method === 'GET') {
            try {
              const result = await runGallery({
                limit: search.get('limit'),
                offset: search.get('offset'),
                rating: search.get('rating'),
              })
              return send(200, result)
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (route === '/ledger' && req.method === 'GET') {
            try {
              const result = await runLedger({ limit: search.get('limit') })
              return send(200, result)
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          // 站内画廊图片代理：需要登录态的 media/thumbnail 直接转发，避免前端跨域
          if ((route === '/thumb' || route === '/media') && req.method === 'GET') {
            const remote = search.get('url') || ''
            if (!remote.startsWith('/api/ynai/gallery/media/')) return send(403, { ok: false, error: '只允许代理画廊图片' })
            try {
              const session = await ensureLoginToken().catch(() => '')
              const bin = await requestBinary(remote, session ? { token: session } : {})
              if (!bin.ok) return send(bin.status === 404 ? 404 : 502, { ok: false, error: '画廊图片读取失败 HTTP ' + bin.status })
              res.statusCode = 200
              res.setHeader('content-type', bin.contentType)
              res.setHeader('cache-control', 'public, max-age=300')
              return res.end(bin.buffer)
            } catch (error) {
              return send(502, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (route === '/test' && (req.method === 'POST' || req.method === 'GET')) {
            const result = await runStatus()
            return send(200, result)
          }

          if (route === '/generate' && req.method === 'POST') {
            const body = await readBody(req)
            const prompt = String(body.prompt || '').trim()
            if (prompt === '') return send(400, { ok: false, error: 'prompt 是空的' })
            try {
              const result = await runGenerate({ ...body, prompt, name: body.name || 'settings-test' })
              return send(200, result)
            } catch (error) {
              return send(200, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (route === '/file' && req.method === 'GET') {
            const target = search.get('path') || ''
            const root = pathResolve(MEDIA_DIR)
            const abs = pathResolve(target)
            if (!(abs === root || abs.startsWith(root + sep))) return send(403, { ok: false, error: '只允许读 media/rinko-nai 里的图' })
            if (!existsSync(abs)) return send(404, { ok: false, error: '文件不在了' })
            const bytes = readFileSync(abs)
            res.statusCode = 200
            res.setHeader('content-type', 'image/png')
            res.setHeader('content-length', String(bytes.length))
            res.setHeader('cache-control', 'public, max-age=60')
            return res.end(bytes)
          }

          return send(404, { ok: false, error: 'not found: ' + route })
        } catch (error) {
          return send(500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    })
      log(`同源 API ${API_PREFIX} 已挂上；图片目录 ${MEDIA_DIR}`)
    } catch (error) {
      log('注册同源 API 失败：' + String((error && error.message) || error))
    }
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerRoutes)
    else if (ctx.webServer) registerRoutes(ctx)
    else log('无 webServer 服务，跳过同源路由（headless/tui 下工具照常可用）')
  } catch (error) {
    log('webServer 注入失败：' + String((error && error.message) || error))
  }

  const s = site()
  const stateText = s.apiKey
    ? (s.keySource === 'auto' ? '自动 Key' : '手动 Key')
    : (s.username ? '已登录，还没建 Key' : '还没配凭据')
  log(`已加载（${SITES[activeSiteKey()].label} ${stateText}，默认 ${config.model}）`)
}
