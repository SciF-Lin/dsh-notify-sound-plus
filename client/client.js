/*!
 * dsh-notify-sound-plus — 客户端半区（Client half）
 *
 * 由 @deepseek-ai/dsh-client-modules 自动扫描 package.json 的 dsh.client 声明，
 * 经 /plugins 路由下发到页面，作为 __ModuleLoader__ 工厂执行。**手写 CJS**，
 * 不引入打包器：唯一外部依赖是平台种子表里的 react。
 *
 * 职责（严格只做这两件事）：
 *   ① UI：在「通用设置」放一行声音设置；在对话输入框左下角放一个喇叭按钮。
 *   ② 出声：轮询 /dsh-notify/state，宿主说该提示（sound != 'none'）就播那个声音。
 *
 * 「该不该提示」的判定**全在宿主**（见 lib/index.js 的 resolveSound）；这里不做
 * 任何模式/静音/小鲸鱼判断，避免前后端各判一半导致行为不一致。
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
      '.dshns-row{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0;display:flex;flex-direction:column;gap:12px}',
      '.dshns-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshns-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;flex:1;min-width:120px}',
      '.dshns-mode{flex:none;width:112px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);border:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;height:30px;padding:0 8px;cursor:pointer}',
      '.dshns-btn{border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}',
      '.dshns-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshns-btn:disabled{opacity:.5;cursor:default}',
      '.dshns-events{display:flex;flex-direction:column;gap:2px}',
      '.dshns-ev{display:flex;align-items:center;gap:10px;min-height:32px}',
      '.dshns-evlabel{color:var(--dsw-alias-label-primary);font-size:13px;width:88px;flex:none}',
      '.dshns-select{flex:1;min-width:100px;max-width:260px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);border:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;height:30px;padding:0 8px;cursor:pointer}',
      '.dshns-chk{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;flex:none}',
      '.dshns-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dshns-vol{display:flex;align-items:center;gap:10px}',
      '.dshns-vol>input{flex:1;max-width:240px}',
      '.dshns-volv{color:var(--dsw-alias-label-secondary);font-size:12px;width:36px}',
      '.dshns-customs{display:flex;flex-direction:column;gap:4px}',
      '.dshns-custom{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dshns-customname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}',
      '.dshns-x{border:none;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:12px;cursor:pointer;padding:2px 6px}',
      '.dshns-msg{font-size:12px;color:var(--dsw-alias-state-warn-primary)}',
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
          // 宿主已经把「该不该提示」判好了，这里只认 sound
          if (st.sound && st.sound !== 'none') play(st.sound)
        }).then(null, function () {})
      }

      function start() {
        refreshSettings().then(refreshSounds).then(function () {
          if (disposed) return
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
      }
    }

    function mergeSettings(base, patch) {
      var out = {
        mode: base && base.mode ? base.mode : 'on',
        volume: base && typeof base.volume === 'number' ? base.volume : 0.6,
        muteWhenFocused: !!(base && base.muteWhenFocused),
        events: {},
      }
      var kinds = ['done', 'question', 'approval', 'error']
      for (var i = 0; i < kinds.length; i++) {
        var k = kinds[i]
        var b = base && base.events && base.events[k] ? base.events[k] : {}
        out.events[k] = { on: b.on !== false, sound: b.sound || ('default:' + k) }
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

    // ============================================================ 设置页行
    function SoundRow() {
      var rt = useRuntime()
      if (!rt) return null
      var s = rt.state
      var settings = s.settings
      var fileRef = React.useRef(null)
      var msgPair = React.useState('')
      var msg = msgPair[0]
      var setMsg = msgPair[1]

      if (!settings) {
        return h('div', { className: 'dshns-row' },
          h('div', { className: 'dshns-title' }, '声音提醒'),
          h('div', { className: 'dshns-hint' }, s.error || '正在读取设置…'),
        )
      }

      function setMode(mode) { rt.saveSettings({ mode: mode }) }
      function setEvent(kind, patch) {
        var ev = {}
        ev[kind] = patch
        rt.saveSettings({ events: ev })
      }

      var options = []
      for (var i = 0; i < s.sounds.builtin.length; i++) {
        options.push({ id: s.sounds.builtin[i].id, name: s.sounds.builtin[i].name })
      }
      for (var j = 0; j < s.sounds.custom.length; j++) {
        options.push({ id: s.sounds.custom[j].id, name: '自定义 · ' + s.sounds.custom[j].name })
      }

      function selectEl(kind) {
        var cur = settings.events[kind].sound
        // 选中的自定义音若已被删除，回落到默认，避免下拉显示空白
        var known = false
        for (var i2 = 0; i2 < options.length; i2++) if (options[i2].id === cur) known = true
        var value = known ? cur : ('default:' + kind)
        var kids = []
        for (var i3 = 0; i3 < options.length; i3++) {
          kids.push(h('option', { key: options[i3].id, value: options[i3].id }, options[i3].name))
        }
        return h('select', {
          className: 'dshns-select',
          value: value,
          onChange: function (e) {
            var next = e.target.value
            setEvent(kind, { sound: next })
            // 换完立刻试听，不用再去点「▶试听」确认选对了
            rt.play(next, { force: true })
          },
          disabled: settings.mode === 'off',
        }, kids)
      }

      function eventLine(meta) {
        var ev = settings.events[meta.kind]
        return h('div', { className: 'dshns-ev', key: meta.kind },
          h('label', { className: 'dshns-chk' },
            h('input', {
              type: 'checkbox',
              checked: ev.on !== false,
              onChange: function (e) { setEvent(meta.kind, { on: e.target.checked }) },
              disabled: settings.mode === 'off',
            }),
            h('span', null, meta.label),
          ),
          selectEl(meta.kind),
          h('button', {
            className: 'dshns-btn',
            type: 'button',
            title: '试听',
            onClick: function () { rt.play(ev.sound, { force: true }) },
          }, '▶试听'),
        )
      }

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

      var MODE_OPTIONS = [
        { id: 'on', label: '开启声音提示', hint: '所有事件都会发出声音提示' },
        { id: 'off', label: '关闭声音提示', hint: '所有事件都不发出声音提示' },
        { id: 'smart', label: '智能判断', hint: '小鲸鱼挂件已经提示的事件不重复提示（它没开的事件仍由本插件提示）' },
      ]
      var modeHint = ''
      for (var mi = 0; mi < MODE_OPTIONS.length; mi++) {
        if (MODE_OPTIONS[mi].id === settings.mode) modeHint = MODE_OPTIONS[mi].hint
      }

      return h('div', { className: 'dshns-row' },
        h('div', { className: 'dshns-head' },
          h('div', { className: 'dshns-title' }, '声音提醒'),
          h('select', {
            className: 'dshns-mode',
            value: settings.mode,
            title: modeHint,
            onChange: function (e) { setMode(e.target.value) },
          }, MODE_OPTIONS.map(function (m) {
            return h('option', { key: m.id, value: m.id }, m.label)
          })),
          h('button', {
            className: 'dshns-btn',
            type: 'button',
            title: '试听',
            onClick: function () { rt.play(settings.events.done.sound, { force: true }) },
          }, '▶试听'),
        ),

        h('div', { className: 'dshns-hint' }, modeHint),

        h('div', { className: 'dshns-events' }, EVENT_META.map(eventLine)),

        h('div', { className: 'dshns-vol' },
          h('span', { className: 'dshns-evlabel' }, '音量'),
          h('input', {
            type: 'range', min: 0, max: 1, step: 0.05,
            value: settings.volume,
            onChange: function (e) { rt.saveSettings({ volume: Number(e.target.value) }) },
          }),
          h('span', { className: 'dshns-volv' }, Math.round(settings.volume * 100) + '%'),
          h('label', { className: 'dshns-chk' },
            h('input', {
              type: 'checkbox',
              checked: !!settings.muteWhenFocused,
              onChange: function (e) { rt.saveSettings({ muteWhenFocused: e.target.checked }) },
            }),
            h('span', null, '应用在前台运行时不提示'),
          ),
        ),

        h('div', { className: 'dshns-vol' },
          h('span', { className: 'dshns-evlabel' }, '自定义'),
          h('button', {
            className: 'dshns-btn',
            type: 'button',
            onClick: function () { if (fileRef.current) fileRef.current.click() },
          }, '上传音频'),
          h('span', { className: 'dshns-hint' }, '支持 mp3 / wav / ogg / m4a，单个 ≤ 2MB'),
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
                setMsg(sound ? '已添加「' + sound.name + '」，可在上方下拉里选它' : '已添加')
              }).then(null, function (err) {
                setMsg('上传失败：' + (err && err.message ? err.message : err))
              })
              e.target.value = ''
            },
          }),
        ),

        customLines.length ? h('div', { className: 'dshns-customs' }, customLines) : null,
        (msg || s.error) ? h('div', { className: 'dshns-msg' }, msg || s.error) : null,
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
