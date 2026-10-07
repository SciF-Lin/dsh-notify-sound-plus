/*!
 * dsh-notify-sound-plus — 客户端半区（Client half）
 *
 * 由 @deepseek-ai/dsh-client-modules 自动扫描 package.json 的 dsh.client 声明，
 * 经 /plugins 路由下发到页面，作为 __ModuleLoader__ 工厂执行。**手写 CJS**，
 * 不引入打包器：外部依赖只有平台种子表里的 react 与官方 ui-primitives。
 *
 * 职责（严格只做这三件事）：
 *   ① UI：在「通用设置」放一行摘要 + 齿轮按钮（齿轮打开官方 Modal 承载完整设置）；
 *      在对话输入框左下角放一个喇叭按钮。
 *   ② 出声：轮询 /dsh-notify/state，宿主说该提示（sound != 'none'）就播那个声音。
 *   ③ 系统通知：宿主说 notify=true 时弹一条系统通知（桌面通知中心/浏览器通知）。
 *
 * 「该不该提示」的判定**全在宿主**（见 lib/index.js 的 resolveSound/resolveNotify）；
 * 这里不做任何模式/静音/小鲸鱼判断，避免前后端各判一半导致行为不一致。
 *
 * ⚠️ 官方 ui-primitives 是**可选**依赖：整个包必须能在缺它时降级运行
 *    （自绘控件），否则一旦宿主版本不同就会整块 UI 白掉。见 PRIMITIVES 探测。
 */
