/*!
 * dsh-notify-sound-plus — 宿主侧（Host half）
 *
 * 做什么：
 *   ① 盯 DSH 会话事件流，判定「任务完成 / 需要回答 / 需要授权 / 出错」；
 *   ② 在**通知产生的那一刻**算好「这次该不该提示、提示哪一个声音」（sound 字段）；
 *   ③ 提供设置、静音、自定义音频的 HTTP 接口。
 *
 * 为什么「该不该提示」放在宿主算：开/关/智能判断/临时静音/小鲸鱼互斥 这些语义
 *   只有宿主看得全（跨标签页、跨会话、子代理、turn 结束原因）。客户端只负责按
 *   state.sound 出声，不做任何判定 —— 语义集中在一处，不会前后端各判一半。
 *
 * 客户端 UI（设置行 + 喇叭按钮）走官方客户端模块通道（package.json 的 dsh.client，
 *   由 @deepseek-ai/dsh-client-modules 自动扫描并提供 /plugins 路由与 boot graph），
 *   因此本文件**不再**手工注入 script，也不再注册 client.js 路由。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ID = 'dsh-notify-sound-plus'
const ROUTE_BASE = '/dsh-notify'
const STATE_PATH = ROUTE_BASE + '/state'
const SETTINGS_PATH = ROUTE_BASE + '/settings.json'
const MUTE_PATH = ROUTE_BASE + '/mute.json'
const SOUNDS_PATH = ROUTE_BASE + '/sounds.json'
const AUDIO_PREFIX = ROUTE_BASE + '/audio'
const PING_PATH = ROUTE_BASE + '/ping'

// lib/index.js -> package root
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

// 设置与小鲸鱼账本的候选路径（DSH_HOME 优先，其次 profile 目录，兼容老布局）
function homeCandidates(name) {
  return [
    path.join(DSH_HOME, name),
    path.join(DSH_HOME, 'profiles', 'web', name),
    path.join(DSH_HOME, 'profiles', 'desktop', name),
  ]
}
const SETTINGS_FILE_CANDIDATES = homeCandidates('.dsh-notify-settings.json')
const WHALE_LEDGER_CANDIDATES = homeCandidates('.dshw-usage.json')

const AUDIO_DIR = path.join(DSH_HOME, 'dsh-notify-audio')
const AUDIO_INDEX = path.join(AUDIO_DIR, 'index.json')

/** 问用户的工具名（DSH 内置）。 */
const ASK_TOOL = 'ask_user_question'

/** 环形缓冲长度：兜住页面轮询间隔内的突发。 */
const OUTBOX_LIMIT = 24

/** 单个自定义音频上限（解码后字节）。 */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024
/** 自定义音频数量上限。 */
const MAX_AUDIO_COUNT = 20

const ALLOWED_MIME = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-m4a',
])

const EXT_BY_MIME = {
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'audio/wave': '.wav', 'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/mp4': '.m4a',
  'audio/aac': '.aac', 'audio/flac': '.flac', 'audio/x-m4a': '.m4a',
}

/** 可选音效目录（内置部分由客户端合成，无需随包音频文件）。 */
const BUILTIN_SOUNDS = [
  { id: 'default:done', name: '默认 · 完成（下行双音）', builtin: true },
  { id: 'default:question', name: '默认 · 提问（上行三音）', builtin: true },
  { id: 'default:approval', name: '默认 · 授权（低音三连）', builtin: true },
  { id: 'default:error', name: '默认 · 出错（低沉下坠）', builtin: true },
  { id: 'preset:chime', name: '叮咚', builtin: true },
  { id: 'preset:bell', name: '铃音', builtin: true },
  { id: 'preset:soft', name: '轻柔', builtin: true },
  { id: 'preset:alert', name: '警示', builtin: true },
  { id: 'none', name: '静音', builtin: true },
]

const EVENT_KINDS = ['done', 'question', 'approval', 'error']

function defaultSoundFor(kind) {
  return 'default:' + kind
}

