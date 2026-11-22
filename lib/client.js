/**
 * dsh-rinko-nai —— 浏览器半侧（手写 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 设置页「Rinko NAI」：
 *   1. 登录卡：账号 + 密码 → POST /login（宿主去网站换 token、自动建一把 dsh-rinko-nai 的 Key）
 *      登录成功后显示账户 / Gems / 图包 / Key 掩码，还能「重新获取 Key」「退出登录」
 *   2. 手动 Key（折叠）：不想登录的人直接粘 ynai- Key
 *   3. 默认参数：模型 / 尺寸 / 步数 / CFG / 采样器 / 噪声调度 / 负面词 / 默认附加串
 *   4. 操作：保存配置 · 测试连接 · 测试出图（缩略图走同源 /api/rinko-nai/file）
 *
 * 与宿主端只走同源 HTTP，不碰 RPC。改完用 `node --check lib/client.js` 验语法。
 */

window.__ModuleLoader__.load({
  id: 'dsh-rinko-nai',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useState = React.useState
    var useRef = React.useRef

    var API = '/api/rinko-nai'
    var NS = 'dsh-rinko-nai'

    var COMMON_MODELS = [
      'nai-diffusion-5-full',
      'nai-diffusion-5-curated',
      'nai-diffusion-4-5-full',
      'nai-diffusion-4-5-curated',
      'nai-diffusion-4-full',
      'nai-diffusion-4-curated',
      'nai-diffusion-3',
      'nai-diffusion-3-furry',
    ]
    // 站点真实支持的采样器 / 噪声调度（值, 显示名）
    var SAMPLER_OPTS = [
      ['k_euler', 'Euler'],
      ['k_euler_ancestral', 'Euler Ancestral'],
      ['k_dpm_2', 'DPM 2'],
      ['k_dpm_2_ancestral', 'DPM 2 Ancestral'],
      ['k_dpmpp_2m', 'DPM++ 2M'],
      ['k_dpmpp_2m_sde', 'DPM++ 2M SDE'],
      ['k_dpmpp_2s_ancestral', 'DPM++ 2S Ancestral'],
      ['k_dpmpp_sde', 'DPM++ SDE'],
      ['ddim', 'DDIM'],
      ['ddim_v3', 'DDIM V3'],
    ]
    var SCHEDULE_OPTS = [
      ['native', 'Native'],
      ['karras', 'Karras'],
      ['exponential', 'Exponential'],
      ['polyexponential', 'Polyexponential'],
    ]
    var TOOL_GROUPS = [
      ['upscale', '放大 ×2/×4'],
      ['emotion', '表情 emotion'],
      ['bg-removal', '抠图（去背景）'],
      ['colorize', '上色 colorize'],
      ['declutter', '去杂物 declutter'],
      ['lineart', '线稿 lineart'],
      ['sketch', '草图 sketch'],
      ['wd-tagger', '打标 wd-tagger'],
      ['canny', '边缘 canny'],
      ['depth', '深度 depth'],
      ['openpose', '姿势 openpose'],
    ]
    var TOOL_LABELS = {}
    TOOL_GROUPS.forEach(function (g) { TOOL_LABELS[g[0]] = g[1] })

    // ---- 同源 API ---------------------------------------------------------

    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }
    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }
    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          var msg = data && data.error ? data.error : ('HTTP ' + res.status)
          throw new Error(String(msg))
        }
        return data
      })
    }

    function Field(props) {
      return h('label', { className: 'rn-field' },
        h('span', { className: 'rn-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'rn-hint' }, props.hint) : null)
    }

    // 下拉可选 + 「自定义…」手填：点一下列出全部，也能输入列表外的东西
    function ComboField(props) {
      var known = (props.options || []).some(function (o) { return o[0] === props.value })
      var cs = useState(!known)
      var custom = cs[0], setCustom = cs[1]
      return h('label', { className: 'rn-field' },
        h('span', { className: 'rn-label' }, props.label),
        custom
          ? h('div', { className: 'rn-pair' },
              h('input', { className: 'rn-input', value: props.value, placeholder: props.placeholder || '自定义值', onChange: function (e) { props.onChange(e.target.value) } }),
              h('button', { className: 'rn-btn rn-btn-sm', type: 'button', onClick: function () { setCustom(false); if (props.options && props.options[0]) props.onChange(props.options[0][0]) } }, '列表'))
          : h('select', {
              className: 'rn-input',
              value: props.value,
              onChange: function (e) { var v = e.target.value; if (v === '__custom__') setCustom(true); else props.onChange(v) },
            },
              (props.options || []).map(function (o) { return h('option', { key: o[0], value: o[0] }, o[1]) }),
              h('option', { key: '__custom__', value: '__custom__' }, '自定义…')),
        props.hint ? h('span', { className: 'rn-hint' }, props.hint) : null)
    }

    function Toast(props) {
      if (!props.toast) return null
      return h('div', { className: 'rn-toast' + (props.toast.kind === 'ok' ? ' rn-toast-ok' : ' rn-toast-err') }, props.toast.text)
    }

    // ---- 主面板 -----------------------------------------------------------

    function RinkoSection() {
      var st = useState(null)
      var loading = useState(true)
      var form = useState(null)
      var toast = useState(null)
      var loginUser = useState('')
      var loginPass = useState('')
      var loggingIn = useState(false)
      var loginResult = useState(null)
      var apiKeyDraft = useState('')
      var extraKeysInput = useState('')
      var extraKeysSaving = useState(false)
      var keyMintCount = useState(4)
      var keyMinting = useState(false)
      var testing = useState(false)
      var testResult = useState(null)
      var genPrompt = useState('1girl, solo, silver hair, fox ears, looking at viewer, simple background, soft light')
      var generating = useState(false)
      var genResult = useState(null)
      var rekeying = useState(false)
      var acct = useState(null)
      var acctLoading = useState(false)
      var gallery = useState(null)
      var galLoading = useState(false)
      var galRating = useState('')
      var galOffset = useState(0)
      var ledger = useState(null)
      var ledgerLoading = useState(false)
      var ledgerOpen = useState(false)
      var activities = useState(null)
      var topup = useState(null)
      var packQty = useState('1')
      var buyBusy = useState(false)
      var payBusy = useState(false)
      var payAmount = useState('10')
      var payMethod = useState('alipay')
      var extractRes = useState(null)
      var extractBusy = useState(false)
      var toolImage = useState(null)
      var toolType = useState('upscale')
      var toolScale = useState('4')
      var toolBusy = useState(false)
      var toolResult = useState(null)
      var customLabel = useState('')
      var customBase = useState('')
      var customType = useState('openai')
      var customKey = useState('')
      var customMulti = useState(false)
      var customSaving = useState(false)
      var quoteBusy = useState(false)
      var quoteRes = useState(null)

      var showToast = useCallback(function (text, kind) {
        toast[1]({ text: text, kind: kind || 'ok' })
        window.setTimeout(function () { toast[1](null) }, 3500)
      }, [])

      function doSaveExtraKeys() {
        extraKeysSaving[1](true)
        apiPost('/config', { apiKeys: extraKeysInput[0], activeSite: (st[0] && st[0].config && st[0].config.activeSite) || 'nai' }).then(function (d) {
          var n = (d && d.config && d.config.sites && d.config.sites[d.config.activeSite] && d.config.sites[d.config.activeSite].extraKeys) || 0
          extraKeysInput[1]('')
          refresh()
          showToast('多 Key 已保存（额外 ' + n + ' 把）', 'ok')
        }).catch(function (e) {
          showToast('保存失败：' + String((e && e.message) || e), 'err')
        }).finally(function () { extraKeysSaving[1](false) })
      }

      function doToggleMulti(checked) {
        apiPost('/config', { activeSite: (st[0] && st[0].config && st[0].config.activeSite) || 'nai', multiPerKey: checked === true }).then(function () {
          refresh()
        }).catch(function (e) { showToast('保存失败：' + String((e && e.message) || e), 'err') })
      }

      function doToggleImg2img(checked) {
        apiPost('/config', { activeSite: (st[0] && st[0].config && st[0].config.activeSite) || 'nai', img2img: checked === true }).then(function () {
          refresh()
        }).catch(function (e) { showToast('保存失败：' + String((e && e.message) || e), 'err') })
      }

      function doMintKeys() {
        keyMinting[1](true)
        apiPost('/keys/mint', { count: keyMintCount[0] }).then(function (d) {
          if (d && d.ok) {
            showToast('已自动建 ' + d.created + ' 把 Key，现有额外 ' + d.extraKeys + ' 把', 'ok')
            refresh()
          } else {
            showToast('建 Key 失败：' + String((d && (d.error || (d.errors && d.errors[0]))) || '未知'), 'err')
          }
        }).catch(function (e) { showToast('建 Key 失败：' + String((e && e.message) || e), 'err') }).finally(function () { keyMinting[1](false) })
      }

      function doSaveCustom() {
        customSaving[1](true)
        apiPost('/config', { activeSite: 'custom', label: customLabel[0], baseUrl: customBase[0], apiType: customType[0], apiKey: customKey[0], multiPerKey: customMulti[0] === true }).then(function () {
          customKey[1]('')
          refresh()
          showToast('自定义站已保存', 'ok')
        }).catch(function (e) { showToast('保存失败：' + String((e && e.message) || e), 'err') }).finally(function () { customSaving[1](false) })
      }

      function doQuote() {
        quoteBusy[1](true)
        quoteRes[1](null)
        apiPost('/generate', { prompt: genPrompt[0], quote: true }).then(function (d) { quoteRes[1](d) }).catch(function (e) { quoteRes[1]({ ok: false, error: String((e && e.message) || e) }) }).finally(function () { quoteBusy[1](false) })
      }

      var refresh = useCallback(function () {
        return apiGet('/state').then(function (data) {
          st[1](data)
          loginUser[1](function (prev) { return prev === '' ? (data.config.username || '') : prev })
          form[1]({
            enabled: data.config.enabled !== false,
            baseUrl: data.config.baseUrl || 'https://nai.rinko.ai',
            model: data.config.model || 'nai-diffusion-4-5-full',
            width: data.config.width || 832,
            height: data.config.height || 1216,
            steps: data.config.steps || 28,
            scale: data.config.scale || 5,
            sampler: data.config.sampler || 'k_euler_ancestral',
            noise_schedule: data.config.noise_schedule || 'karras',
            negativePrompt: data.config.negativePrompt || '',
            promptSuffix: data.config.promptSuffix || '',
            qualityToggle: data.config.qualityToggle !== false,
            ucPreset: data.config.ucPreset || 0,
          })
          return data
        })
      }, [])

      var loadAccount = useCallback(function () {
        acctLoading[1](true)
        apiGet('/account').then(function (data) {
          acct[1](data)
        }).catch(function (e) {
          var m = String(e && e.message || e)
          acct[1]({ ok: false, error: m })
          if (m.indexOf('代理') >= 0 || m.indexOf('连不上') >= 0 || m.indexOf('超时') >= 0) showToast('网络超时/连不上：建议开启代理（如 Clash 全局/TUN）后重试', 'err')
        }).finally(function () { acctLoading[1](false) })
      }, [])

      var loadActivities = useCallback(function () {
        apiGet('/activities?limit=10').then(function (data) {
          activities[1](data)
        }).catch(function (e) { activities[1]({ ok: false, error: String(e && e.message || e) }) })
      }, [])

      var loadTopup = useCallback(function () {
        apiGet('/topup-info').then(function (data) {
          topup[1](data)
          if (data && data.ok && data.info) {
            var opts = data.info.amount_options || []
            if (opts.length && String(opts).indexOf(payAmount[0]) < 0) payAmount[1](String(opts[0]))
            var ms = (data.info.pay_methods || [])
            if (ms.length && !ms.some(function (m) { return m.type === payMethod[0] })) payMethod[1](ms[0].type)
          }
        }).catch(function (e) { topup[1]({ ok: false, error: String(e && e.message || e) }) })
      }, [])

      var loadGallery = useCallback(function (offset, rating) {
        galLoading[1](true)
        var off = offset || 0
        var r = rating === undefined ? galRating[0] : rating
        apiGet('/gallery?limit=12&offset=' + off + '&rating=' + encodeURIComponent(r || '')).then(function (data) {
          gallery[1](data)
          galOffset[1](off)
        }).catch(function (e) {
          gallery[1]({ ok: false, error: String(e && e.message || e) })
        }).finally(function () { galLoading[1](false) })
      }, [])

      var loadLedger = useCallback(function () {
        ledgerLoading[1](true)
        apiGet('/ledger?limit=12').then(function (data) {
          ledger[1](data)
        }).catch(function (e) {
          ledger[1]({ ok: false, error: String(e && e.message || e) })
        }).finally(function () { ledgerLoading[1](false) })
      }, [])

      useEffect(function () {
        var alive = true
        loading[1](true)
        refresh().catch(function (e) {
          if (alive) st[1]({ ok: false, error: String(e && e.message || e) })
        }).finally(function () {
          if (alive) loading[1](false)
        })
        loadAccount()
        loadGallery(0, '')
        loadActivities()
        loadTopup()
        return function () { alive = false }
      }, [])

      if (loading[0]) return h('div', { className: 'rn-loading' }, '正在连宿主……')
      if (!st[0] || st[0].ok === false) {
        return h('div', { className: 'rn-error' }, '读不到 /api/rinko-nai/state：' + (st[0] && st[0].error ? st[0].error : '未知错误'))
      }

      var state = st[0]
      var cfg = state.config
      var loggedIn = cfg.loggedIn === true
      var isBuiltin = cfg.activeSite === 'nai' || cfg.activeSite === 'ynai'
      var LOGIN_HINT = '需要先「用账号密码登录」才能看这里（当前只配了 API Key）。出图功能不受影响。'
      var f = form[0] || {}
      var setF = function (patch) { form[1](Object.assign({}, f, patch)) }
      // 模型清单：优先用宿主从网站 /v1/models 动态拉的；没拿到就用内置兜底
      var modelList = (state && Array.isArray(state.models) && state.models.length) ? state.models.slice() : COMMON_MODELS.slice()
      if (f.model && modelList.indexOf(f.model) < 0) modelList.unshift(f.model)
      var MODEL_LABELS = {
        'nai-diffusion-5-full': 'V5 Full',
        'nai-diffusion-5-curated': 'V5 Curated',
        'nai-diffusion-4-5-full': 'V4.5 Full',
        'nai-diffusion-4-5-curated': 'V4.5 Curated',
        'nai-diffusion-4-full': 'V4 Full',
        'nai-diffusion-4-curated': 'V4 Curated',
        'nai-diffusion-3': 'V3',
        'nai-diffusion-3-furry': 'V3 Furry',
      }
      var modelLabel = function (m) {
        if (MODEL_LABELS[m]) return MODEL_LABELS[m] + ' · ' + m
        if (m.indexOf('inpainting') >= 0) return m + '（需底图）'
        return m
      }

      // -- 切换站点 --
      var doSwitchSite = function (id) {
        if (cfg.activeSite === id) return
        apiPost('/site', { site: id }).then(function (data) {
          if (!data || data.ok === false) { showToast('切站失败：' + (data && data.error ? data.error : '未知'), 'err'); return }
          loginPass[1]('')
          loginResult[1](null)
          apiKeyDraft[1]('')
          var target = data.config.sites[id]
          loginUser[1]((target && target.username) || '')
          refresh().catch(function () {})
          acct[1](null); gallery[1](null); ledger[1](null); activities[1](null); topup[1](null)
          loadAccount(); loadGallery(0, ''); loadActivities(); loadTopup()
          showToast('已切到 ' + ((target && target.label) || id))
        }).catch(function (e) { showToast('切站失败：' + (e && e.message || e), 'err') })
      }

      // -- 登录 --
      var doLogin = function () {
        if (loggingIn[0]) return
        if (loginUser[0].trim() === '' || loginPass[0] === '') {
          showToast('账号和密码都要填', 'err')
          return
        }
        loggingIn[1](true)
        loginResult[1](null)
        apiPost('/login', { username: loginUser[0].trim(), password: loginPass[0], site: cfg.activeSite }).then(function (data) {
          loginResult[1](data)
          if (data && data.ok) {
            loginPass[1]('')
            showToast(data.keyReady ? '登录成功，Key 已就绪' : '登录成功，但 Key 没建起来')
            refresh().catch(function () {})
            loadAccount(); loadActivities(); loadTopup(); loadGallery(0, '')
          } else {
            showToast('登录失败：' + (data && data.error ? data.error : '未知'), 'err')
          }
        }).catch(function (e) {
          loginResult[1]({ ok: false, error: String(e && e.message || e) })
          showToast('登录失败：' + (e && e.message || e), 'err')
        }).finally(function () { loggingIn[1](false) })
      }

      // -- 用系统浏览器打开站点页（注册 / 控制台） --
      var openFallback = function (kind) {
        var info = (cfg.sites && cfg.sites[cfg.activeSite]) || {}
        var base = String(info.baseUrl || '').replace(/\/+$/, '')
        var path = kind === 'register' ? '/register' : '/conso'
        if (base && typeof window !== 'undefined' && window.open) window.open(base + path, '_blank', 'noopener')
      }
      // 用系统浏览器打开任意（本站白名单内）网址
      var doOpenUrl = function (url) {
        apiPost('/open', { url: url }).then(function (data) {
          if (!data || !data.ok) { if (typeof window !== 'undefined' && window.open) window.open(url, '_blank', 'noopener') }
        }).catch(function () { if (typeof window !== 'undefined' && window.open) window.open(url, '_blank', 'noopener') })
      }
      var doOpen = function (kind) {
        apiPost('/open', { kind: kind, site: cfg.activeSite }).then(function (data) {
          if (data && data.ok) { showToast('已在浏览器打开'); return }
          openFallback(kind)
        }).catch(function () { openFallback(kind) })
      }

      // 买图包（扣 Gems，二次确认）
      var doBuyPacks = function (info) {
        if (buyBusy[0]) return
        var n = Math.round(Number(packQty[0]))
        if (!Number.isFinite(n) || n <= 0) { showToast('图包数量要 ≥1', 'err'); return }
        var per = info && info.pack_gems
        var cost = per ? per * n : ''
        var msg = '确认用 ' + (cost === '' ? '（未知）' : cost + ' Gems') + ' 购买 ' + n + ' 份图包（共 ' + (n * (info.pack_images || 0)) + ' 张）？\n\n这是真实扣费，确认继续。'
        if (typeof window !== 'undefined' && window.confirm && !window.confirm(msg)) return
        buyBusy[1](true)
        apiPost('/packs/purchase', { packs: n }).then(function (data) {
          if (data && data.ok) {
            showToast('已购买 ' + n + ' 份图包')
            loadAccount()
          } else showToast('购买失败：' + (data && data.error ? data.error : '未知'), 'err')
        }).catch(function (e) { showToast('购买失败：' + (e && e.message || e), 'err') }).finally(function () { buyBusy[1](false) })
      }

      // 充值（下单后打开支付页）
      var doPay = function () {
        if (payBusy[0]) return
        var yuan = Math.round(Number(payAmount[0]))
        if (!Number.isFinite(yuan) || yuan <= 0) { showToast('金额无效', 'err'); return }
        if (typeof window !== 'undefined' && window.confirm && !window.confirm('确认充值 ¥' + yuan + '（' + payMethod[0] + '）？\n\n将在浏览器打开支付页面，付完款 Gems 自动到账。')) return
        payBusy[1](true)
        apiPost('/pay', { money_cents: yuan * 100, payment_method: payMethod[0] }).then(function (data) {
          if (data && data.ok) showToast('支付页已在浏览器打开，付完款 Gems 自动到账')
          else showToast('下单失败：' + (data && data.error ? data.error : '未知'), 'err')
        }).catch(function (e) { showToast('下单失败：' + (e && e.message || e), 'err') }).finally(function () { payBusy[1](false) })
      }

      // 从图片解析参数（法术解析）
      var doExtractFile = function (e) {
        var input = e && e.target
        var file = input && input.files && input.files[0]
        if (!file) return
        if (typeof FileReader === 'undefined') { showToast('当前环境不支持读取文件', 'err'); return }
        extractBusy[1](true)
        extractRes[1](null)
        var reader = new FileReader()
        reader.onload = function () {
          apiPost('/extract', { data: String(reader.result) }).then(function (d) {
            extractRes[1](d)
            if (d && d.ok && d.params) {
              var p = d.params
              var patch = {}
              if (p.width) patch.width = p.width
              if (p.height) patch.height = p.height
              if (p.steps) patch.steps = p.steps
              if (p.scale !== undefined) patch.scale = p.scale
              if (p.sampler) patch.sampler = p.sampler
              if (p.noise_schedule) patch.noise_schedule = p.noise_schedule
              if (p.negative !== undefined) patch.negativePrompt = p.negative
              if (p.model && modelList.indexOf(p.model) >= 0) patch.model = p.model
              setF(patch)
              if (p.prompt) genPrompt[1](p.prompt)
              showToast('已导入参数' + (p.prompt ? '，提示词已填入"测试提示词"' : ''))
            } else {
              showToast('没读到参数：' + (d && d.error ? d.error : '未知'), 'err')
            }
          }).catch(function (err) { extractRes[1]({ ok: false, error: String(err && err.message || err) }); showToast('解析失败', 'err') })
            .finally(function () { extractBusy[1](false) })
        }
        reader.onerror = function () { extractBusy[1](false); showToast('读取文件失败', 'err') }
        reader.readAsDataURL(file)
        try { input.value = '' } catch (e2) {}
      }

      // 工具箱：选图
      var doPickToolImage = function (e) {
        var file = e && e.target && e.target.files && e.target.files[0]
        if (!file) return
        if (typeof FileReader === 'undefined') { showToast('当前环境不支持读取文件', 'err'); return }
        var reader = new FileReader()
        reader.onload = function () { toolImage[1](String(reader.result)); toolResult[1](null) }
        reader.onerror = function () { showToast('读取文件失败', 'err') }
        reader.readAsDataURL(file)
        try { e.target.value = '' } catch (e2) {}
      }
      // 工具箱：执行
      var doRunTool = function () {
        if (toolBusy[0]) return
        if (!toolImage[0]) { showToast('先选一张图', 'err'); return }
        var label = TOOL_LABELS[toolType[0]] || toolType[0]
        if (typeof window !== 'undefined' && window.confirm && !window.confirm('执行「' + label + '」？\n\n该工具按次计费（站点若未配价会直接报 PRICE_NOT_CONFIGURED，不扣费）。')) return
        toolBusy[1](true)
        toolResult[1](null)
        apiPost('/tools', { tool: toolType[0], image: toolImage[0], opts: { scale: Number(toolScale[0]) || 4 } })
          .then(function (d) { toolResult[1](d); if (d && d.ok) showToast('完成') ; else showToast('执行失败：' + (d && d.error ? d.error : '未知'), 'err') })
          .catch(function (err) { toolResult[1]({ ok: false, error: String(err && err.message || err) }); showToast('执行失败', 'err') })
          .finally(function () { toolBusy[1](false) })
      }

      var doLogout = function () {
        apiPost('/logout', {}).then(function () {
          loginPass[1]('')
          loginResult[1](null)
          showToast('已退出登录（插件内的 Key 已清掉，网站上的那把要停用请去控制台）')
          refresh().catch(function () {})
        }).catch(function (e) { showToast('退出失败：' + (e && e.message || e), 'err') })
      }

      var doRekey = function () {
        if (rekeying[0]) return
        rekeying[1](true)
        apiPost('/rekey', {}).then(function (data) {
          if (data && data.ok) {
            showToast('新 Key 就绪：' + (data.keyMasked || ''))
            refresh().catch(function () {})
          } else {
            showToast('重新获取失败：' + (data && data.error ? data.error : '未知'), 'err')
          }
        }).catch(function (e) {
          showToast('重新获取失败：' + (e && e.message || e), 'err')
        }).finally(function () { rekeying[1](false) })
      }

      // -- 手动 Key / 默认参数 --
      var save = function () {
        var body = Object.assign({}, f, {
          apiKey: apiKeyDraft[0].trim() === '' ? undefined : apiKeyDraft[0].trim(),
        })
        apiPost('/config', body).then(function (data) {
          apiKeyDraft[1]('')
          showToast('已保存')
          st[1](Object.assign({}, state, { config: data.config }))
        }).catch(function (e) { showToast('保存失败：' + (e && e.message || e), 'err') })
      }

      // 恢复默认出图设置（只重置参数，不动账号/Key/站点）
      var DEFAULT_PARAMS = { model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', noise_schedule: 'karras', negativePrompt: '', promptSuffix: '', ucPreset: 0, qualityToggle: true }
      var doResetDefaults = function () {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm('恢复默认出图设置？\n\n模型/尺寸/步数/CFG/采样器/噪声调度/负面词/附加串 将重置为出厂值（账号、Key、站点不受影响）。')) return
        apiPost('/config', DEFAULT_PARAMS).then(function (data) {
          showToast('已恢复默认出图设置')
          form[1](Object.assign({}, DEFAULT_PARAMS))
          if (data && data.config) st[1](Object.assign({}, state, { config: data.config }))
          refresh().catch(function () {})
        }).catch(function (e) { showToast('恢复失败：' + (e && e.message || e), 'err') })
      }

      var runTest = function () {
        testing[1](true)
        testResult[1](null)
        apiPost('/test', {}).then(function (data) {
          testResult[1](data)
        }).catch(function (e) {
          testResult[1]({ ok: false, error: String(e && e.message || e) })
        }).finally(function () { testing[1](false) })
      }

      var runGenerate = function () {
        if (generating[0]) return
        generating[1](true)
        genResult[1](null)
        apiPost('/generate', { prompt: genPrompt[0], count: 1, name: 'settings-test' }).then(function (data) {
          genResult[1](data)
        }).catch(function (e) {
          genResult[1]({ ok: false, error: String(e && e.message || e) })
        }).finally(function () { generating[1](false) })
      }

      var thumbUrl = function (p) { return API + '/file?path=' + encodeURIComponent(p) }
      var lastPaths = state.lastGeneration && state.lastGeneration.paths ? state.lastGeneration.paths : []
      var galThumbUrl = function (remote) { return API + '/thumb?url=' + encodeURIComponent(remote) }
      var LEDGER_TYPE = {
        generation_debit: '出图扣费',
        generation_refund: '出图退款',
        image_pack_purchase: '买图包',
        purchase: '购买',
        recharge: '充值',
        admin_adjust: '调整',
        signup_bonus: '注册奖励',
      }
      var ledgerRows = ledger[0] && ledger[0].ok ? (ledger[0].items || []) : []
      var ledgerBlock
      if (!loggedIn || ledger[0] === null) {
        ledgerBlock = h('div', { className: 'rn-hint' }, !loggedIn ? LOGIN_HINT : (ledgerLoading[0] ? '读取中…' : '展开后自动读取最近 12 条。'))
      } else if (ledger[0].ok === false) {
        ledgerBlock = h('div', { className: 'rn-result rn-err' }, '流水读取失败：' + (ledger[0].error || '未知'))
      } else if (ledgerRows.length === 0) {
        ledgerBlock = h('div', { className: 'rn-hint' }, '还没有流水记录。')
      } else {
        ledgerBlock = h('div', null,
          h('div', { className: 'rn-ledger' }, ledgerRows.map(function (row) {
            var amt = Number(row.amount || 0)
            return h('div', { className: 'rn-ledger-row', key: String(row.id) },
              h('span', { className: 'rn-ledger-time' }, String(row.at || '').replace('T', ' ').slice(0, 16)),
              h('span', { className: 'rn-ledger-type' }, LEDGER_TYPE[row.type] || row.type || '—'),
              h('span', { className: 'rn-ledger-amt' + (amt >= 0 ? ' rn-plus' : '') }, (amt >= 0 ? '+' : '') + amt),
              h('span', { className: 'rn-ledger-bal' }, '余 ' + (row.balanceAfter !== undefined && row.balanceAfter !== null ? row.balanceAfter : '?')))
          })),
          h('div', { className: 'rn-btnrow' },
            h('button', { className: 'rn-btn rn-btn-sm', onClick: loadLedger, disabled: ledgerLoading[0] }, ledgerLoading[0] ? '读取中…' : '刷新流水')))
      }
      var acc = loginResult[0] && loginResult[0].account ? loginResult[0].account : null
      var balance = acc ? acc.balance_gems : null
      var packs = acc ? acc.image_pack_credits : null

      return h('div', { className: 'rn-root' },
        h('div', { className: 'rn-head' },
          h('span', { className: 'rn-title' }, 'Rinko NAI · YesNAI 出图'),
          h('span', { className: 'rn-bridge' + (state.bridge && state.bridge.count > 0 ? ' rn-bridge-ok' : '') },
            state.bridge && state.bridge.count > 0 ? '已连接宿主' : '未握手'),
          h('span', { className: 'rn-muted' },
            cfg.hasKey
              ? (cfg.keySource === 'auto' ? '自动 Key ' + cfg.apiKeyMasked : '手动 Key ' + cfg.apiKeyMasked)
              : (cfg.loggedIn ? '已登录，Key 待建' : '还没登录'))),

        // ---- 站点切换 ----
        h('div', { className: 'rn-sites' },
          ['nai', 'ynai', 'custom'].map(function (sid) {
            var info = (cfg.sites && cfg.sites[sid]) || {}
            var on = cfg.activeSite === sid
            return h('button', {
              key: sid,
              className: 'rn-site-tab' + (on ? ' rn-site-on' : ''),
              onClick: function () { doSwitchSite(sid) },
              title: info.baseUrl || '',
            },
              h('span', { className: 'rn-site-name' }, info.label || sid),
              h('span', { className: 'rn-site-dot' + (info.hasKey ? ' rn-dot-ok' : '') }),
              h('span', { className: 'rn-site-host' }, String(info.baseUrl || '').replace(/^https?:\/\//, '')))
          }),
          h('span', { className: 'rn-muted' }, '当前：' + ((cfg.sites && cfg.sites[cfg.activeSite]) ? cfg.sites[cfg.activeSite].label : cfg.activeSite))),

        cfg.activeSite === 'custom' ? h('div', { className: 'rn-card' },
          h('div', { className: 'rn-card-title' }, '自定义站设置'),
          h('div', { className: 'rn-muted', style: { marginBottom: '6px' } }, '填任意兼容服务的 Base URL：OpenAI 兼容（POST /v1/images/generations）或 YesNAI 兼容（POST /v1/nai/generate-image）。多 Key 可在下方「多 Key」里填。'),
          h('div', { className: 'rn-fieldrow' }, h('span', { className: 'rn-label' }, '名称'), h('input', { className: 'rn-ta', value: customLabel[0], placeholder: (cfg.sites.custom && cfg.sites.custom.label) || '我的站', onInput: function (e) { customLabel[1](e.target.value) } })),
          h('div', { className: 'rn-fieldrow' }, h('span', { className: 'rn-label' }, 'Base URL'), h('input', { className: 'rn-ta', value: customBase[0], placeholder: (cfg.sites.custom && cfg.sites.custom.baseUrl) || 'https://example.com', onInput: function (e) { customBase[1](e.target.value) } })),
          h('div', { className: 'rn-fieldrow' }, h('span', { className: 'rn-label' }, '协议'), h('select', { className: 'rn-ta', value: customType[0], onChange: function (e) { customType[1](e.target.value) } }, h('option', { value: 'openai' }, 'OpenAI 兼容'), h('option', { value: 'yesnai' }, 'YesNAI 兼容'))),
          h('div', { className: 'rn-fieldrow' }, h('span', { className: 'rn-label' }, 'API Key'), h('input', { className: 'rn-ta', type: 'password', value: customKey[0], placeholder: '填一次保存（留空不改）', onInput: function (e) { customKey[1](e.target.value) } })),
          h('label', { className: 'rn-fieldrow', style: { cursor: 'pointer' } }, h('span', { className: 'rn-label' }, '单 Key 多并行'), h('input', { type: 'checkbox', checked: customMulti[0] === true, onChange: function (e) { customMulti[1](e.target.checked) } }), h('span', { className: 'rn-muted', style: { marginLeft: '6px' } }, '同一 Key 并发多张')),
          h('label', { className: 'rn-fieldrow', style: { cursor: 'pointer' } }, h('span', { className: 'rn-label' }, '启用图生图'), h('input', { type: 'checkbox', checked: !!(cfg.sites && cfg.sites.custom && cfg.sites.custom.img2img), onChange: function (e) { doToggleImg2img(e.target.checked) } }), h('span', { className: 'rn-muted', style: { marginLeft: '6px' } }, '该站支持 /images/edits 时勾选')),
          h('div', { className: 'rn-fieldrow', style: { alignItems: 'flex-start' } }, h('span', { className: 'rn-label' }, '多 Key'), h('textarea', { className: 'rn-ta', rows: 2, value: extraKeysInput[0], placeholder: '每行一个 Key（并发用，可留空）', onInput: function (e) { extraKeysInput[1](e.target.value) } })),
          h('div', { className: 'rn-btnrow' },
            h('button', { className: 'rn-btn rn-btn-primary', onClick: doSaveCustom, disabled: customSaving[0] }, customSaving[0] ? '保存中…' : '保存自定义站'),
            h('button', { className: 'rn-btn', onClick: doSaveExtraKeys, disabled: extraKeysSaving[0] }, extraKeysSaving[0] ? '保存中…' : '保存多 Key'))) : null,

        isBuiltin ? h('div', null,
        !loggedIn
          ? h('div', { className: 'rn-banner' },
              '当前只配了 API Key，未登录账号：下面的 账户 / 活动 / 图包 / 充值 / 画廊 / 流水 需要「用账号密码登录」才能用（出图功能不受影响）。')
          : null,

        // ---- 登录卡 ----
        h('div', { className: 'rn-card' },
          h('div', { className: 'rn-card-title' }, '登录 ' + ((cfg.sites && cfg.sites[cfg.activeSite]) ? cfg.sites[cfg.activeSite].label : 'YesNAI') + ' 账号'),
          h('div', { className: 'rn-row' },
            h(Field, { label: '账号', hint: '就是网站的控制台账号' },
              h('input', {
                className: 'rn-input',
                value: loginUser[0],
                placeholder: '网站用户名',
                onChange: function (e) { loginUser[1](e.target.value) },
              })),
            h(Field, { label: '密码', hint: '只存本机 config.json，不上传任何第三方' },
              h('input', {
                className: 'rn-input',
                type: 'password',
                value: loginPass[0],
                placeholder: cfg.hasPassword ? '已保存，重新登录需再填一次' : '网站密码',
                onChange: function (e) { loginPass[1](e.target.value) },
              }))),
          h('div', { className: 'rn-btnrow' },
            h('button', { className: 'rn-btn rn-btn-primary', onClick: doLogin, disabled: loggingIn[0] },
              loggingIn[0] ? '登录中…' : '登录并自动建 Key'),
            cfg.hasKey ? h('button', { className: 'rn-btn', onClick: doRekey, disabled: rekeying[0] }, rekeying[0] ? '获取中…' : '重新获取 Key') : null,
            (cfg.loggedIn || cfg.hasKey) ? h('button', { className: 'rn-btn', onClick: doLogout }, '退出登录') : null),
          h('div', { className: 'rn-linkrow' },
            h('button', { className: 'rn-link', onClick: function () { doOpen('register') } }, '↗ 没有账号？去注册'),
            h('button', { className: 'rn-link', onClick: function () { doOpen('console') } }, '↗ 打开控制台（API 密钥）'),
            h('button', { className: 'rn-link', onClick: function () { doOpen('docs') } }, '↗ API 文档')),
          h('details', { className: 'rn-adv', style: { marginTop: '8px' } },
            h('summary', null, '多 Key（并发出图，每行一个 ynai- Key）' + (((cfg.sites && cfg.sites[cfg.activeSite] && cfg.sites[cfg.activeSite].extraKeys) || 0) ? ' · 已配 ' + cfg.sites[cfg.activeSite].extraKeys + ' 把' : '')),
            h('div', { className: 'rn-muted', style: { margin: '6px 0' } }, '站点对单个 Key 有并发限制。多填几把 Key 后，count>1 时每把 Key 同时跑一张 → 并行出图更快。'),
            h('textarea', { className: 'rn-ta', rows: 3, value: extraKeysInput[0], placeholder: '每行一个 ynai- 开头的 Key，可留空', onInput: function (e) { extraKeysInput[1](e.target.value) } }),
            h('div', { className: 'rn-btnrow' },
              h('input', { className: 'rn-ta', type: 'number', min: 1, max: 10, value: keyMintCount[0], style: { width: '84px' }, onInput: function (e) { keyMintCount[1](e.target.value) } }),
              h('button', { className: 'rn-btn rn-btn-primary', onClick: doMintKeys, disabled: keyMinting[0] }, keyMinting[0] ? '建 Key 中…' : '一键建 Key（自动加 N 把）'),
              h('button', { className: 'rn-btn', onClick: doSaveExtraKeys, disabled: extraKeysSaving[0] }, extraKeysSaving[0] ? '保存中…' : '保存多 Key'))),
            h('label', { className: 'rn-fieldrow', style: { cursor: 'pointer', marginTop: '4px' } }, h('span', { className: 'rn-label' }, '单 Key 多并行'), h('input', { type: 'checkbox', checked: !!(cfg.sites && cfg.sites[cfg.activeSite] && cfg.sites[cfg.activeSite].multiPerKey), onChange: function (e) { doToggleMulti(e.target.checked) } }), h('span', { className: 'rn-muted', style: { marginLeft: '6px' } }, '同一 Key 并发多张')),
            h('label', { className: 'rn-fieldrow', style: { cursor: 'pointer' } }, h('span', { className: 'rn-label' }, '启用图生图'), h('input', { type: 'checkbox', checked: !!(cfg.sites && cfg.sites[cfg.activeSite] && cfg.sites[cfg.activeSite].img2img), onChange: function (e) { doToggleImg2img(e.target.checked) } }), h('span', { className: 'rn-muted', style: { marginLeft: '6px' } }, '该站支持图生图时勾选')),
          loginResult[0]
            ? h('div', { className: 'rn-result' + (loginResult[0].ok === false ? ' rn-err' : '') },
                loginResult[0].ok === false
                  ? '登录失败：' + (loginResult[0].error || '未知')
                  : h('div', null,
                      h('div', null, '✓ 已登录 ' + (acc && acc.username ? acc.username : loginUser[0])),
                      h('div', null, 'Gems：' + (balance === null || balance === undefined ? '—' : balance) + ' · 图包：' + (packs === null || packs === undefined ? '—' : packs + ' 张')),
                      h('div', null, loginResult[0].keyReady
                        ? 'Key 已就绪：' + (loginResult[0].keyMasked || '') + '（' + (loginResult[0].keySource === 'auto' ? '自动创建' : '手动') + '）'
                        : 'Key 没建起来：' + (loginResult[0].keyError || '未知')),
                      loginResult[0].selfError ? h('div', { className: 'rn-err' }, loginResult[0].selfError) : null))
            : null,
          h('div', { className: 'rn-hint' },
            '登录后宿主会在网站「API 密钥」里建一把名叫 dsh-rinko-nai 的 Key 并保存在本机；' +
            '网站出图端点只认这把 Key（登录 token 不带生成权限）。不想登录也可以自己建一把填在下面。'),
          h('details', { className: 'rn-details' },
            h('summary', null, '高级：手动填 API Key'),
            h('div', { className: 'rn-row' },
              h(Field, { label: 'API Key', hint: 'ynai- 开头。留空 = 保留当前值；填了就覆盖自动 Key。' },
                h('input', {
                  className: 'rn-input',
                  type: 'password',
                  value: apiKeyDraft[0],
                  placeholder: cfg.apiKeyMasked || 'ynai-…',
                  onChange: function (e) { apiKeyDraft[1](e.target.value) },
                }))),
            h('div', { className: 'rn-btnrow' },
              h('button', { className: 'rn-btn', onClick: save }, '保存 Key 与参数')))),

        // ---- 账户总览 ----
        h('div', { className: 'rn-card' },
          h('div', { className: 'rn-card-head' },
            h('span', { className: 'rn-card-title' }, '账户总览'),
            h('button', { className: 'rn-btn rn-btn-sm', onClick: loadAccount, disabled: !loggedIn || acctLoading[0] },
              acctLoading[0] ? '读取中…' : '刷新')),
          (!loggedIn || acct[0] === null)
            ? h('div', { className: 'rn-hint' }, loggedIn ? '点「刷新」拉取余额与图包额度。' : LOGIN_HINT)
            : acct[0].ok === false
              ? h('div', { className: 'rn-result rn-err' }, '读不到账户：' + (acct[0].error || '未知') + '（需要先在下面登录）')
              : h('div', null,
                  h('div', { className: 'rn-stats' },
                    h('div', { className: 'rn-stat' },
                      h('span', { className: 'rn-stat-num' }, String((acct[0].account && acct[0].account.balance_gems) ?? (acct[0].balance && acct[0].balance.balance_gems) ?? '—')),
                      h('span', { className: 'rn-stat-lbl' }, 'Gems 余额')),
                    h('div', { className: 'rn-stat' },
                      h('span', { className: 'rn-stat-num' }, String((acct[0].packs && acct[0].packs.image_pack_credits) ?? '—')),
                      h('span', { className: 'rn-stat-lbl' }, '图包剩余（张）')),
                    h('div', { className: 'rn-stat' },
                      h('span', { className: 'rn-stat-num' }, String((acct[0].account && acct[0].account.request_count) ?? '—')),
                      h('span', { className: 'rn-stat-lbl' }, '累计请求')),
                    h('div', { className: 'rn-stat' },
                      h('span', { className: 'rn-stat-num' }, String((acct[0].account && acct[0].account.used_gems_total) ?? '—')),
                      h('span', { className: 'rn-stat-lbl' }, '累计消耗 Gems'))),
                  acct[0].packs
                    ? h('div', { className: 'rn-hint' },
                        '免费额度：每 ' + acct[0].packs.window_minutes + ' 分钟 ' + acct[0].packs.free_count + ' 张 · ' +
                        '图包：' + acct[0].packs.pack_images + ' 张 = ' + acct[0].packs.pack_gems + ' Gems · ' +
                        '像素上限 ' + acct[0].packs.max_pixels + (acct[0].packs.txt2img_only ? ' · 仅文生图' : ''))
                    : acct[0].packsError ? h('div', { className: 'rn-err' }, '图包信息：' + acct[0].packsError) : null,
                  acct[0].autoKey
                    ? h('div', { className: 'rn-hint' },
                        '自动 Key #' + acct[0].autoKey.id + ' 今日已用 ' + (acct[0].autoKey.used_gems_today ?? 0) +
                        (acct[0].autoKey.daily_gems_limit ? ' / ' + acct[0].autoKey.daily_gems_limit : '') + ' Gems · 累计 ' +
                        (acct[0].autoKey.used_gems_total ?? 0) + ' Gems')
                    : null,
                  acct[0].selfError ? h('div', { className: 'rn-err' }, acct[0].selfError) : null)),

        // ---- 站内活动 ----
        h('div', { className: 'rn-card' },
          h('div', { className: 'rn-card-head' },
            h('span', { className: 'rn-card-title' }, '站内活动'),
            h('button', { className: 'rn-btn rn-btn-sm', onClick: loadActivities, disabled: !loggedIn }, '刷新')),
          (!loggedIn || activities[0] === null)
            ? h('div', { className: 'rn-hint' }, loggedIn ? '点「刷新」查看活动。' : LOGIN_HINT)
            : activities[0].ok === false
              ? h('div', { className: 'rn-result rn-err' }, '活动读取失败：' + (activities[0].error || '未知'))
              : (activities[0].items || []).length === 0
                ? h('div', { className: 'rn-hint' }, '暂无活动。')
                : h('div', { className: 'rn-act-list' }, (activities[0].items || []).map(function (a) {
                  var PHASE = { running: '进行中', upcoming: '未开始', ended: '已结束', published: '已发布', draft: '草稿' }
                  var base = String(((cfg.sites && cfg.sites[cfg.activeSite] && cfg.sites[cfg.activeSite].baseUrl) || '')).replace(/\/+$/, '')
                  var detailUrl = base + '/console/activities/' + a.id
                  return h('div', {
                    className: 'rn-act rn-act-click',
                    key: String(a.id),
                    onClick: function () { doOpenUrl(detailUrl) },
                    title: '点开在浏览器查看活动详情',
                  },
                    h('div', { className: 'rn-act-head' },
                      h('span', { className: 'rn-act-title' }, a.title || ('活动 #' + a.id)),
                      h('span', { className: 'rn-tag' }, PHASE[a.phase] || a.phase || a.status || '')),
                    a.summary ? h('div', { className: 'rn-act-sum' }, a.summary) : null,
                    h('div', { className: 'rn-act-meta' },
                      (a.startsAt ? String(a.startsAt).slice(0, 10) : '?') + ' ~ ' + (a.endsAt ? String(a.endsAt).slice(0, 10) : '?') +
                      (a.enrolled ? ' · 已参加' : '') +
                      (a.awardedGems !== undefined && a.awardedGems !== null ? ' · 奖励 ' + a.awardedGems + ' Gems' : '') +
                      ' · 查看详情 ↗'))
                }))),

        // ---- 图包购买 ----
        (function () {
          var packs = acct[0] && acct[0].ok && acct[0].packs
          return h('div', { className: 'rn-card' },
            h('div', { className: 'rn-card-title' }, '图包'),
            (!loggedIn || !packs)
              ? h('div', { className: 'rn-hint' }, loggedIn ? '点「刷新」读取图包信息。' : LOGIN_HINT)
              : !packs.enabled
                ? h('div', { className: 'rn-hint' }, '本站暂未开放图包购买。')
                : h('div', null,
                    h('div', { className: 'rn-hint' },
                      '剩余 ' + (packs.image_pack_credits ?? 0) + ' 张 · 每份 ' + packs.pack_images + ' 张 = ' + packs.pack_gems + ' Gems'),
                    h('div', { className: 'rn-row rn-row-tight' },
                      h(Field, { label: '份数' },
                        h('input', { className: 'rn-input', type: 'number', min: '1', value: packQty[0], onChange: function (e) { packQty[1](e.target.value) } })),
                      h('div', { className: 'rn-buy' },
                        h('button', { className: 'rn-btn rn-btn-primary', onClick: function () { doBuyPacks(packs) }, disabled: buyBusy[0] },
                          buyBusy[0] ? '购买中…' : '购买 ' + (Number(packQty[0]) || 0) + ' 份 · ' + ((packs.pack_gems || 0) * (Number(packQty[0]) || 0)) + ' Gems')))))
        })(),

        // ---- 充值 ----
        (function () {
          var info = topup[0] && topup[0].ok ? topup[0].info : null
          return h('div', { className: 'rn-card' },
            h('div', { className: 'rn-card-head' },
              h('span', { className: 'rn-card-title' }, '充值 Gems'),
              h('button', { className: 'rn-btn rn-btn-sm', onClick: loadTopup, disabled: !loggedIn }, '刷新')),
            (!loggedIn || !topup[0])
              ? h('div', { className: 'rn-hint' }, loggedIn ? '点「刷新」读取充值信息。' : LOGIN_HINT)
              : topup[0].ok === false
                ? h('div', { className: 'rn-result rn-err' }, '充值信息读取失败：' + (topup[0].error || '未知'))
                : !info || !info.enable_online_topup
                  ? h('div', { className: 'rn-hint' }, '本站暂未开启在线充值。可去控制台用兑换码 / 官方渠道充值。')
                  : h('div', null,
                      h('div', { className: 'rn-hint' }, '比例：1 元 = ' + (info.gems_per_yuan ?? '?') + ' Gems · 单次 ' + info.min_topup + '–' + info.max_topup + ' 元'),
                      h('div', { className: 'rn-chiprow' }, (info.amount_options || [10, 20, 50, 100]).map(function (v) {
                        return h('button', {
                          key: String(v),
                          className: 'rn-chip' + (String(payAmount[0]) === String(v) ? ' rn-chip-on' : ''),
                          onClick: function () { payAmount[1](String(v)) },
                        }, '¥' + v)
                      })),
                      h('div', { className: 'rn-row rn-row-tight' },
                        h(Field, { label: '支付方式' },
                          h('select', { className: 'rn-input', value: payMethod[0], onChange: function (e) { payMethod[1](e.target.value) } },
                            (function () { var CN = { alipay: '支付宝', wxpay: '微信支付', stripe: 'Stripe' }; return (info.pay_methods || []).map(function (m) { return h('option', { key: m.type, value: m.type }, CN[m.type] || m.name) }) })())),
                        h('div', { className: 'rn-buy' },
                          h('button', { className: 'rn-btn rn-btn-primary', onClick: doPay, disabled: payBusy[0] },
                            payBusy[0] ? '下单中…' : '充值 ¥' + (payAmount[0] || '') + ' → ' + ((Number(payAmount[0]) || 0) * (info.gems_per_yuan || 0)) + ' Gems'))),
                      h('div', { className: 'rn-hint' }, '点按钮会在浏览器打开支付页；付完款 Gems 自动到账（可在「Gems 流水」里核对）。')))
        })(),

        // ---- 站内画廊 ----
        h('div', { className: 'rn-card' },
          h('div', { className: 'rn-card-head' },
            h('span', { className: 'rn-card-title' }, '站内画廊'),
            h('div', { className: 'rn-btnrow' },
              h('select', {
                className: 'rn-input rn-select',
                value: galRating[0],
                onChange: function (e) { galRating[1](e.target.value); loadGallery(0, e.target.value) },
              }, [['', '全部'], ['general', '全年龄'], ['questionable', '擦边'], ['explicit', 'R18']].map(function (o) {
                return h('option', { key: o[0], value: o[0] }, o[1])
              })),
              h('button', { className: 'rn-btn rn-btn-sm', onClick: function () { loadGallery(galOffset[0], galRating[0]) }, disabled: !loggedIn || galLoading[0] },
                galLoading[0] ? '加载中…' : '刷新'))),
          (!loggedIn || gallery[0] === null)
            ? h('div', { className: 'rn-hint' }, loggedIn ? '点「刷新」看站内最新作品。' : LOGIN_HINT)
            : gallery[0].ok === false
              ? h('div', { className: 'rn-result rn-err' }, '画廊读取失败：' + (gallery[0].error || '未知'))
              : h('div', null,
                  h('div', { className: 'rn-gal-grid' }, (gallery[0].items || []).map(function (it) {
                    return h('div', { className: 'rn-gal-item', key: it.id },
                      h('img', {
                        className: 'rn-gal-thumb',
                        src: API + '/thumb?url=' + encodeURIComponent(it.thumb),
                        loading: 'lazy',
                        title: it.title,
                        onClick: function () { window.open(API + '/media?url=' + encodeURIComponent(it.media || it.thumb), '_blank') },
                      }),
                      h('div', { className: 'rn-gal-title' }, it.title || '（无题）'),
                      h('div', { className: 'rn-gal-meta' }, (it.author || '?') + ' · ' + (it.width || '?') + '×' + (it.height || '?')))
                  })),
                  h('div', { className: 'rn-btnrow rn-gal-nav' },
                    h('button', {
                      className: 'rn-btn rn-btn-sm',
                      disabled: galLoading[0] || galOffset[0] <= 0,
                      onClick: function () { loadGallery(Math.max(0, galOffset[0] - 12), galRating[0]) },
                    }, '上一页'),
                    h('span', { className: 'rn-muted' }, '第 ' + (Math.floor(galOffset[0] / 12) + 1) + ' 页 · 共 ' + (gallery[0].total || 0) + ' 张'),
                    h('button', {
                      className: 'rn-btn rn-btn-sm',
                      disabled: galLoading[0] || galOffset[0] + 12 >= (gallery[0].total || 0),
                      onClick: function () { loadGallery(galOffset[0] + 12, galRating[0]) },
                    }, '下一页')))),

        // ---- Gems 流水 ----
        h('div', { className: 'rn-card' },
          h('details', {
            className: 'rn-details',
            onToggle: function (e) {
              ledgerOpen[1](e.target.open)
              if (e.target.open && ledger[0] === null) loadLedger()
            },
          },
            h('summary', null, 'Gems 流水' + (ledger[0] && ledger[0].ok ? '（最近 ' + (ledger[0].items || []).length + ' 条）' : '')),
            ledgerBlock))) : null,

        // ---- 从图片导入参数（法术解析） ----
        h('div', { className: 'rn-card' },
          h('div', { className: 'rn-card-title' }, '从图片导入参数（法术解析）'),
          h('div', { className: 'rn-hint' }, '选一张 NovelAI 或 A1111 生成的图（PNG/JPEG），自动读出提示词/负面词/步数/CFG/种子/采样器/尺寸，填进默认参数，提示词同时填到"测试提示词"，可直接重画。'),
          h('input', {
            className: 'rn-input',
            type: 'file',
            accept: 'image/png,image/jpeg',
            disabled: extractBusy[0],
            onChange: doExtractFile,
          }),
          extractBusy[0] ? h('div', { className: 'rn-hint' }, '解析中…') : null,
          extractRes[0]
            ? (extractRes[0].ok
              ? h('div', { className: 'rn-result' },
                  h('div', null, '✓ 已导入（' + (extractRes[0].format || '') + '）'),
                  h('div', { className: 'rn-muted' },
                    '步数 ' + (extractRes[0].params.steps ?? '—') + ' · CFG ' + (extractRes[0].params.scale ?? '—') +
                    ' · 种子 ' + (extractRes[0].params.seed ?? '—') + ' · ' + (extractRes[0].params.width || '?') + '×' + (extractRes[0].params.height || '?') +
                    ' · ' + (extractRes[0].params.sampler || '') + ' · ' + (extractRes[0].params.model || '')),
                  extractRes[0].params.prompt ? h('div', { className: 'rn-hint' }, '提示词已填入"测试提示词"（点下面的「保存配置」可保存为默认）') : null)
              : h('div', { className: 'rn-result rn-err' }, '解析失败：' + (extractRes[0].error || '未知') + (extractRes[0].meta && extractRes[0].meta.keys && extractRes[0].meta.keys.length ? '（读到的元数据字段：' + extractRes[0].meta.keys.join(',') + '）' : '')))
            : null),

        // ---- 默认参数 ----
        h('div', { className: 'rn-card' },
          h('div', { className: 'rn-card-title' }, '默认出图参数'),
          h('div', { className: 'rn-row' },
            h(ComboField, {
              label: isBuiltin ? ('模型（网站全部 ' + modelList.length + ' 个）') : '模型',
              value: f.model,
              options: modelList.map(function (m) { return [m, modelLabel(m)] }),
              onChange: function (v) { setF({ model: v }) },
              placeholder: '模型 ID，如 gpt-image-1',
            }),
            h(Field, { label: '宽 × 高' },
              h('div', { className: 'rn-pair' },
                h('input', { className: 'rn-input', type: 'number', value: f.width, onChange: function (e) { setF({ width: Number(e.target.value) }) } }),
                h('input', { className: 'rn-input', type: 'number', value: f.height, onChange: function (e) { setF({ height: Number(e.target.value) }) } })))),
          h('div', { className: 'rn-hint' }, isBuiltin ? '只列可用的文生图模型（inpainting 需底图，已不在列表）。' : '自定义站请填服务商支持的模型 ID（如 gpt-image-1 / dall-e-3）。'),
          h('div', { className: 'rn-row' },
            h(Field, { label: '步数' },
              h('input', { className: 'rn-input', type: 'number', value: f.steps, onChange: function (e) { setF({ steps: Number(e.target.value) }) } })),
            h(Field, { label: 'CFG (scale)' },
              h('input', { className: 'rn-input', type: 'number', step: '0.1', value: f.scale, onChange: function (e) { setF({ scale: Number(e.target.value) }) } })),
            h(ComboField, {
              label: '采样器',
              value: f.sampler,
              options: SAMPLER_OPTS.map(function (o) { return [o[0], o[1] + ' · ' + o[0]] }),
              onChange: function (v) { setF({ sampler: v }) },
              placeholder: '采样器名，可自定义',
            }),
            h(ComboField, {
              label: '噪声调度',
              value: f.noise_schedule,
              options: SCHEDULE_OPTS.map(function (o) { return [o[0], o[1] + ' · ' + o[0]] }),
              onChange: function (v) { setF({ noise_schedule: v }) },
              placeholder: '调度名，可自定义',
            })),
          h(Field, { label: '默认负面词', hint: '工具里不传 negative 时用这份。' },
            h('textarea', { className: 'rn-area', rows: 2, value: f.negativePrompt, onChange: function (e) { setF({ negativePrompt: e.target.value }) } })),
          h(Field, { label: '默认附加串', hint: '自动拼在每次 prompt 末尾（画师串 / 质量串放这里）。' },
            h('textarea', { className: 'rn-area', rows: 3, value: f.promptSuffix, onChange: function (e) { setF({ promptSuffix: e.target.value }) } })),
          h('label', { className: 'rn-radio' },
            h('input', { type: 'checkbox', checked: f.qualityToggle, onChange: function (e) { setF({ qualityToggle: e.target.checked }) } }),
            h('span', null, 'qualityToggle（内置质量词增强）')),
          h(Field, { label: 'UC 预设', hint: '负面词预设强度（NovelAI uc_preset）' },
            h('select', { className: 'rn-input', value: f.ucPreset, onChange: function (e) { setF({ ucPreset: Number(e.target.value) }) } },
              [[0, 'Heavy 强'], [1, 'Light 轻'], [2, 'Human focus 人物'], [3, 'None 无']].map(function (o) { return h('option', { key: o[0], value: o[0] }, o[1]) }))),
          h('div', { className: 'rn-btnrow' },
            h('button', { className: 'rn-btn rn-btn-primary', onClick: save }, '保存配置'),
            h('button', { className: 'rn-btn', onClick: doResetDefaults }, '恢复默认出图设置'))),

        // ---- 工具箱（暂不可用：站点未给图片工具配价，整块禁用防误触） ----
        h('div', { className: 'rn-card rn-card-off' },
          h('div', { className: 'rn-card-title' }, '工具箱（暂不可用）'),
          h('div', { className: 'rn-banner' }, '⚠ 站点暂未给图片工具配置价格（会返回 PRICE_NOT_CONFIGURED），已禁用避免误触。等站点配价后可启用。'),
          h('input', { className: 'rn-input', type: 'file', accept: 'image/png,image/jpeg', disabled: true }),
          h('div', { className: 'rn-row rn-row-tight' },
            h(Field, { label: '工具' },
              h('select', { className: 'rn-input', value: toolType[0], disabled: true },
                TOOL_GROUPS.map(function (g) { return h('option', { key: g[0], value: g[0] }, g[1]) }))),
            h('div', { className: 'rn-buy' },
              h('button', { className: 'rn-btn rn-btn-primary', disabled: true }, '执行'))),
          h('div', { className: 'rn-hint' }, '功能：放大 / 表情 / 抠图 / 上色 / 去杂物 / 线稿 / 草图 / 打标 / 边缘 / 深度 / 姿势。')),

        h('div', { className: 'rn-card rn-card-off' },
          h('div', { className: 'rn-card-title' }, '批次任务（站点未开放，已禁用）'),
          h('div', { className: 'rn-banner' }, '⚠ 站点「批次任务」当前未启用（enabled=false）。已置灰避免误触；等站点开放后再启用。'),
          h('input', { className: 'rn-input', type: 'file', disabled: true }),
          h('div', { className: 'rn-btnrow' },
            h('button', { className: 'rn-btn rn-btn-primary', disabled: true }, '提交批次'),
            h('button', { className: 'rn-btn', disabled: true }, '刷新批次列表'))),

        // ---- 操作 ----
        h('div', { className: 'rn-card' },
          h('div', { className: 'rn-card-title' }, '测试'),
          h('div', { className: 'rn-btnrow' },
            h('button', { className: 'rn-btn', onClick: runTest, disabled: testing[0] }, testing[0] ? '测试中…' : '测试连接'),
            h('button', { className: 'rn-btn', onClick: runGenerate, disabled: generating[0] }, generating[0] ? '出图中（10–60s）…' : '测试出图'),
            h('button', { className: 'rn-btn', onClick: doQuote, disabled: quoteBusy[0] }, quoteBusy[0] ? '预估中…' : '预估（不扣费）')),
          h(Field, { label: '测试提示词' },
            h('input', { className: 'rn-input', value: genPrompt[0], onChange: function (e) { genPrompt[1](e.target.value) } })),
          testResult[0]
            ? h('div', { className: 'rn-result' + (testResult[0].ok === false ? ' rn-err' : '') },
                testResult[0].ok === false
                  ? '测试失败：' + (testResult[0].error || '未知')
                  : h('div', null,
                      h('div', null, '模型表：' + (testResult[0].modelsOk ? (testResult[0].models || []).length + ' 个可用' : '读取失败')),
                      h('div', null, '凭据：' + (testResult[0].keyValid === true ? ('Key 有效' + (isBuiltin ? '（免费询价通过）' : '')) : testResult[0].keyValid === false ? 'Key 无效：' + (testResult[0].keyError || '') : '还没配 Key')),
                      testResult[0].account ? h('div', null, '账户：' + (testResult[0].account.username || '') + ' · Gems ' + (testResult[0].account.balance_gems ?? '?') + ' · 图包 ' + (testResult[0].account.image_pack_credits ?? '?') + ' 张') : null,
                      testResult[0].quoteSample ? h('div', null, '默认参数报价：' + JSON.stringify(testResult[0].quoteSample)) : null,
                      testResult[0].loginError ? h('div', { className: 'rn-err' }, '登录：' + testResult[0].loginError) : null))
            : null,
          quoteRes[0]
            ? h('div', { className: 'rn-result' + (quoteRes[0].ok === false ? ' rn-err' : '') },
                quoteRes[0].ok === false
                  ? '预估失败：' + (quoteRes[0].error || quoteRes[0].message || '未知')
                  : '预估：' + ((quoteRes[0].quote && (quoteRes[0].quote.total_gems !== undefined ? quoteRes[0].quote.total_gems : (quoteRes[0].quote.job && quoteRes[0].quote.job.cost_gems))) ?? '?') + ' Gems（不扣费） · ' + (quoteRes[0].model || ''))
            : null,
          genResult[0]
            ? h('div', { className: 'rn-result' + (genResult[0].ok === false ? ' rn-err' : '') },
                genResult[0].ok === false
                  ? '出图失败：' + (genResult[0].error || '未知')
                  : h('div', null,
                      h('div', null, '✓ 出了 ' + (genResult[0].count || 0) + ' 张' + (isBuiltin ? ' · ' + (genResult[0].cost_gems || 0) + ' Gems' : '') + ' · seed ' + genResult[0].seed),
                      h('div', { className: 'rn-thumbs' }, (genResult[0].paths || []).map(function (p) {
                        return h('img', { key: p, className: 'rn-thumb', src: thumbUrl(p), title: p })
                      }))))
            : null),

        lastPaths.length > 0
          ? h('div', { className: 'rn-card' },
              h('div', { className: 'rn-card-title' }, '最近一次生成'),
              h('div', { className: 'rn-muted' }, String(state.lastGeneration.at || '') + (isBuiltin ? ' · ' + (state.lastGeneration.cost_gems || 0) + ' Gems' : '') + ' · ' + (state.lastGeneration.model || '')),
              h('div', { className: 'rn-thumbs' }, lastPaths.map(function (p) {
                return h('img', { key: p, className: 'rn-thumb', src: thumbUrl(p), title: p })
              })))
          : null,

        h('div', { className: 'rn-foot' },
          h('span', { className: 'rn-muted' }, '图片目录：' + String(state.mediaDir || '')),
          h('span', { className: 'rn-muted' }, '配置文件：' + String(state.configPath || ''))),

        h(Toast, { toast: toast[0] }))
    }

    // ---- 会话页悬浮球（快速打开插件设置） --------------------------------

    function FloatingWidget() {
      var open = useState(false)
      var savedPos = null
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          var rawPos = window.localStorage.getItem('dsh-rinko-nai-fab-pos')
          if (rawPos) savedPos = JSON.parse(rawPos)
        }
      } catch (e) { savedPos = null }
      var pos = useState(savedPos) // {x,y} 拖动后的左上角像素；null=默认右下角
      var drag = useRef({ active: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 })
      var isOpen = open[0]

      // 记住悬浮球位置
      useEffect(function () {
        try {
          if (typeof window !== 'undefined' && window.localStorage && pos[0]) {
            window.localStorage.setItem('dsh-rinko-nai-fab-pos', JSON.stringify(pos[0]))
          }
        } catch (e) { /* ignore */ }
      }, [pos[0]])

      useEffect(function () {
        function onMove(e) {
          var d = drag.current
          if (!d || !d.active) return
          var dx = e.clientX - d.sx
          var dy = e.clientY - d.sy
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true
          var maxX = (window.innerWidth || 1920) - 68
          var maxY = (window.innerHeight || 1080) - 68
          var x = Math.min(maxX, Math.max(4, d.ox + dx))
          var y = Math.min(maxY, Math.max(4, d.oy + dy))
          pos[1]({ x: x, y: y })
        }
        function onUp() {
          if (drag.current) drag.current.active = false
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp, true)
        window.addEventListener('pointercancel', onUp, true)
        return function () {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp, true)
          window.removeEventListener('pointercancel', onUp, true)
        }
      }, [])

      function onDown(e) {
        var el = e.currentTarget
        var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0 }
        drag.current = { active: true, moved: false, sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top }
        if (e.preventDefault) e.preventDefault()
      }
      function onClick(e) {
        // 拖动过就不算点击
        if (drag.current && drag.current.moved) { drag.current.moved = false; return }
        open[1](!open[0])
      }

      var rootStyle = pos[0]
        ? { left: pos[0].x + 'px', top: pos[0].y + 'px', right: 'auto', bottom: 'auto' }
        : null

      return h('div', { className: 'rn-fab-root', style: rootStyle },
        isOpen
          ? h('div', {
              className: 'rn-fab-backdrop',
              onClick: function () { open[1](false) },
            },
              h('div', {
                className: 'rn-fab-panel',
                onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation() },
              },
                h('div', { className: 'rn-fab-panel-head' },
                  h('span', { className: 'rn-fab-panel-title' }, 'Rinko NAI'),
                  h('button', {
                    className: 'rn-fab-close',
                    title: '关闭',
                    onClick: function () { open[1](false) },
                  }, '×')),
                h('div', { className: 'rn-fab-panel-body' }, h(RinkoSection, {}))))
          : null,
        h('button', {
          className: 'rn-fab' + (isOpen ? ' rn-fab-on' : ''),
          title: 'Rinko NAI · 快速设置（可拖动）',
          onPointerDown: onDown,
          onClick: onClick,
        }, h('img', { className: 'rn-fab-img', src: API + '/asset/sticker', alt: 'Rinko NAI', draggable: 'false' })))
    }

    // ---- 样式 -------------------------------------------------------------

    var CSS = [
      '.rn-root{display:flex;flex-direction:column;gap:14px;color:var(--rn-fg);font-size:13px;line-height:1.55;}',
      '.rn-root{--rn-fg:var(--dsw-alias-label-primary,#241f18);--rn-muted:var(--dsw-alias-label-secondary,#6f6558);--rn-faint:var(--dsw-alias-label-tertiary,#9a9084);--rn-card:var(--dsw-alias-bg-primary,#fffdf8);--rn-bar:var(--dsw-alias-bg-secondary,#f6f2ea);--rn-field:var(--dsw-alias-bg-input,#fbf8f2);--rn-line:var(--dsw-alias-border-primary,#e0d7c8);--rn-line-soft:var(--dsw-alias-border-secondary,#ece5d8);--rn-brand:var(--dsw-alias-label-brand,#5b4b8a);--rn-ok:#2f6b46;--rn-err:#a83a2c;--rn-err-bg:rgba(168,58,44,.07);}',
      '.rn-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.rn-sites{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
      '.rn-site-tab{display:flex;flex-direction:column;gap:1px;align-items:flex-start;border:1px solid var(--rn-line);background:var(--rn-bar);border-radius:10px;padding:6px 12px;cursor:pointer;font-size:12.5px;color:var(--rn-fg);position:relative;}',
      '.rn-site-tab:hover{border-color:var(--rn-brand);}',
      '.rn-site-on{background:var(--rn-brand);border-color:var(--rn-brand);color:#fff;}',
      '.rn-site-name{font-weight:600;}',
      '.rn-site-host{font-size:10.5px;opacity:.75;}',
      '.rn-site-dot{position:absolute;top:6px;right:8px;width:6px;height:6px;border-radius:50%;background:var(--rn-line);}',
      '.rn-site-dot.rn-dot-ok{background:#3fbf6b;box-shadow:0 0 0 2px rgba(63,191,107,.25);}',
      '.rn-title{font-size:14.5px;font-weight:600;}',
      '.rn-bridge{font-size:11.5px;color:var(--rn-faint);border:1px solid var(--rn-line);border-radius:999px;padding:1px 9px;}',
      '.rn-bridge-ok{color:var(--rn-ok);border-color:var(--rn-ok);}',
      '.rn-muted{font-size:11.5px;color:var(--rn-muted);}',
      '.rn-card{background:var(--rn-card);border:1px solid var(--rn-line-soft);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;}',
      '.rn-card-off{opacity:.55;}',
      '.rn-card-off input,.rn-card-off select,.rn-card-off button{cursor:not-allowed;}',
      '.rn-card-title{font-size:12.5px;font-weight:600;color:var(--rn-muted);letter-spacing:.02em;}',
      '.rn-row{display:flex;gap:12px;flex-wrap:wrap;}',
      '.rn-field{display:flex;flex-direction:column;gap:4px;min-width:180px;flex:1;}',
      '.rn-label{font-size:12px;color:var(--rn-muted);}',
      '.rn-hint{font-size:11.5px;color:var(--rn-faint);line-height:1.6;}',
      '.rn-banner{background:rgba(200,140,30,.12);border:1px solid rgba(200,140,30,.5);color:#8a5a10;border-radius:10px;padding:9px 13px;font-size:12px;line-height:1.6;}',
      '.rn-input,.rn-area{background:var(--rn-field);border:1px solid var(--rn-line);border-radius:8px;padding:7px 10px;font-size:13px;color:var(--rn-fg);outline:none;width:100%;box-sizing:border-box;}',
      '.rn-input:focus,.rn-area:focus{border-color:var(--rn-brand);}',
      '.rn-area{resize:vertical;font-family:inherit;}',
      '.rn-pair{display:flex;gap:8px;align-items:center;}',
      '.rn-radio{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--rn-fg);cursor:pointer;}',
      '.rn-radio input{accent-color:var(--rn-brand);}',
      '.rn-btnrow{display:flex;gap:8px;flex-wrap:wrap;}',
      '.rn-linkrow{display:flex;gap:14px;flex-wrap:wrap;margin-top:2px;}',
      '.rn-act-list{display:flex;flex-direction:column;gap:8px;}',
      '.rn-act{background:var(--rn-bar);border:1px solid var(--rn-line-soft);border-radius:10px;padding:9px 12px;display:flex;flex-direction:column;gap:3px;}',
      '.rn-act-click{cursor:pointer;transition:border-color .15s,transform .1s;}',
      '.rn-act-click:hover{border-color:var(--rn-brand);transform:translateY(-1px);}',
      '.rn-act-head{display:flex;align-items:center;gap:8px;justify-content:space-between;}',
      '.rn-act-title{font-weight:600;font-size:13px;}',
      '.rn-ta{width:100%;box-sizing:border-box;border:1px solid var(--rn-line);border-radius:8px;padding:8px 10px;font:inherit;font-size:12.5px;resize:vertical;background:#fff;color:inherit;}',
      '.rn-fieldrow{display:flex;gap:8px;align-items:center;margin:6px 0;}',
      '.rn-label{width:78px;flex:none;font-size:12px;color:var(--rn-muted);}',
      '.rn-adv summary{cursor:pointer;font-size:12px;color:var(--rn-brand);user-select:none;}',
      '.rn-tag{font-size:10.5px;color:#fff;background:var(--rn-brand);border-radius:999px;padding:1px 8px;white-space:nowrap;}',
      '.rn-act-sum{font-size:12px;color:var(--rn-muted);}',
      '.rn-act-meta{font-size:11px;color:var(--rn-faint);}',
      '.rn-row-tight{align-items:flex-end;gap:10px;margin-top:2px;}',
      '.rn-buy{display:flex;align-items:flex-end;}',
      '.rn-chiprow{display:flex;gap:8px;flex-wrap:wrap;margin:2px 0;}',
      '.rn-chip{border:1px solid var(--rn-line);background:var(--rn-bar);border-radius:999px;padding:4px 14px;font-size:12.5px;cursor:pointer;color:var(--rn-fg);}',
      '.rn-chip-on{background:var(--rn-brand);border-color:var(--rn-brand);color:#fff;}',
      '.rn-link{background:none;border:none;padding:0;color:var(--rn-brand);font-size:12.5px;cursor:pointer;text-decoration:underline;text-underline-offset:2px;}',
      '.rn-link:hover{opacity:.8;}',
      '.rn-btn{border:1px solid var(--rn-line);background:var(--rn-bar);color:var(--rn-fg);border-radius:999px;padding:6px 14px;font-size:12.5px;cursor:pointer;}',
      '.rn-btn:hover{border-color:var(--rn-brand);}',
      '.rn-btn:disabled{opacity:.55;cursor:default;}',
      '.rn-btn-primary{background:var(--rn-brand);border-color:var(--rn-brand);color:#fff;}',
      '.rn-result{background:var(--rn-bar);border:1px solid var(--rn-line-soft);border-radius:10px;padding:9px 12px;font-size:12.5px;display:flex;flex-direction:column;gap:4px;word-break:break-all;}',
      '.rn-result.rn-err{color:var(--rn-err);border-color:var(--rn-err);}',
      '.rn-thumbs{display:flex;gap:8px;flex-wrap:wrap;}',
      '.rn-thumb{width:120px;height:120px;object-fit:cover;border-radius:8px;border:1px solid var(--rn-line);}',
      '.rn-foot{display:flex;flex-direction:column;gap:3px;}',
      '.rn-loading{color:var(--rn-muted);padding:18px 0;font-size:12.5px;}',
      '.rn-error{color:var(--rn-err);background:var(--rn-err-bg);border:1px solid var(--rn-err);border-radius:10px;padding:10px 13px;font-size:12.5px;line-height:1.6;}',
      '.rn-err{color:var(--rn-err);font-size:11.5px;}',
      '.rn-details{border-top:1px dashed var(--rn-line-soft);padding-top:8px;}',
      '.rn-details summary{cursor:pointer;font-size:12px;color:var(--rn-muted);outline:none;}',
      '.rn-details[open] summary{margin-bottom:8px;}',
      '.rn-toast{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:9px 13px;border-radius:10px;border:1px solid var(--rn-line);background:var(--rn-bar);color:var(--rn-fg);position:fixed;right:18px;bottom:18px;z-index:60;}',
      '.rn-toast-ok::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--rn-ok);}',
      '.rn-toast-err{color:var(--rn-err);border-color:var(--rn-err);}',
      '.rn-fab-root{position:fixed;right:22px;bottom:96px;z-index:2147483000;}',
      '.rn-fab{width:60px;height:60px;border-radius:50%;border:none;padding:0;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;background:#fff8ef;box-shadow:0 6px 20px rgba(0,0,0,.28);overflow:hidden;transition:transform .15s ease,box-shadow .15s ease;}',
      '.rn-fab:active{cursor:grabbing;}',
      '.rn-fab:hover{transform:scale(1.08);box-shadow:0 10px 26px rgba(0,0,0,.34);}',
      '.rn-fab-on{transform:scale(.92);}',
      '.rn-fab-img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.rn-fab-backdrop{position:fixed;inset:0;background:rgba(20,16,12,.42);display:flex;align-items:flex-end;justify-content:flex-end;padding:0 18px 170px 0;z-index:2147483000;}',
      '.rn-fab-panel{width:min(520px,94vw);max-height:78vh;background:var(--rn-card,#fffdf8);border:1px solid var(--rn-line,#e0d7c8);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;}',
      '.rn-fab-panel-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--rn-line-soft,#ece5d8);font-weight:600;font-size:13.5px;}',
      '.rn-fab-close{border:none;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:var(--rn-muted,#6f6558);padding:0 4px;}',
      '.rn-fab-close:hover{color:var(--rn-err,#a83a2c);}',
      '.rn-fab-panel-body{overflow:auto;padding:14px;}',
      '.rn-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}',
      '.rn-btn-sm{padding:4px 11px;font-size:12px;}',
      '.rn-select{width:auto;padding:4px 8px;font-size:12px;}',
      '.rn-stats{display:flex;gap:10px;flex-wrap:wrap;}',
      '.rn-stat{background:var(--rn-bar);border:1px solid var(--rn-line-soft);border-radius:10px;padding:8px 14px;display:flex;flex-direction:column;gap:2px;min-width:96px;}',
      '.rn-stat-num{font-size:19px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums;}',
      '.rn-stat-lbl{font-size:11px;color:var(--rn-muted);}',
      '.rn-gal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:10px;}',
      '.rn-gal-item{display:flex;flex-direction:column;gap:3px;min-width:0;}',
      '.rn-gal-thumb{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:8px;border:1px solid var(--rn-line);cursor:zoom-in;background:var(--rn-bar);}',
      '.rn-gal-title{font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.rn-gal-meta{font-size:10.5px;color:var(--rn-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.rn-gal-nav{align-items:center;margin-top:4px;}',
      '.rn-ledger{display:flex;flex-direction:column;gap:4px;font-size:11.5px;}',
      '.rn-ledger-row{display:grid;grid-template-columns:112px 1fr 64px 76px;gap:8px;align-items:center;padding:3px 0;border-bottom:1px dashed var(--rn-line-soft);}',
      '.rn-ledger-time,.rn-ledger-bal{color:var(--rn-faint);font-variant-numeric:tabular-nums;}',
      '.rn-ledger-amt{text-align:right;font-variant-numeric:tabular-nums;color:var(--rn-err);}',
      '.rn-ledger-amt.rn-plus{color:var(--rn-ok);}',
    ].join('')

    // ---- 注册 -------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-rinko-nai-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-rinko-nai: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'rinko-nai',
          order: 47,
          locale: NS,
          label: function () { return 'Rinko NAI' },
        }, function (props) {
          return h(RinkoSection, props !== null && props !== undefined ? props : {})
        })
      })

      // 会话页右下角悬浮球 → 点开插件设置
      try {
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({
            name: 'shell.overlay',
            id: 'rinko-nai-fab',
            locale: NS,
          }, function () {
            return h(FloatingWidget, {})
          })
        })
      } catch (e) { /* 某些 shell 没有 shell.overlay，忽略即可 */ }
    }

    module.exports = {
      name: 'rinko-nai',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