window.__ModuleLoader__.load({
  // id 必须 === package.json 的 name：宿主用「解析出的包名」标识浏览器模块
  id: 'dsh-notify-sound-plus',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var ROUTE = '/dsh-notify'
    var POLL_MS = 900
    var PLUGIN_ID = 'dsh-notify-sound-plus'

    // ======================================================= 官方组件（可选依赖）
    // 官方 ui-primitives 提供 Menu / Button / Modal / Switch 等原子组件。
    // 它应当在平台种子表里，但**不能假设一定在**：拿不到就整体降级成自绘控件，
    // 绝不能因为缺一个组件就让设置行白掉。
    var P = null
    try { P = require('@deepseek-ai/dsh-client-ui-primitives') } catch (err) { P = null }
    function prim(name) {
      return P && typeof P[name] === 'function' ? P[name] : null
    }
    var hasPrimitives = !!(P && prim('Menu') && prim('Button'))
    if (!hasPrimitives) {
      try {
        console.warn('[dsh-notify-sound-plus] 官方 ui-primitives 不可用，已降级为内置控件')
      } catch (err) {}
    }

    // ============================================================ 合成音色表
    // 每个音符 { f: 频率Hz, t: 起始秒, d: 持续秒, p: 峰值, w: 波形 }
    // 四段默认旋律的音高集合互不相同，闭眼也能分辨是哪个事件。
    var TONES = {
      'default:done': [
        { f: 1318.51, t: 0.0, d: 0.16, p: 0.5, w: 'sine' },
        { f: 880.0, t: 0.15, d: 0.34, p: 0.46, w: 'sine' },
      ],
      'default:question': [
        { f: 1174.66, t: 0.0, d: 0.14, p: 0.42, w: 'sine' },
        { f: 1479.98, t: 0.13, d: 0.14, p: 0.42, w: 'sine' },
        { f: 1760.0, t: 0.26, d: 0.36, p: 0.44, w: 'sine' },
      ],
      'default:approval': [
        { f: 880.0, t: 0.0, d: 0.11, p: 0.5, w: 'triangle' },
        { f: 880.0, t: 0.17, d: 0.11, p: 0.5, w: 'triangle' },
        { f: 1318.51, t: 0.34, d: 0.4, p: 0.5, w: 'triangle' },
      ],
      'default:error': [
        { f: 783.99, t: 0.0, d: 0.2, p: 0.44, w: 'sine' },
        { f: 523.25, t: 0.19, d: 0.5, p: 0.5, w: 'sine' },
      ],
      'preset:chime': [
        { f: 1567.98, t: 0.0, d: 0.22, p: 0.46, w: 'sine' },
        { f: 1046.5, t: 0.13, d: 0.6, p: 0.44, w: 'sine' },
      ],
      'preset:bell': [
        { f: 1760.0, t: 0.0, d: 0.5, p: 0.38, w: 'sine' },
        { f: 2637.02, t: 0.01, d: 0.34, p: 0.2, w: 'sine' },
        { f: 1318.51, t: 0.02, d: 0.7, p: 0.16, w: 'sine' },
      ],
      'preset:soft': [
        { f: 659.25, t: 0.0, d: 0.26, p: 0.3, w: 'sine' },
        { f: 987.77, t: 0.18, d: 0.5, p: 0.28, w: 'sine' },
      ],
      'preset:alert': [
        { f: 987.77, t: 0.0, d: 0.12, p: 0.42, w: 'square' },
        { f: 987.77, t: 0.2, d: 0.12, p: 0.42, w: 'square' },
        { f: 987.77, t: 0.4, d: 0.2, p: 0.42, w: 'square' },
      ],
    }

    var EVENT_META = [
      { kind: 'done', label: '任务完成' },
      { kind: 'question', label: '需要我回答' },
      { kind: 'approval', label: '需要我授权' },
      { kind: 'error', label: '出错' },
    ]

    // ================================================================ 样式
    var CSS = [
      '.dshns-row{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0;display:flex;flex-direction:column;gap:10px}',
      '.dshns-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshns-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;flex:1;min-width:120px}',
      '.dshns-menuAnchor{display:inline-flex;align-items:center;flex:none}',
      '.dshns-row .dshns-menuTrigger{min-width:112px;justify-content:space-between}',
      '.dshns-iconbtn{flex:none}',
      '.dshns-tri{font-size:11px;line-height:1}',
      '.dshns-mode{flex:none;width:112px;height:30px}',
      '.dshns-btn{border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}',
      '.dshns-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshns-btn:disabled{opacity:.5;cursor:default}',
      '.dshns-select{min-width:100px;max-width:260px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);border:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;height:30px;padding:0 8px;cursor:pointer}',
      '.dshns-chk{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;flex:none}',
      '.dshns-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dshns-vol{display:flex;align-items:center;gap:10px}',
      '.dshns-vol>input{flex:1;max-width:240px}',
      '.dshns-range{flex:1;max-width:200px}',
      '.dshns-volv{color:var(--dsw-alias-label-secondary);font-size:12px;width:36px;text-align:right;flex:none}',
      '.dshns-customs{display:flex;flex-direction:column;gap:4px}',
      '.dshns-custom{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dshns-customname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}',
      '.dshns-x{border:none;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:12px;cursor:pointer;padding:2px 6px}',
      '.dshns-msg{font-size:12px;color:var(--dsw-alias-state-warn-primary)}',
      // 独立设置界面（官方 Modal 内的内容；降级时是自绘 sheet）
      '.dshns-panel{display:flex;flex-direction:column;gap:8px;min-width:340px;max-width:520px}',
      '.dshns-pSection{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;letter-spacing:.02em;margin-top:6px;padding-bottom:2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshns-pRows{display:flex;flex-direction:column}',
      '.dshns-pRow{display:flex;align-items:center;gap:12px;min-height:38px}',
      '.dshns-pLabel{color:var(--dsw-alias-label-primary);font-size:13px;width:82px;flex:none}',
      '.dshns-pCtl{display:flex;align-items:center;gap:8px;flex:1;min-width:0;justify-content:flex-end}',
      '.dshns-pHint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dshns-pHintInline{color:var(--dsw-alias-label-secondary);font-size:12px;flex:none}',
      '.dshns-overlay{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;padding:24px}',
      '.dshns-sheet{background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.24)}',
      '.dshns-sheetHead{display:flex;align-items:center;gap:12px;padding:16px 20px 8px}',
      '.dshns-sheetTitle{flex:1;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500}',
      '.dshns-sheetBody{padding:8px 20px 20px;overflow:auto}',
      '.dshns-mute{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:4px;border-radius:var(--dsw-radius-sm);display:inline-flex;align-items:center;line-height:0}',
      '.dshns-mute:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshns-mute[data-muted="1"]{color:var(--dsw-alias-state-warn-primary)}',
    ].join('')

    // ============================================================ 运行期单例
    // 两个 slot（设置行 / 喇叭按钮）共享同一个 runtime，这样静音状态在两边一致。
    var runtime = null

    function createRuntime() {
      var listeners = new Set()
      var state = {
        ready: false,
        muted: false,
        settings: null,     // 宿主下发的设置
        sounds: { builtin: [], custom: [] },
        lastSeq: 0,
        primed: false,
        error: '',
        lastTitle: '',
        lastSession: '',
        notifyPermission: 'default',
      }
      var audioCtx = null
      var masterGain = null
      var ctxBlocked = false
      var pendingSound = null
      var timer = null
      var disposed = false
      var urlCache = {}

      function emit() {
        for (var fn of Array.from(listeners)) {
          try { fn() } catch (err) {}
        }
      }

      function set(patch) {
        var changed = false
        for (var k in patch) {
          if (state[k] !== patch[k]) { state[k] = patch[k]; changed = true }
        }
        if (changed) emit()
      }

      function subscribe(fn) {
        listeners.add(fn)
        return function () { listeners.delete(fn) }
      }

      // ------------------------------------------------------------ 音频
      function ensureAudio() {
        try {
          var Ctor = window.AudioContext || window.webkitAudioContext
          if (!Ctor) return null
          if (!audioCtx) {
            audioCtx = new Ctor()
            masterGain = audioCtx.createGain()
            masterGain.gain.value = volumeOf()
            masterGain.connect(audioCtx.destination)
          }
          if (audioCtx.state === 'suspended') {
            var p = audioCtx.resume()
            if (p && typeof p.then === 'function') p.then(null, function () {})
          }
          return audioCtx
        } catch (err) { return null }
      }

      function volumeOf() {
        var v = state.settings && typeof state.settings.volume === 'number' ? state.settings.volume : 0.6
        return Math.min(1, Math.max(0, v))
      }

      function note(ctx, dest, n, startAt, vol) {
        try {
          var osc = ctx.createOscillator()
          var g = ctx.createGain()
          osc.type = n.w || 'sine'
          osc.frequency.setValueAtTime(n.f, startAt)
          var peak = Math.max(0.0001, n.p * vol)
          g.gain.setValueAtTime(0.0001, startAt)
          g.gain.exponentialRampToValueAtTime(peak, startAt + 0.008)
          g.gain.exponentialRampToValueAtTime(0.0001, startAt + n.d)
          osc.connect(g)
          g.connect(dest)
          osc.start(startAt)
          osc.stop(startAt + n.d + 0.03)
        } catch (err) {}
      }

      /**
       * 「应用在前台运行时不提示」只能由页面判断：只有页面知道窗口是否可见且有焦点。
       * 宿主那一层已经判完静音/模式/小鲸鱼，这一层只补这一个条件。
       */
      function focusedNow() {
        try {
          return document.visibilityState === 'visible' && document.hasFocus()
        } catch (err) { return false }
      }

      /** 播放一个声音 id。所有失败都静默（通知音绝不能反过来炸掉界面）。 */
      function play(soundId, opts) {
        if (!soundId || soundId === 'none') return
        var force = !!(opts && opts.force)
        if (!force && state.settings && state.settings.muteWhenFocused && focusedNow()) return
        if (soundId.indexOf('custom:') === 0) {
          playCustom(soundId.slice('custom:'.length))
          return
        }
        var melody = TONES[soundId]
        if (!melody) return
        var ctx = ensureAudio()
        if (!ctx) return
        if (ctx.state !== 'running') { ctxBlocked = true; pendingSound = soundId; return }
        ctxBlocked = false
        var vol = volumeOf()
        var now = ctx.currentTime + 0.02
        for (var i = 0; i < melody.length; i++) note(ctx, masterGain, melody[i], now + melody[i].t, vol)
      }

      function playCustom(id) {
        try {
          var url = urlCache[id] || (ROUTE + '/audio/' + encodeURIComponent(id))
          var el = new window.Audio(url)
          el.volume = volumeOf()
          var p = el.play()
          if (p && typeof p.catch === 'function') {
            p.catch(function () { ctxBlocked = true; pendingSound = 'custom:' + id })
          }
        } catch (err) {}
      }

      // ------------------------------------------------------- 系统通知
      /** 当前环境是否支持系统通知。 */
      function notificationsSupported() {
        try { return typeof window.Notification === 'function' } catch (err) { return false }
      }

      function permission() {
        try { return notificationsSupported() ? String(window.Notification.permission || 'default') : 'unsupported' } catch (err) { return 'unsupported' }
      }

      /** 请求通知权限（必须在用户手势里调用，否则浏览器直接拒绝）。 */
      function requestPermission() {
        if (!notificationsSupported()) return Promise.resolve('unsupported')
        try {
          var r = window.Notification.requestPermission()
          if (r && typeof r.then === 'function') {
            return r.then(function (v) { emit(); return v }, function () { emit(); return permission() })
          }
        } catch (err) {}
        emit()
        return Promise.resolve(permission())
      }

      var NOTIFY_TEXT = {
        done: { title: '任务完成', body: '这一轮已经跑完了' },
        question: { title: '需要你回答', body: '模型正在等你回答问题' },
        approval: { title: '需要你授权', body: '有操作在等你确认' },
        error: { title: '出错了', body: '这一轮以错误结束' },
      }

      /**
       * 弹一条系统通知。
       * 权限没给就静默跳过（不反复弹权限框骚扰用户）。
       * @param {'done'|'question'|'approval'|'error'} kind
       * @param {boolean} force 试听用：绕过权限检查之外的开关（权限仍必须已授予）
       */
      function notifySystem(kind, force) {
        if (!notificationsSupported()) return false
        if (permission() !== 'granted') return false
        var meta = NOTIFY_TEXT[kind] || NOTIFY_TEXT.done
        try {
          var title = meta.title
          var body = meta.body
          // 带上会话名，多个会话同时跑时能分清是哪一个
          var st = state.settings
          if (state.lastTitle) body = state.lastTitle + ' · ' + body
          var n = new window.Notification(title, {
            body: body,
            tag: PLUGIN_ID + ':' + kind + ':' + (state.lastSession || ''),
            silent: false,
          })
          try {
            n.onclick = function () {
              try { window.focus() } catch (err) {}
              try { n.close() } catch (err) {}
            }
          } catch (err) {}
          // 系统通知有时限，几秒后自己收掉，避免堆积
          if (force) {
            try { window.setTimeout(function () { try { n.close() } catch (err) {} }, 4000) } catch (err) {}
          }
          return true
        } catch (err) {
          return false
        }
      }

      /** 第一次真实手势时解锁自动播放，并补播被挡下的那一次。 */
      function unlock() {
        try {
          var ctx = ensureAudio()
          if (ctx && ctx.state === 'running' && ctxBlocked) {
            ctxBlocked = false
            var s = pendingSound
            pendingSound = null
            // 补播是用户手势触发的，此时不该再被「应用在前台运行时不提示」挡掉
            if (s) play(s, { force: true })
          }
        } catch (err) {}
      }

      var gestures = ['pointerdown', 'keydown', 'touchstart']
      for (var gi = 0; gi < gestures.length; gi++) {
        try { window.addEventListener(gestures[gi], unlock, { passive: true, capture: true }) }
        catch (err) { try { window.addEventListener(gestures[gi], unlock, true) } catch (e2) {} }
      }

      // ------------------------------------------------------------ 网络
      function fetchJson(url, opts) {
        var o = { cache: 'no-store', credentials: 'same-origin' }
        if (opts) for (var k in opts) o[k] = opts[k]
        return window.fetch(url, o).then(function (r) {
          if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : '?'))
          return r.json()
        })
      }

      function refreshSettings() {
        return fetchJson(ROUTE + '/settings.json').then(function (d) {
          if (disposed) return
          set({ settings: d.settings, muted: !!d.muted, ready: true, error: '' })
          if (masterGain) { try { masterGain.gain.value = volumeOf() } catch (err) {} }
        }).then(null, function (e) {
          if (!disposed) set({ error: '读取设置失败：' + (e && e.message ? e.message : e) })
        })
      }

      function refreshSounds() {
        return fetchJson(ROUTE + '/sounds.json').then(function (d) {
          if (disposed) return
          var custom = Array.isArray(d.custom) ? d.custom : []
          urlCache = {}
          for (var i = 0; i < custom.length; i++) {
            if (custom[i].url) urlCache[custom[i].id.replace(/^custom:/, '')] = custom[i].url
          }
          set({ sounds: { builtin: d.builtin || [], custom: custom } })
        }).then(null, function (e) {})
      }

      function saveSettings(patch) {
        // 乐观更新：先改本地，失败再回滚重取
        var prev = state.settings
        var next = mergeSettings(prev, patch)
        set({ settings: next })
        return fetchJson(ROUTE + '/settings.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }).then(function (d) {
          if (!disposed && d && d.settings) set({ settings: d.settings })
          if (masterGain) { try { masterGain.gain.value = volumeOf() } catch (err) {} }
        }).then(null, function (e) {
          if (disposed) return
          set({ settings: prev, error: '保存失败：' + (e && e.message ? e.message : e) })
        })
      }

      function setMuted(muted) {
        set({ muted: !!muted })
        return fetchJson(ROUTE + '/mute.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ muted: !!muted }),
        }).then(function (d) {
          if (!disposed && d && typeof d.muted === 'boolean') set({ muted: d.muted })
        }).then(null, function () {})
      }

      function toggleMuted() { return setMuted(!state.muted) }

      function uploadSound(file) {
        return new Promise(function (resolve, reject) {
          var reader = new window.FileReader()
          reader.onerror = function () { reject(new Error('读取文件失败')) }
          reader.onload = function () {
            var result = String(reader.result || '')
            var comma = result.indexOf(',')
            var b64 = comma >= 0 ? result.slice(comma + 1) : result
            fetchJson(ROUTE + '/audio', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: file.name ? file.name.replace(/\.[^.]+$/, '') : '自定义音效',
                mime: file.type || 'audio/mpeg',
                dataBase64: b64,
              }),
            }).then(function (d) {
              return refreshSounds().then(function () { resolve(d && d.sound) })
            }).then(null, reject)
          }
          reader.readAsDataURL(file)
        })
      }

      function deleteSound(id) {
        var raw = String(id || '').replace(/^custom:/, '')
        return fetchJson(ROUTE + '/audio/' + encodeURIComponent(raw), { method: 'DELETE' })
          .then(function () { return refreshSounds() })
          .then(null, function (e) { set({ error: '删除失败：' + (e && e.message ? e.message : e) }) })
      }

      // ------------------------------------------------------------ 轮询
      function poll() {
        if (disposed) return
        fetchJson(ROUTE + '/state').then(function (st) {
          if (disposed || !st) return
          var seq = Number(st.seq) || 0
          // 顺带同步静音/模式：多标签页或别处改过，这里要跟上
          if (typeof st.muted === 'boolean' && st.muted !== state.muted) set({ muted: st.muted })
          if (st.mode && state.settings && st.mode !== state.settings.mode) {
            set({ settings: mergeSettings(state.settings, { mode: st.mode }) })
          }
          if (!state.primed) {
            // 首次只对齐水位：刷新页面不该把旧通知再提示一遍
            state.primed = true
            state.lastSeq = seq
            return
          }
          if (seq <= state.lastSeq) return
          state.lastSeq = seq
          // 记下会话信息，系统通知里带上它好分辨是哪个会话
          if (st.title) state.lastTitle = String(st.title)
          if (st.session) state.lastSession = String(st.session)
          if (st.kind) state.lastKind = String(st.kind)
          // 宿主已经把「该不该提示」判好了，这里只认 sound / notify
          if (st.sound && st.sound !== 'none') play(st.sound)
          if (st.notify === true && st.kind) notifySystem(st.kind, false)
        }).then(null, function () {})
      }

      function start() {
        refreshSettings().then(refreshSounds).then(function () {
          if (disposed) return
          set({ notifyPermission: permission() })
          poll()
          timer = window.setInterval(poll, POLL_MS)
        })
      }

      function dispose() {
        disposed = true
        if (timer) { window.clearInterval(timer); timer = null }
        for (var i = 0; i < gestures.length; i++) {
          try { window.removeEventListener(gestures[i], unlock, true) } catch (err) {}
        }
        try { if (audioCtx && audioCtx.close) audioCtx.close() } catch (err) {}
        audioCtx = null
        masterGain = null
        listeners.clear()
      }

      return {
        state: state,
        subscribe: subscribe,
        emit: emit,
        set: set,
        start: start,
        dispose: dispose,
        play: play,
        unlock: unlock,
        refreshSettings: refreshSettings,
        refreshSounds: refreshSounds,
        saveSettings: saveSettings,
        setMuted: setMuted,
        toggleMuted: toggleMuted,
        uploadSound: uploadSound,
        deleteSound: deleteSound,
        notifySystem: notifySystem,
        requestPermission: requestPermission,
        notificationsSupported: notificationsSupported,
        permission: permission,
      }
    }

    function mergeSettings(base, patch) {
      var out = {
        mode: base && base.mode ? base.mode : 'on',
        volume: base && typeof base.volume === 'number' ? base.volume : 0.6,
        muteWhenFocused: !!(base && base.muteWhenFocused),
        events: {},
        system: { enabled: !!(base && base.system && base.system.enabled), events: {} },
      }
      var kinds = ['done', 'question', 'approval', 'error']
      for (var i = 0; i < kinds.length; i++) {
        var k = kinds[i]
        var b = base && base.events && base.events[k] ? base.events[k] : {}
        out.events[k] = { on: b.on !== false, sound: b.sound || ('default:' + k) }
        var sb = base && base.system && base.system.events ? base.system.events[k] : undefined
        // 默认：需要你处理的两类开，纯播报的两类关（与宿主 defaultSettings 一致）
        out.system.events[k] = typeof sb === 'boolean' ? sb : (k === 'question' || k === 'approval')
      }
      if (!patch || typeof patch !== 'object') return out
      if (patch.mode) out.mode = patch.mode
      if (typeof patch.volume === 'number') out.volume = Math.min(1, Math.max(0, patch.volume))
      if (typeof patch.muteWhenFocused === 'boolean') out.muteWhenFocused = patch.muteWhenFocused
      if (patch.events) {
        for (var j = 0; j < kinds.length; j++) {
          var kk = kinds[j]
          var p = patch.events[kk]
          if (!p || typeof p !== 'object') continue
          if (typeof p.on === 'boolean') out.events[kk].on = p.on
          if (typeof p.sound === 'string' && p.sound) out.events[kk].sound = p.sound
        }
      }
      if (patch.system && typeof patch.system === 'object') {
        if (typeof patch.system.enabled === 'boolean') out.system.enabled = patch.system.enabled
        if (patch.system.events && typeof patch.system.events === 'object') {
          for (var s = 0; s < kinds.length; s++) {
            var sk = kinds[s]
            if (typeof patch.system.events[sk] === 'boolean') out.system.events[sk] = patch.system.events[sk]
          }
        }
      }
      return out
    }

    // ============================================================ 共享 hooks
    function useRuntime() {
      var pair = React.useState(0)
      var bump = pair[1]
      React.useEffect(function () {
        if (!runtime) return undefined
        var off = runtime.subscribe(function () { bump(function (n) { return n + 1 }) })
        return off
      }, [])
      return runtime
    }

    // 事件元数据与模式选项提到模块作用域：两个组件（摘要行 / 设置面板）共用。
    var MODE_OPTIONS = [
      { id: 'on', label: '开启声音提示', hint: '所有事件都会发出声音提示' },
      { id: 'off', label: '关闭声音提示', hint: '所有事件都不发出声音提示' },
      { id: 'smart', label: '智能判断', hint: '小鲸鱼挂件已经提示的事件不重复提示（它没开的事件仍由本插件提示）' },
    ]

    function modeLabelOf(mode) {
      for (var i = 0; i < MODE_OPTIONS.length; i++) {
        if (MODE_OPTIONS[i].id === mode) return MODE_OPTIONS[i].label
      }
      return MODE_OPTIONS[0].label
    }
    function modeHintOf(mode) {
      for (var i = 0; i < MODE_OPTIONS.length; i++) {
        if (MODE_OPTIONS[i].id === mode) return MODE_OPTIONS[i].hint
      }
      return MODE_OPTIONS[0].hint
    }

    // ============================================== 官方风格的下拉（缺组件则降级）
    /**
     * 单选下拉。优先用官方 primitives 的 Menu（与「详细/简洁」那类下拉同款外观：
     * 药丸触发器 + 展开卡片 + 选中打勾）；拿不到官方组件时退回原生 <select>。
     *
     * @param props.items     [{ id, label }]
     * @param props.value     当前选中 id
     * @param props.onChange  (id) => void
     */
    function Dropdown(props) {
      var Menu = prim('Menu')
      var Button = prim('Button')
      var openPair = React.useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var items = props.items || []
      var current = null
      for (var i = 0; i < items.length; i++) if (items[i].id === props.value) current = items[i]

      // 降级路径：原生 select（功能完全一致，只是外观不跟官方）
      if (!Menu || !Button) {
        return h('select', {
          className: 'dshns-select' + (props.className ? ' ' + props.className : ''),
          value: props.value,
          disabled: !!props.disabled,
          title: props.title,
          onChange: function (e) { props.onChange(e.target.value) },
        }, items.map(function (it) {
          return h('option', { key: it.id, value: it.id }, it.label)
        }))
      }

      var Chevron = prim('IconChevronDownOutlineRegular')
      var ChevronUp = prim('IconChevronUpOutlineRegular')
      // Menu 的 className 落在 anchor 包装元素上；把调用方给的 class 一起带上，
      // 否则 .dshns-mode 这类布局类在官方路径下会被丢掉（降级路径却生效）。
      return h(Menu, {
        open: open,
        onClose: function () { setOpen(false) },
        onSelect: function (id) {
          setOpen(false)
          if (id !== props.value) props.onChange(id)
        },
        selectedId: props.value,
        selection: 'check',
        align: props.align || 'start',
        portal: true,
        className: 'dshns-menuAnchor' + (props.className ? ' ' + props.className : ''),
        anchor: h(Button, {
          variant: 'outline',
          size: 'sm',
          className: 'dshns-menuTrigger',
          disabled: !!props.disabled,
          title: props.title,
          icon: open
            ? (ChevronUp ? h(ChevronUp, { size: 14 }) : null)
            : (Chevron ? h(Chevron, { size: 14 }) : null),
          onClick: function () { setOpen(!open) },
        }, current ? current.label : (props.placeholder || '请选择')),
        items: items,
      })
    }

    /** 试听按钮：官方按钮 + 播放图标（无文字，hover 有提示）。 */
    function PreviewButton(props) {
      var Button = prim('Button')
      var Play = prim('IconPlayOutlineRegular')
      if (!Button) {
        return h('button', {
          className: 'dshns-iconbtn',
          type: 'button',
          title: props.title || '试听',
          'aria-label': props.title || '试听',
          onClick: props.onClick,
        }, h('span', { className: 'dshns-tri', 'aria-hidden': 'true' }, '▶'))
      }
      return h(Button, {
        variant: 'outline',
        size: 'sm',
        className: 'dshns-iconbtn',
        title: props.title || '试听',
        'aria-label': props.title || '试听',
        icon: Play ? h(Play, { size: 14 }) : null,
        onClick: props.onClick,
      })
    }

    /**
     * 齿轮按钮：打开独立设置界面。
     * 图标用官方 IconSettingsOutlineMedium（16px、笔画 1.3px）——就是侧边栏
     * 「通用设置」那一行用的同一个图标，保证两处外观完全一致；老宿主没有
     * Medium 时退回 Regular。
     */
    function GearButton(props) {
      var Button = prim('Button')
      var Gear = prim('IconSettingsOutlineMedium') || prim('IconSettingsOutlineRegular')
      if (!Button) {
        return h('button', {
          className: 'dshns-iconbtn',
          type: 'button',
          title: props.title || '设置',
          'aria-label': props.title || '设置',
          onClick: props.onClick,
        }, h('span', { 'aria-hidden': 'true' }, '⚙'))
      }
      return h(Button, {
        variant: 'ghost',
        size: 'sm',
        className: 'dshns-iconbtn',
        title: props.title || '设置',
        'aria-label': props.title || '设置',
        icon: Gear ? h(Gear, { size: 16 }) : null,
        onClick: props.onClick,
      })
    }

    /** 开关：官方 Switch，缺失时用原生 checkbox。 */
    function Toggle(props) {
      var Switch = prim('Switch')
      if (!Switch) {
        return h('input', {
          type: 'checkbox',
          checked: !!props.checked,
          disabled: !!props.disabled,
          title: props.title,
          onChange: function (e) { props.onChange(e.target.checked) },
        })
      }
      return h(Switch, {
        checked: !!props.checked,
        disabled: !!props.disabled,
        title: props.title,
        label: props.label || props.title || '',
        onChange: props.onChange,
      })
    }

    /** 承载独立设置界面的容器：官方 Modal，缺失时自绘遮罩层。 */
    function Panel(props) {
      var Modal = prim('Modal')
      if (Modal) {
        return h(Modal, {
          open: true,
          onClose: props.onClose,
          title: props.title,
          closeLabel: '关闭',
          className: 'dshns-modal',
        }, props.children)
      }
      return h('div', { className: 'dshns-overlay', role: 'presentation' },
        h('div', { className: 'dshns-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
          h('div', { className: 'dshns-sheetHead' },
            h('div', { className: 'dshns-sheetTitle' }, props.title),
            h('button', {
              className: 'dshns-x', type: 'button', 'aria-label': '关闭',
              onClick: props.onClose,
            }, '✕'),
          ),
          h('div', { className: 'dshns-sheetBody' }, props.children),
        ),
      )
    }

    // ================================================== 独立设置界面（齿轮打开）
    function SettingsPanel(props) {
      var rt = props.rt
      var s = rt.state
      var settings = s.settings
      var fileRef = React.useRef(null)
      var msgPair = React.useState('')
      var msg = msgPair[0]
      var setMsg = msgPair[1]
      if (!settings) return null

      var sys = settings.system || { enabled: false, events: {} }

      function setEvent(kind, patch) {
        var ev = {}
        ev[kind] = patch
        rt.saveSettings({ events: ev })
      }
      function setSysEvent(kind, on) {
        var ev = {}
        ev[kind] = on
        rt.saveSettings({ system: { events: ev } })
      }

      // 声音候选：内置 + 自定义
      var options = []
      for (var i = 0; i < s.sounds.builtin.length; i++) {
        options.push({ id: s.sounds.builtin[i].id, label: s.sounds.builtin[i].name })
      }
      for (var j = 0; j < s.sounds.custom.length; j++) {
        options.push({ id: s.sounds.custom[j].id, label: '自定义 · ' + s.sounds.custom[j].name })
      }
      function valueOf(kind) {
        var cur = settings.events[kind].sound
        for (var k = 0; k < options.length; k++) if (options[k].id === cur) return cur
        // 选中的自定义音已被删除 → 回落默认，避免下拉显示空白
        return 'default:' + kind
      }

      var perm = s.notifyPermission || 'default'
      var permText = perm === 'granted' ? '已授权'
        : perm === 'denied' ? '已被拒绝（需在浏览器/系统设置里恢复）'
          : perm === 'unsupported' ? '当前环境不支持'
            : '尚未授权'

      var eventRows = EVENT_META.map(function (meta) {
        var ev = settings.events[meta.kind]
        return h('div', { className: 'dshns-pRow', key: meta.kind },
          h('div', { className: 'dshns-pLabel' }, meta.label),
          h('div', { className: 'dshns-pCtl' },
            h(Toggle, {
              checked: ev.on !== false,
              disabled: settings.mode === 'off',
              label: meta.label,
              title: settings.mode === 'off' ? '总模式为「关闭声音提示」时不可单独开启' : '是否发出声音提示',
              onChange: function (v) { setEvent(meta.kind, { on: v }) },
            }),
            h(Dropdown, {
              items: options,
              value: valueOf(meta.kind),
              disabled: settings.mode === 'off' || ev.on === false,
              title: '选择声音',
              align: 'end',
              onChange: function (id) {
                setEvent(meta.kind, { sound: id })
                // 换完立刻试听，不用再去点播放按钮确认选对了
                rt.play(id, { force: true })
              },
            }),
            h(PreviewButton, {
              title: '试听「' + meta.label + '」的声音',
              onClick: function () { rt.play(valueOf(meta.kind), { force: true }) },
            }),
          ),
        )
      })

      // 系统通知：逐事件一行
      var sysRows = EVENT_META.map(function (meta) {
        return h('div', { className: 'dshns-pRow', key: 'sys-' + meta.kind },
          h('div', { className: 'dshns-pLabel' }, meta.label),
          h('div', { className: 'dshns-pCtl' },
            h(Toggle, {
              checked: sys.events[meta.kind] === true,
              disabled: !sys.enabled,
              label: meta.label,
              title: sys.enabled ? '这个事件是否弹系统通知' : '先打开上面的系统通知总开关',
              onChange: function (v) { setSysEvent(meta.kind, v) },
            }),
          ),
        )
      })

      var customLines = []
      for (var c = 0; c < s.sounds.custom.length; c++) {
        var item = s.sounds.custom[c]
        customLines.push(h('div', { className: 'dshns-custom', key: item.id },
          h('span', { className: 'dshns-customname' }, item.name),
          h('span', null, Math.max(1, Math.round(item.bytes / 1024)) + ' KB'),
          h('button', {
            className: 'dshns-x',
            type: 'button',
            onClick: function () {
              rt.deleteSound(item.id).then(function () { setMsg('已删除「' + item.name + '」') })
            },
          }, '删除'),
        ))
      }

      // 注意：模式不在这里 —— 它已经在「通用设置」那一行（二级页面）上显示了，
      // 弹窗里重复一份只会让人怀疑两处会不会不同步。
      return h(Panel, { title: '声音提醒设置', onClose: props.onClose },
        h('div', { className: 'dshns-panel' },
          // —— 声音提示 ——
          h('div', { className: 'dshns-pSection' }, '声音提示'),
          h('div', { className: 'dshns-pRows' }, eventRows),
          h('div', { className: 'dshns-pRow' },
            h('div', { className: 'dshns-pLabel' }, '音量'),
            h('div', { className: 'dshns-pCtl' },
              h('input', {
                className: 'dshns-range',
                type: 'range', min: 0, max: 1, step: 0.05,
                value: settings.volume,
                onChange: function (e) { rt.saveSettings({ volume: Number(e.target.value) }) },
              }),
              h('span', { className: 'dshns-volv' }, Math.round(settings.volume * 100) + '%'),
            ),
          ),
          h('div', { className: 'dshns-pRow' },
            h('div', { className: 'dshns-pLabel' }, '前台不提示'),
            h('div', { className: 'dshns-pCtl' },
              h(Toggle, {
                checked: !!settings.muteWhenFocused,
                label: '应用在前台运行时不提示',
                title: '应用在前台运行时不出声',
                onChange: function (v) { rt.saveSettings({ muteWhenFocused: v }) },
              }),
              h('span', { className: 'dshns-pHintInline' }, '应用在前台运行时不提示'),
            ),
          ),

          // —— 系统通知 ——
          h('div', { className: 'dshns-pSection' }, '系统通知'),
          h('div', { className: 'dshns-pRow' },
            h('div', { className: 'dshns-pLabel' }, '总开关'),
            h('div', { className: 'dshns-pCtl' },
              h(Toggle, {
                checked: !!sys.enabled,
                label: '系统通知',
                title: '在系统通知中心弹出提醒',
                onChange: function (v) {
                  rt.saveSettings({ system: { enabled: v } })
                  // 打开总开关时顺手申请权限（必须在用户手势里发起）
                  if (v && perm !== 'granted') {
                    rt.requestPermission().then(function (r) {
                      setMsg(r === 'granted' ? '已获得通知权限' : '未能获得通知权限，系统通知不会弹出')
                    })
                  }
                },
              }),
              h('span', { className: 'dshns-pHintInline' }, '权限：' + permText),
            ),
          ),
          h('div', { className: 'dshns-pRows' }, sysRows),
          h('div', { className: 'dshns-pHint' }, '系统通知与声音是两条独立通道：临时静音只静声音，不影响通知。'),

          // —— 自定义音频 ——
          h('div', { className: 'dshns-pSection' }, '自定义音频'),
          h('div', { className: 'dshns-pRow' },
            h('div', { className: 'dshns-pLabel' }, '上传'),
            h('div', { className: 'dshns-pCtl' },
              h('button', {
                className: 'dshns-btn',
                type: 'button',
                onClick: function () { if (fileRef.current) fileRef.current.click() },
              }, '选择音频文件'),
              h('span', { className: 'dshns-pHintInline' }, 'mp3 / wav / ogg / m4a，单个 ≤ 2MB'),
              h('input', {
                ref: fileRef,
                type: 'file',
                accept: 'audio/*',
                style: { display: 'none' },
                onChange: function (e) {
                  var f = e.target.files && e.target.files[0]
                  if (!f) return
                  setMsg('正在上传…')
                  rt.uploadSound(f).then(function (sound) {
                    setMsg(sound ? '已添加「' + sound.name + '」，可在上方声音下拉里选它' : '已添加')
                  }).then(null, function (err) {
                    setMsg('上传失败：' + (err && err.message ? err.message : err))
                  })
                  e.target.value = ''
                },
              }),
            ),
          ),
          customLines.length ? h('div', { className: 'dshns-customs' }, customLines) : null,

          (msg || s.error) ? h('div', { className: 'dshns-msg' }, msg || s.error) : null,
          !hasPrimitives
            ? h('div', { className: 'dshns-hint' }, '提示：当前宿主未提供官方 UI 组件，界面已降级显示。')
            : null,
        ),
      )
    }

    // ================================== 通用设置里的摘要行（模式 + 试听 + 齿轮）
    function SoundRow() {
      var rt = useRuntime()
      var openPair = React.useState(false)
      var panelOpen = openPair[0]
      var setPanelOpen = openPair[1]
      if (!rt) return null
      var s = rt.state
      var settings = s.settings

      if (!settings) {
        return h('div', { className: 'dshns-row' },
          h('div', { className: 'dshns-title' }, '声音提醒'),
          h('div', { className: 'dshns-hint' }, s.error || '正在读取设置…'),
        )
      }

      var doneSound = settings.events.done.sound

      return h('div', { className: 'dshns-row' },
        h('div', { className: 'dshns-head' },
          h('div', { className: 'dshns-title' }, '声音提醒'),
          h(Dropdown, {
            items: MODE_OPTIONS.map(function (m) { return { id: m.id, label: m.label } }),
            value: settings.mode,
            className: 'dshns-mode',
            title: modeHintOf(settings.mode),
            align: 'end',
            onChange: function (m) { rt.saveSettings({ mode: m }) },
          }),
          h(PreviewButton, {
            title: '试听「任务完成」的声音',
            onClick: function () { rt.play(doneSound, { force: true }) },
          }),
          h(GearButton, {
            title: '声音提醒设置',
            onClick: function () { setPanelOpen(true) },
          }),
        ),
        h('div', { className: 'dshns-hint' }, modeHintOf(settings.mode)),
        panelOpen ? h(SettingsPanel, { rt: rt, onClose: function () { setPanelOpen(false) } }) : null,
      )
    }

    // ================================================= 对话输入框左下角喇叭
    function MuteButton() {
      var rt = useRuntime()
      if (!rt) return null
      var muted = rt.state.muted
      var kids = [
        h('path', { key: 'body', d: 'M3 9v6h4l5 4V5L7 9H3z', fill: 'currentColor' }),
      ]
      if (muted) {
        kids.push(h('path', {
          key: 'x', d: 'M16 9l5 5M21 9l-5 5',
          stroke: 'currentColor', strokeWidth: 1.8, fill: 'none', strokeLinecap: 'round',
        }))
      } else {
        kids.push(h('path', {
          key: 'w1', d: 'M15.5 8.6a4.6 4.6 0 010 6.8',
          stroke: 'currentColor', strokeWidth: 1.8, fill: 'none', strokeLinecap: 'round',
        }))
        kids.push(h('path', {
          key: 'w2', d: 'M18.2 6a8.2 8.2 0 010 12',
          stroke: 'currentColor', strokeWidth: 1.8, fill: 'none', strokeLinecap: 'round',
        }))
      }
      var label = muted ? '已关闭提示音' : '已开启提示音'
      return h('button', {
        className: 'dshns-mute',
        type: 'button',
        'data-muted': muted ? '1' : '0',
        title: label,
        'aria-label': label,
        onClick: function () { rt.toggleMuted() },
      }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, kids))
    }

    // ================================================================= apply
    var disposers = []
    var styleOff = null

    function apply(ctx) {
      // 幂等：HMR / 重复 apply 时先把上一个实例拆干净，避免定时器叠加
      if (runtime) {
        try { runtime.dispose() } catch (err) {}
        runtime = null
      }

      // 注入样式（自建 <style>，带上插件标记便于清理与排查）
      try {
        if (!styleOff) {
          var tag = document.createElement('style')
          tag.setAttribute('data-plugin', PLUGIN_ID)
          tag.setAttribute('data-plugin-css', PLUGIN_ID + '/client.css')
          tag.textContent = CSS
          document.head.appendChild(tag)
          styleOff = function () { try { tag.remove() } catch (err) {} }
        }
      } catch (err) {}

      runtime = createRuntime()

      var offStyle = styleOff
      ctx.effect(function () {
        return function () {
          for (var i = 0; i < disposers.length; i++) { try { disposers[i]() } catch (err) {} }
          disposers.length = 0
          if (runtime) { try { runtime.dispose() } catch (err) {} runtime = null }
          if (offStyle) { offStyle(); if (styleOff === offStyle) styleOff = null }
        }
      }, PLUGIN_ID + ': teardown')

      runtime.start()

      // ① 通用设置里的一行
      ctx.slots.inject('settings.general.item', function () {
        return ctx.slots.register({
          name: 'settings.general.item',
          id: PLUGIN_ID,
          order: 12,
          inject: function () { return { api: runtime } },
        }, SoundRow)
      })

      // ② 对话输入框左下角的临时静音按钮
      ctx.slots.inject('conversation.input.left', function () {
        return ctx.slots.register({
          name: 'conversation.input.left',
          id: PLUGIN_ID + '-mute',
          order: 10,
          inject: function () { return { api: runtime } },
        }, MuteButton)
      })

      // 调试入口：出问题时不用翻源码就能看状态、试听。
      // runtime 用 getter 暴露 —— 直接存快照会在 teardown 后留一个已释放的旧对象。
      try {
        window.__DSH_NOTIFY__ = {
          version: '2.0.0',
          get runtime() { return runtime },
          get state() { return runtime ? runtime.state : null },
          play: function (id) { if (runtime) runtime.play(id, { force: true }) },
          mute: function (m) { if (runtime) runtime.setMuted(m !== false) },
          dispose: function () { if (runtime) runtime.dispose() },
        }
      } catch (err) {}
    }

    exports.name = PLUGIN_ID
    // cordis 服务依赖：apply() 里同步调用 ctx.slots.inject，若不声明，
    // cordis 的 ctx 代理会抛 `cannot get property "slots" without inject`，
    // 而且 apply 也不会等 slots 服务就绪。只用 slots（数据走 fetch，不用 connection）。
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