function defaultSettings() {
  return {
    // 总模式：on = 都提示；off = 都不提示；smart = 小鲸鱼没在提示这个事件时才提示
    mode: 'on',
    volume: 0.6,
    muteWhenFocused: false,
    events: {
      done: { on: true, sound: defaultSoundFor('done') },
      question: { on: true, sound: defaultSoundFor('question') },
      approval: { on: true, sound: defaultSoundFor('approval') },
      error: { on: true, sound: defaultSoundFor('error') },
    },
    // 系统通知（Electron 通知中心 / 浏览器通知）。
    // 界面上只暴露一个总开关，所以「总开关打开时哪些事件会弹」由这里决定：
    // 需要你回答 / 需要你授权 / 任务完成 —— 会打断你或需要你接手的三类；
    // 纯报错的 error 不弹，避免噪音。
    system: {
      enabled: false,
      events: { done: true, question: true, approval: true, error: false },
    },
  }
}

/** 把任意输入规整成合法设置（永远返回完整对象，坏值回落默认）。 */
function normalizeSettings(raw) {
  const out = defaultSettings()
  if (!raw || typeof raw !== 'object') return out

  if (raw.mode === 'on' || raw.mode === 'off' || raw.mode === 'smart') out.mode = raw.mode
  const v = Number(raw.volume)
  if (isFinite(v)) out.volume = Math.min(1, Math.max(0, v))
  if (typeof raw.muteWhenFocused === 'boolean') out.muteWhenFocused = raw.muteWhenFocused

  const ev = raw.events && typeof raw.events === 'object' ? raw.events : {}
  for (const kind of EVENT_KINDS) {
    const src = ev[kind]
    if (!src || typeof src !== 'object') continue
    if (typeof src.on === 'boolean') out.events[kind].on = src.on
    if (typeof src.sound === 'string' && src.sound.length > 0 && src.sound.length < 200) {
      out.events[kind].sound = src.sound
    }
  }

  const sys = raw.system && typeof raw.system === 'object' ? raw.system : null
  if (sys) {
    if (typeof sys.enabled === 'boolean') out.system.enabled = sys.enabled
    const sev = sys.events && typeof sys.events === 'object' ? sys.events : {}
    for (const kind of EVENT_KINDS) {
      if (typeof sev[kind] === 'boolean') out.system.events[kind] = sev[kind]
    }
  }
  return out
}

/** events 需要逐事件深合并：整块替换会把没提到的字段抹成默认。 */
function mergeEvents(base, patch) {
  const out = {}
  for (const kind of EVENT_KINDS) {
    out[kind] = { ...(base && base[kind] ? base[kind] : {}) }
    if (patch && patch[kind] && typeof patch[kind] === 'object') {
      if (typeof patch[kind].on === 'boolean') out[kind].on = patch[kind].on
      if (typeof patch[kind].sound === 'string' && patch[kind].sound) out[kind].sound = patch[kind].sound
    }
  }
  return out
}

/** system 同样逐事件深合并（enabled 与 events 分别合）。 */
function mergeSystem(base, patch) {
  const out = {
    enabled: !!(base && base.enabled),
    events: { ...((base && base.events) || {}) },
  }
  if (!patch || typeof patch !== 'object') return out
  if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled
  const pev = patch.events && typeof patch.events === 'object' ? patch.events : {}
  for (const kind of EVENT_KINDS) {
    if (typeof pev[kind] === 'boolean') out.events[kind] = pev[kind]
  }
  return out
}

function sendJson(res, status, body) {
  let text = ''
  try { text = JSON.stringify(body) } catch (err) { text = '{"error":"unserializable"}' }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

function sendBytes(res, status, contentType, buf) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': String(buf.length),
  })
  res.end(buf)
}

/** 读请求体，带硬性体积上限（防止一次 POST 把内存吃满）。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        try { req.destroy() } catch (err) {}
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function readFirstJson(candidates) {
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (parsed && typeof parsed === 'object') return { parsed, path: p }
    } catch (err) {}
  }
  return null
}

function writeJsonAtomic(candidates, value) {
  const body = JSON.stringify(value, null, 2)
  for (const p of candidates) {
    const tmp = p + '.tmp-' + process.pid
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(tmp, body, 'utf8')
      fs.renameSync(tmp, p)
      return true
    } catch (err) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (e2) {}
    }
  }
  return false
}

export default {
  name: PLUGIN_ID,

  /**
   * @param {import('@deepseek-ai/cordis').Context} root
   * @param {object} config
   */
  apply(root, config) {
    const cfg = {
      enabled: true,
      notifyOnError: true,
      skipSubagents: true,
      ...(config || {}),
    }

    const disposers = []
    root.effect(() => () => {
      for (const d of disposers) {
        try { d() } catch (err) {}
      }
    })

    // —— 设置（落盘）——
    const loaded = readFirstJson(SETTINGS_FILE_CANDIDATES)
    let settings = normalizeSettings(loaded ? loaded.parsed : null)
    const settingsPathUsed = loaded ? loaded.path : SETTINGS_FILE_CANDIDATES[0]

    function saveSettings() {
      return writeJsonAtomic(SETTINGS_FILE_CANDIDATES, settings)
    }

    // —— 临时静音：只在内存里，重启即恢复（用户要的是「临时关闭」）——
    let muted = false

    // —— 通知状态 ——
    let seq = 0
    let last = null // { seq, kind, at, session, title, sound }
    const outbox = []
    const routeErrors = []

    /** 每个会话的挂起状态：等回答 / 等授权。 */
    const waiting = new Map()

    // ---------------------------------------------------------------- 小鲸鱼
    /** 读小鲸鱼的用量设置（它的「任务结束音 / 提问音 / 授权音」开关就在里面）。 */
    function readWhaleSettings() {
      const found = readFirstJson(WHALE_LEDGER_CANDIDATES)
      if (!found) return null
      const s = found.parsed.settings
      if (!s || typeof s !== 'object') return null
      return s
    }

    /** 小鲸鱼插件是否真的挂着（优先问 Loader，问不到才看账本文件）。 */
    function whaleInstalled() {
      try {
        const loader = (root && typeof root.get === 'function') ? root.get('loader') : null
        if (loader && typeof loader.entries === 'function') {
          const entries = [...loader.entries()]
          if (entries.length > 0) {
            for (const e of entries) {
              const n = e && e.options && e.options.name
              if (typeof n === 'string' && n.indexOf('dsh-whale-widget') >= 0) return true
            }
            // Loader 可用且 Whale 不在条目里 ⇒ 确定的「没装」
            return false
          }
        }
      } catch (err) {}
      // 拿不到 Loader：只能用账本文件存在与否当近似
      return readWhaleSettings() !== null
    }

    /**
     * 智能判断的核心：这个事件此刻**是否已经由小鲸鱼负责出声**。
     * 只有答案确定时才返回 true —— 读不到它的设置就当我们提示（宁可提示也不要漏）。
     */
    function whaleHandles(kind) {
      const s = readWhaleSettings()
      if (!s) return false
      try {
        if (kind === 'done') {
          const te = s.taskEnd
          return !!(te && te.on === true)
        }
        if (kind === 'question' || kind === 'approval') {
          const ev = s.events && s.events[kind]
          return !!(ev && ev.soundOn === true)
        }
      } catch (err) {}
      // 错误音小鲸鱼不管，永远由我们负责
      return false
    }

    // ------------------------------------------------------- 声音解析（唯一真源）
    /**
     * 算出这次通知该不该提示、提示哪一个。
     * @param {'done'|'question'|'approval'|'error'} kind
     * @param {boolean} force 自检用：绕过静音与模式
     */
    function resolveSound(kind, force) {
      const ev = settings.events[kind]
      if (force) return ev ? ev.sound : defaultSoundFor(kind)
      if (!cfg.enabled) return 'none'
      if (muted) return 'none'
      if (settings.mode === 'off') return 'none'
      if (!ev || ev.on === false) return 'none'
      if (settings.mode === 'smart' && whaleHandles(kind)) return 'none'
      return ev.sound || defaultSoundFor(kind)
    }

    /**
     * 这次要弹系统通知吗。
     *
     * 与声音是**两条独立通道**：系统通知是「你不在看屏幕时也能知道」的手段，
     * 所以它只看 system.enabled + 逐事件开关，不受声音的音量/静音影响
     * （临时静音只静声音，不该把通知也吞掉）。
     * @param {'done'|'question'|'approval'|'error'} kind
     * @param {boolean} force
     */
    function resolveNotify(kind, force) {
      const sys = settings.system || {}
      if (force) return true
      if (!cfg.enabled) return false
      if (!sys.enabled) return false
      const ev = sys.events && typeof sys.events === 'object' ? sys.events : {}
      return ev[kind] === true
    }

    // ------------------------------------------------------------------ 自定义音频
    function readAudioIndex() {
      try {
        const parsed = JSON.parse(fs.readFileSync(AUDIO_INDEX, 'utf8'))
        if (parsed && Array.isArray(parsed.items)) return parsed
      } catch (err) {}
      return { version: 1, items: [] }
    }

    function writeAudioIndex(index) {
      try {
        fs.mkdirSync(AUDIO_DIR, { recursive: true })
        const tmp = AUDIO_INDEX + '.tmp-' + process.pid
        fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8')
        fs.renameSync(tmp, AUDIO_INDEX)
        return true
      } catch (err) {
        return false
      }
    }

    function audioFileOf(item) {
      return path.join(AUDIO_DIR, item.id + (item.ext || ''))
    }

    /** 声音 id 是否指向一个存在文件的自定义音。 */
    function customExists(id) {
      const item = readAudioIndex().items.find((it) => it.id === id)
      if (!item) return false
      try { fs.accessSync(audioFileOf(item)); return true } catch (err) { return false }
    }

    function saveCustomAudio(name, mime, buf) {
      const items = readAudioIndex().items
      if (items.length >= MAX_AUDIO_COUNT) {
        return { ok: false, error: `自定义音效最多 ${MAX_AUDIO_COUNT} 个` }
      }
      const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      const ext = EXT_BY_MIME[mime] || '.bin'
      try {
        fs.mkdirSync(AUDIO_DIR, { recursive: true })
        fs.writeFileSync(path.join(AUDIO_DIR, id + ext), buf)
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
      const item = {
        id,
        name: String(name || '自定义音效').slice(0, 60),
        mime,
        ext,
        bytes: buf.length,
        at: Date.now(),
      }
      items.push(item)
      if (!writeAudioIndex({ version: 1, items })) return { ok: false, error: '索引写入失败' }
      return { ok: true, item }
    }

    function deleteCustomAudio(id) {
      const index = readAudioIndex()
      const i = index.items.findIndex((it) => it.id === id)
      if (i < 0) return false
      try { fs.unlinkSync(audioFileOf(index.items[i])) } catch (err) {}
      index.items.splice(i, 1)
      writeAudioIndex(index)
      return true
    }

    // ------------------------------------------------------------------- 通知
    /**
     * 发一条通知。
     * @param {'done'|'question'|'approval'|'error'} kind
     */
    function notify(kind, sessionId, title, at, force) {
      if (!cfg.enabled && !force) return
      if (kind === 'error' && !cfg.notifyOnError && !force) return
      seq += 1
      const item = {
        seq,
        kind,
        at: isFinite(at) && at > 0 ? at : Date.now(),
        session: sessionId ? String(sessionId) : '',
        title: title ? String(title).slice(0, 120) : '',
        // 冻结此刻的判定结果：设置之后再改也不影响这一条的语义
        sound: resolveSound(kind, !!force),
        notify: resolveNotify(kind, !!force),
      }
      last = item
      outbox.push(item)
      if (outbox.length > OUTBOX_LIMIT) outbox.splice(0, outbox.length - OUTBOX_LIMIT)
    }

    function sessionIdOf(session) {
      try {
        if (session && session.id != null) return String(session.id)
      } catch (err) {}
      return ''
    }

    function sessionTitle(session) {
      try {
        const h = session && session.header
        if (h && typeof h.title === 'string' && h.title) return h.title
        if (session && typeof session.title === 'string' && session.title) return session.title
        if (session && typeof session.name === 'string' && session.name) return session.name
      } catch (err) {}
      return ''
    }

    function isSubagent(session) {
      try {
        return !!(session && session.header && session.header.origin === 'subagent')
      } catch (err) {
        return false
      }
    }

    function eventTime(event) {
      const t = Number(event && event.time)
      return isFinite(t) && t > 0 ? t : Date.now()
    }

    function note(kind, session, event) {
      notify(kind, sessionIdOf(session), sessionTitle(session), eventTime(event), false)
    }

    /**
     * 会话事件 → 通知。
     *   turn/end       { turn, reason: { kind } }
     *   tool/call      { turn, step, callId, name, arguments }
     *   tool/result    { turn, step, message, error? }
     *   approval/asked { id, ... }
     */
    function onSessionEvent(session, event) {
      try {
        if (!event || typeof event.type !== 'string') return
        const sid = sessionIdOf(session)
        if (!sid) return
        if (cfg.skipSubagents && isSubagent(session)) return

        const data = event.data
        if (!data || typeof data !== 'object') return

        switch (event.type) {
          case 'tool/call': {
            const name = String(data.name || data.toolName || '')
            if (name === ASK_TOOL) {
              waiting.set(sid, { kind: 'question', callId: String(data.callId || '') })
              note('question', session, event)
            }
            return
          }

          case 'approval/asked': {
            waiting.set(sid, { kind: 'approval', callId: String(data.id || data.requestId || '') })
            note('approval', session, event)
            return
          }

          case 'approval/resolved':
          case 'approval/answered':
          case 'approval/denied': {
            const w = waiting.get(sid)
            if (w && w.kind === 'approval') waiting.delete(sid)
            return
          }

          case 'tool/result': {
            // tool/result 是工具执行完成的回执，不等于用户已应答。
            // 只在授权挂起时按 callId 清理，避免把「等回答」过早撤掉。
            const w = waiting.get(sid)
            if (w && w.kind === 'approval') {
              const cid = String(data.callId || '')
              if (!w.callId || !cid || cid === w.callId) waiting.delete(sid)
            }
            return
          }

          case 'turn/start': {
            waiting.delete(sid)
            return
          }

          case 'turn/end': {
            waiting.delete(sid)
            const reason = data.reason && typeof data.reason === 'object' ? data.reason : {}
            const kind = String(reason.kind || '')
            if (kind === 'completed') note('done', session, event)
            else if (kind === 'error') note('error', session, event)
            // aborted（用户自己按停）/ interrupted / forked / blocked / max-tokens 不提示
            return
          }

          default:
            return
        }
      } catch (err) {
        // fire-and-forget 旁路：这里抛错不能影响会话提交
      }
    }

    disposers.push(root.on('session/event', onSessionEvent))
    disposers.push(root.on('session/disposed', (session) => {
      const sid = sessionIdOf(session)
      if (sid) waiting.delete(sid)
    }))

    // ------------------------------------------------------------------- 路由
    root.inject(['webServer'], (ctx) => {
      const webServer = ctx.webServer

      function register(route) {
        try {
          disposers.push(webServer.register(route))
        } catch (err) {
          routeErrors.push({ path: route.path, error: String((err && err.message) || err) })
        }
      }

      register({
        kind: 'exact',
        path: STATE_PATH,
        handler: (req, res) => {
          sendJson(res, 200, {
            seq,
            kind: last ? last.kind : null,
            at: last ? last.at : 0,
            session: last ? last.session : '',
            title: last ? last.title : '',
            sound: last ? last.sound : 'none',
            notify: last ? !!last.notify : false,
            muted,
            mode: settings.mode,
            outbox,
            diagnostics: {
              plugin: PLUGIN_ID,
              enabled: !!cfg.enabled,
              notifyOnError: !!cfg.notifyOnError,
              skipSubagents: !!cfg.skipSubagents,
              muted,
              mode: settings.mode,
              settingsPath: settingsPathUsed,
              whaleInstalled: whaleInstalled(),
              customCount: readAudioIndex().items.length,
              waiting: [...waiting.entries()].map(([id, w]) => ({ session: id, kind: w.kind })),
              routeErrors,
              time: Date.now(),
            },
          })
        },
      })

      register({
        kind: 'exact',
        path: SETTINGS_PATH,
        handler: async (req, res) => {
          try {
            if (req.method === 'PUT' || req.method === 'POST') {
              const body = await readBody(req, 256 * 1024)
              const parsed = JSON.parse(body || '{}')
              if (!parsed || typeof parsed !== 'object') throw new Error('bad body')
              settings = normalizeSettings({
                ...settings,
                ...parsed,
                events: mergeEvents(settings.events, parsed.events),
                system: mergeSystem(settings.system, parsed.system),
              })
              const saved = saveSettings()
              sendJson(res, 200, { ok: true, settings, saved })
              return
            }
            sendJson(res, 200, { ok: true, settings, muted })
          } catch (err) {
            sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
          }
        },
      })

      register({
        kind: 'exact',
        path: MUTE_PATH,
        handler: async (req, res) => {
          try {
            if (req.method !== 'PUT' && req.method !== 'POST') {
              sendJson(res, 200, { ok: true, muted })
              return
            }
            const body = await readBody(req, 8 * 1024)
            const parsed = JSON.parse(body || '{}')
            // 不带 muted 字段 = 切换（喇叭按钮点一下图个省事）
            muted = typeof parsed.muted === 'boolean' ? parsed.muted : !muted
            sendJson(res, 200, { ok: true, muted })
          } catch (err) {
            sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
          }
        },
      })

      register({
        kind: 'exact',
        path: SOUNDS_PATH,
        handler: (req, res) => {
          const items = readAudioIndex().items
            .filter((it) => customExists(it.id))
            .map((it) => ({
              id: 'custom:' + it.id,
              name: it.name,
              custom: true,
              bytes: it.bytes,
              url: AUDIO_PREFIX + '/' + it.id,
            }))
          sendJson(res, 200, { ok: true, builtin: BUILTIN_SOUNDS, custom: items })
        },
      })

      // 前缀路由：GET 取音频字节 / POST 上传 / DELETE 删除
      register({
        kind: 'prefix',
        path: AUDIO_PREFIX,
        handler: async (req, res) => {
          const tail = String(req.url || '').split('?')[0]
            .slice(AUDIO_PREFIX.length).replace(/^\/+/, '')
          try {
            if (req.method === 'POST') {
              const body = await readBody(req, Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 4096)
              const parsed = JSON.parse(body || '{}')
              const mime = String(parsed.mime || '').toLowerCase()
              if (!ALLOWED_MIME.has(mime)) {
                sendJson(res, 400, { ok: false, error: '不支持的音频格式: ' + (mime || '(空)') })
                return
              }
              const b64 = String(parsed.dataBase64 || '')
              if (!b64) { sendJson(res, 400, { ok: false, error: '缺少音频数据' }); return }
              const buf = Buffer.from(b64, 'base64')
              if (buf.length === 0) { sendJson(res, 400, { ok: false, error: '音频为空' }); return }
              if (buf.length > MAX_AUDIO_BYTES) {
                sendJson(res, 400, {
                  ok: false,
                  error: `音频超过 ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)}MB 上限`,
                })
                return
              }
              const r = saveCustomAudio(parsed.name, mime, buf)
              if (!r.ok) { sendJson(res, 400, r); return }
              sendJson(res, 200, {
                ok: true,
                sound: {
                  id: 'custom:' + r.item.id,
                  name: r.item.name,
                  custom: true,
                  bytes: r.item.bytes,
                  url: AUDIO_PREFIX + '/' + r.item.id,
                },
              })
              return
            }

            if (req.method === 'DELETE') {
              if (!tail) { sendJson(res, 400, { ok: false, error: '缺少音频 id' }); return }
              const ok = deleteCustomAudio(tail)
              sendJson(res, ok ? 200 : 404, { ok })
              return
            }

            // GET：下发音频字节
            if (!tail) { sendJson(res, 400, { ok: false, error: '缺少音频 id' }); return }
            const item = readAudioIndex().items.find((it) => it.id === tail)
            if (!item) { sendJson(res, 404, { ok: false, error: '音频不存在' }); return }
            let buf
            try {
              buf = fs.readFileSync(audioFileOf(item))
            } catch (err) {
              sendJson(res, 404, { ok: false, error: '音频文件缺失' })
              return
            }
            sendBytes(res, 200, item.mime || 'application/octet-stream', buf)
          } catch (err) {
            sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
          }
        },
      })

      // 自检：不用真跑一轮对话就能验证出声链路；?force=1 绕过静音/模式，?kind= 选事件
      register({
        kind: 'exact',
        path: PING_PATH,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed; use POST' })
            return
          }
          const url = String(req.url || '')
          const force = /[?&]force=1/.test(url)
          const m = /[?&]kind=(done|question|approval|error)/.exec(url)
          const kind = m ? m[1] : 'done'
          notify(kind, '', '', Date.now(), force)
          sendJson(res, 200, {
            ok: true,
            seq,
            kind,
            sound: last ? last.sound : 'none',
            notify: last ? !!last.notify : false,
          })
        },
      })
    })
  },
}
