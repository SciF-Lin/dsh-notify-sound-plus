/**
 * dsh-notify-sound-plus —— 宿主半区单元测试（不依赖真实 DSH 实例）
 *
 * 用一个最小的假 Context 捕获插件注册的事件监听与 HTTP 路由，再灌入合成的
 * DSH 会话事件与 HTTP 请求，验证：
 *   ① 四类通知在正确时机触发、不该响的时候不响
 *   ② 「该不该响 / 响哪个」的唯一真源：resolveSound（模式 / 逐事件 / 静音 / force）
 *   ③ 设置读写、深合并、校验与落盘
 *   ④ 临时静音（内存态）
 *   ⑤ 智能判断（读小鲸鱼账本）
 *   ⑥ 自定义音频上传 / 取回 / 删除 / 体积与格式校验
 *   ⑦ 路由注册、诊断与清理
 *
 * ⚠️ DSH_HOME 在模块导入时就被读成常量，所以必须在 import 之前设置。
 *    每个测试用独立子目录，互不干扰。
 *
 * 运行： node --test test/host.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-test-'))
process.env.DSH_HOME = TEMP_ROOT

const plugin = (await import('../lib/index.js')).default

let seq = 0
/** 每个测试一个独立 DSH_HOME，避免状态串台。 */
function freshHome() {
  const dir = path.join(TEMP_ROOT, 'home-' + (++seq))
  fs.mkdirSync(dir, { recursive: true })
  // 插件的 DSH_HOME 是导入期常量，无法逐测试切换；因此把"逐测试隔离"做在
  // 该常量目录下：用唯一文件名由调用方区分。这里只保证目录存在。
  return dir
}

function settingsFileIn(home) {
  return path.join(home, '.dsh-notify-settings.json')
}

/** 彻底清掉共享状态目录里的设置文件，让每个测试从默认值开始。 */
function resetSettings() {
  for (const p of [
    path.join(TEMP_ROOT, '.dsh-notify-settings.json'),
    path.join(TEMP_ROOT, 'profiles', 'web', '.dsh-notify-settings.json'),
    path.join(TEMP_ROOT, 'profiles', 'desktop', '.dsh-notify-settings.json'),
  ]) {
    try { fs.unlinkSync(p) } catch (err) {}
  }
}

/** 清掉小鲸鱼账本，避免智能判断被上一个测试影响。 */
function resetWhale() {
  for (const p of [
    path.join(TEMP_ROOT, '.dshw-usage.json'),
    path.join(TEMP_ROOT, 'profiles', 'web', '.dshw-usage.json'),
    path.join(TEMP_ROOT, 'profiles', 'desktop', '.dshw-usage.json'),
  ]) {
    try { fs.unlinkSync(p) } catch (err) {}
  }
}

/** 写入小鲸鱼账本（模拟它的音效开关）。 */
function writeWhale(settings) {
  fs.writeFileSync(path.join(TEMP_ROOT, '.dshw-usage.json'), JSON.stringify({ date: '2026-10-05', settings }), 'utf8')
}

function resetAudio() {
  const dir = path.join(TEMP_ROOT, 'dsh-notify-audio')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (err) {}
}

/** 最小假 Context：只实现插件用到的能力。 */
function makeContext() {
  const listeners = new Map()
  const cleanups = []
  let injected = null

  const ctx = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {
        const arr = listeners.get(name) || []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') cleanups.push(disposer)
    },
    inject(services, cb) {
      injected = { services, cb }
    },
    get(name) {
      if (name === 'loader') return ctx.__loader
      return undefined
    },
    __loader: null,
    webServer: null,
  }

  const routes = new Map()
  const prefixRoutes = new Map()
  const tapIndexes = []
  ctx.webServer = {
    register(route) {
      // exact 路由按 path 精确匹配；prefix 路由按前缀匹配（插件的 /dsh-notify/audio 是 prefix）
      const table = route.kind === 'prefix' ? prefixRoutes : routes
      if (table.has(route.path)) throw new Error('duplicate route ' + route.path)
      table.set(route.path, { handler: route.handler, kind: route.kind })
      return () => table.delete(route.path)
    },
    tapIndex(fn) {
      tapIndexes.push(fn)
      return () => {
        const i = tapIndexes.indexOf(fn)
        if (i >= 0) tapIndexes.splice(i, 1)
      }
    },
  }

  /**
   * 按真实 webServer 的语义解析一条请求路径（先 exact，再 prefix 最长匹配）。
   * 挂在 routes 这个 Map 上，这样测试里 getJson(h.routes, ...) 直接可用。
   */
  routes.resolveRoute = function resolveRoute(rawUrl) {
    const pathname = String(rawUrl || '/').split('?')[0]
    if (routes.has(pathname)) return routes.get(pathname)
    let best = null
    let bestLen = -1
    for (const [prefix, entry] of prefixRoutes) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        if (prefix.length > bestLen) { best = entry; bestLen = prefix.length }
      }
    }
    return best
  }

  return {
    ctx,
    emit(name, ...args) {
      for (const fn of (listeners.get(name) || []).slice()) fn(...args)
    },
    listenerCount(name) {
      return (listeners.get(name) || []).length
    },
    ready() {
      if (injected) injected.cb(ctx)
    },
    routes,
    prefixRoutes,
    taps: tapIndexes,
    cleanups,
    injectedServices() {
      return injected ? injected.services : null
    },
  }
}

/** 起一个已就绪的插件实例（默认设置、无小鲸鱼）。 */
function boot(config) {
  resetSettings()
  resetWhale()
  const h = makeContext()
  plugin.apply(h.ctx, config || {})
  h.ready()
  return h
}

function session(id, header) {
  return { id, header: header || { version: 2, id, createdAt: 0, isSeeded: false } }
}

function subagentSession(id) {
  return session(id, { version: 2, id, createdAt: 0, isSeeded: false, origin: 'subagent' })
}

function ev(type, data, time) {
  return { type, seq: 1, time: time || Date.now(), data }
}

/** 用假 req/res 调一次路由。 */
function callRoute(entry, { method = 'GET', url = '/', body = null } = {}) {
  const handler = typeof entry === 'function' ? entry : entry.handler
  return new Promise((resolve) => {
    const listeners = {}
    const req = {
      method,
      url,
      headers: { host: '127.0.0.1:19387' },
      on(name, fn) {
        ;(listeners[name] = listeners[name] || []).push(fn)
        if (name === 'end' && body !== null) {
          // 下一 tick 再喂，确保 readBody 已经挂上监听
          setImmediate(() => {
            for (const f of listeners.data || []) f(Buffer.from(String(body)))
            for (const f of listeners.end || []) f()
          })
        }
        return req
      },
      destroy() {},
    }
    const chunks = []
    let status = 0
    const headers = {}
    const res = {
      writeHead(code, h) {
        status = code
        if (h) for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k]
      },
      end(payload) {
        if (payload !== undefined && payload !== null) {
          chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)))
        }
        resolve({ status, headers, text: Buffer.concat(chunks).toString('utf8'), buf: Buffer.concat(chunks) })
      },
    }
    handler(req, res)
  })
}

async function getJson(routes, p, opts) {
  const entry = typeof routes.resolveRoute === 'function' ? routes.resolveRoute(p) : routes.get(p)
  const r = await callRoute(entry, { method: 'GET', url: p, ...(opts || {}) })
  return { ...r, json: r.text ? JSON.parse(r.text) : null }
}

async function stateOf(routes) {
  return getJson(routes, '/dsh-notify/state')
}

async function setSettings(routes, patch) {
  return getJson(routes, '/dsh-notify/settings.json', {
    method: 'POST',
    body: JSON.stringify(patch),
  })
}

// ============================================================ 基础通知语义

test('完成一轮对话 → 一条 done 通知，sound=default:done', async () => {
  const h = boot()
  const s = session('s1')
  assert.equal((await stateOf(h.routes)).json.seq, 0)

  h.emit('session/event', s, ev('turn/start', { turn: 1 }))
  assert.equal((await stateOf(h.routes)).json.seq, 0, 'turn/start 不该响')

  h.emit('session/event', s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  const st = (await stateOf(h.routes)).json
  assert.equal(st.seq, 1)
  assert.equal(st.kind, 'done')
  assert.equal(st.sound, 'default:done')
  assert.equal(st.session, 's1')
})

test('aborted / interrupted / forked / blocked / max-tokens 都不响', async () => {
  const h = boot()
  const s = session('s1')
  for (const kind of ['aborted', 'interrupted', 'forked', 'blocked', 'max-tokens']) {
    h.emit('session/event', s, ev('turn/end', { turn: 1, reason: { kind } }))
  }
  assert.equal((await stateOf(h.routes)).json.seq, 0)
})

test('turn/end 出错 → error 通知；notifyOnError:false 时不响', async () => {
  const h = boot()
  const s = session('s1')
  h.emit('session/event', s, ev('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'y' } } }))
  const st = (await stateOf(h.routes)).json
  assert.equal(st.kind, 'error')
  assert.equal(st.sound, 'default:error')

  const h2 = boot({ notifyOnError: false })
  h2.emit('session/event', session('s1'), ev('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'y' } } }))
  assert.equal((await stateOf(h2.routes)).json.seq, 0)
})

test('ask_user_question → question 通知；tool/result 不清挂起，turn/end 才清', async () => {
  const h = boot()
  const s = session('s1')
  h.emit('session/event', s, ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'ask_user_question', arguments: '{}' }))

  let st = (await stateOf(h.routes)).json
  assert.equal(st.kind, 'question')
  assert.equal(st.sound, 'default:question')
  assert.deepEqual(st.diagnostics.waiting, [{ session: 's1', kind: 'question' }])

  h.emit('session/event', s, ev('tool/result', { turn: 1, step: 1, callId: 'c1', message: {} }))
  assert.equal((await stateOf(h.routes)).json.diagnostics.waiting.length, 1, '回答前仍应挂起')

  h.emit('session/event', s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal((await stateOf(h.routes)).json.diagnostics.waiting.length, 0)
})

test('别的工具调用不响', async () => {
  const h = boot()
  const s = session('s1')
  h.emit('session/event', s, ev('tool/call', { turn: 1, step: 1, callId: 'a', name: 'pwsh', arguments: '{}' }))
  h.emit('session/event', s, ev('tool/call', { turn: 1, step: 2, callId: 'b', name: 'read', arguments: '{}' }))
  assert.equal((await stateOf(h.routes)).json.seq, 0)
})

test('需要授权 → approval 通知；解决后清挂起且不重复响', async () => {
  const h = boot()
  const s = session('s1')
  h.emit('session/event', s, ev('approval/asked', { id: 'a1' }))
  let st = (await stateOf(h.routes)).json
  assert.equal(st.kind, 'approval')
  assert.deepEqual(st.diagnostics.waiting, [{ session: 's1', kind: 'approval' }])

  h.emit('session/event', s, ev('approval/resolved', { id: 'a1' }))
  st = (await stateOf(h.routes)).json
  assert.equal(st.diagnostics.waiting.length, 0)
  assert.equal(st.seq, 1, '解决本身不该再响一次')
})

test('子代理会话默认不打扰，关掉过滤则照响', async () => {
  const h = boot({ skipSubagents: true })
  h.emit('session/event', subagentSession('sub1'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal((await stateOf(h.routes)).json.seq, 0)

  const h2 = boot({ skipSubagents: false })
  h2.emit('session/event', subagentSession('sub1'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal((await stateOf(h2.routes)).json.seq, 1)
})

test('enabled:false 时整条链路静音（连通知都不产生）', async () => {
  const h = boot({ enabled: false })
  const s = session('s1')
  h.emit('session/event', s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  h.emit('session/event', s, ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'ask_user_question', arguments: '{}' }))
  assert.equal((await stateOf(h.routes)).json.seq, 0)
})

test('畸形事件永不抛出（fire-and-forget 旁路必须稳）', async () => {
  const h = boot()
  const s = session('s1')
  assert.doesNotThrow(() => h.emit('session/event', s, { type: 'turn/end' }))
  assert.doesNotThrow(() => h.emit('session/event', s, { type: 'turn/end', data: null }))
  assert.doesNotThrow(() => h.emit('session/event', s, { type: 42, data: {} }))
  assert.doesNotThrow(() => h.emit('session/event', null, ev('turn/end', { reason: { kind: 'completed' } })))
  assert.doesNotThrow(() => h.emit('session/event', { }, ev('turn/end', { reason: { kind: 'completed' } })))
  assert.equal((await stateOf(h.routes)).json.seq, 0)
})

// ============================================================ 模式 / 逐事件

test('mode=off → 新通知的 sound 是 none', async () => {
  const h = boot()
  await setSettings(h.routes, { mode: 'off' })
  h.emit('session/event', session('s1'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  const st = (await stateOf(h.routes)).json
  assert.equal(st.seq, 1, '通知仍然产生（只是不响），这样诊断才看得出发生了什么')
  assert.equal(st.sound, 'none')
})

test('逐事件关闭：done 关掉后不响，question 仍响', async () => {
  const h = boot()
  await setSettings(h.routes, { events: { done: { on: false } } })
  const s = session('s1')
  h.emit('session/event', s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal((await stateOf(h.routes)).json.sound, 'none')

  h.emit('session/event', s, ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'ask_user_question', arguments: '{}' }))
  assert.equal((await stateOf(h.routes)).json.sound, 'default:question')
})

test('逐事件选音：done 改成 preset:bell', async () => {
  const h = boot()
  await setSettings(h.routes, { events: { done: { sound: 'preset:bell' } } })
  h.emit('session/event', session('s1'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal((await stateOf(h.routes)).json.sound, 'preset:bell')
})

test('声音设为 none → 该事件不响', async () => {
  const h = boot()
  await setSettings(h.routes, { events: { done: { sound: 'none' } } })
  h.emit('session/event', session('s1'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal((await stateOf(h.routes)).json.sound, 'none')
})

// ============================================================ 设置读写

test('设置深合并：只改 done 的声音，不能把 question 抹回默认', async () => {
  const h = boot()
  await setSettings(h.routes, { events: { question: { sound: 'preset:soft', on: false } } })
  await setSettings(h.routes, { events: { done: { sound: 'preset:bell' } } })

  const st = await getJson(h.routes, '/dsh-notify/settings.json')
  assert.equal(st.json.settings.events.done.sound, 'preset:bell')
  assert.equal(st.json.settings.events.question.sound, 'preset:soft', 'question 不该被抹回默认')
  assert.equal(st.json.settings.events.question.on, false, 'question 的开关也不该被抹掉')
})

test('设置校验：非法 mode 回落、volume 夹到 [0,1]', async () => {
  const h = boot()
  await setSettings(h.routes, { mode: 'bogus', volume: 99 })
  let st = await getJson(h.routes, '/dsh-notify/settings.json')
  assert.notEqual(st.json.settings.mode, 'bogus')
  assert.equal(st.json.settings.volume, 1)

  await setSettings(h.routes, { volume: -5 })
  st = await getJson(h.routes, '/dsh-notify/settings.json')
  assert.equal(st.json.settings.volume, 0)

  await setSettings(h.routes, { mode: 'smart' })
  st = await getJson(h.routes, '/dsh-notify/settings.json')
  assert.equal(st.json.settings.mode, 'smart')
})

test('设置落盘：新实例能从磁盘读回', async () => {
  const h = boot()
  await setSettings(h.routes, { mode: 'smart', volume: 0.25, events: { approval: { sound: 'preset:alert' } } })
  assert.ok(fs.existsSync(path.join(TEMP_ROOT, '.dsh-notify-settings.json')), '设置应写到 DSH_HOME')

  // 重新 apply（模拟重启）：不能 resetSettings，要从磁盘读回
  const h2 = makeContext()
  plugin.apply(h2.ctx, {})
  h2.ready()
  const st = await getJson(h2.routes, '/dsh-notify/settings.json')
  assert.equal(st.json.settings.mode, 'smart')
  assert.equal(st.json.settings.volume, 0.25)
  assert.equal(st.json.settings.events.approval.sound, 'preset:alert')
})

// ============================================================ 临时静音

test('临时静音：静音后 sound=none，切换两次回来', async () => {
  const h = boot()
  const s = session('s1')

  await getJson(h.routes, '/dsh-notify/mute.json', { method: 'POST', body: '{}' })
  h.emit('session/event', s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal((await stateOf(h.routes)).json.sound, 'none')

  await getJson(h.routes, '/dsh-notify/mute.json', { method: 'POST', body: '{}' })
  h.emit('session/event', s, ev('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  assert.equal((await stateOf(h.routes)).json.sound, 'default:done', '再切一次应恢复')
})

test('临时静音：显式 {muted:true/false} 设置，且不落盘', async () => {
  const h = boot()
  let r = await getJson(h.routes, '/dsh-notify/mute.json', { method: 'POST', body: JSON.stringify({ muted: true }) })
  assert.equal(r.json.muted, true)
  r = await getJson(h.routes, '/dsh-notify/mute.json', { method: 'POST', body: JSON.stringify({ muted: true }) })
  assert.equal(r.json.muted, true, '显式设置应当幂等（不是切换）')
  r = await getJson(h.routes, '/dsh-notify/mute.json', { method: 'POST', body: JSON.stringify({ muted: false }) })
  assert.equal(r.json.muted, false)

  // 静音是内存态：不能出现在设置文件里
  const file = path.join(TEMP_ROOT, '.dsh-notify-settings.json')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  assert.ok(!/"muted"/.test(text), '静音不该写进设置文件')

  // 新实例（模拟重启）应当是未静音
  await getJson(h.routes, '/dsh-notify/mute.json', { method: 'POST', body: JSON.stringify({ muted: true }) })
  const h2 = makeContext()
  plugin.apply(h2.ctx, {})
  h2.ready()
  assert.equal((await stateOf(h2.routes)).json.muted, false, '重启后应恢复未静音')
})

// ============================================================ 智能判断

test('smart：小鲸鱼已开的 done/question 不响，它没开的 approval/error 仍响', async () => {
  const h = boot()
  writeWhale({
    taskEnd: { on: true },
    events: { question: { soundOn: true }, approval: { soundOn: false } },
  })
  await setSettings(h.routes, { mode: 'smart' })

  const s = session('s1')
  h.emit('session/event', s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal((await stateOf(h.routes)).json.sound, 'none', '小鲸鱼已负责 done')

  h.emit('session/event', s, ev('tool/call', { turn: 2, step: 1, callId: 'c1', name: 'ask_user_question', arguments: '{}' }))
  assert.equal((await stateOf(h.routes)).json.sound, 'none', '小鲸鱼已负责 question')

  h.emit('session/event', s, ev('approval/asked', { id: 'a1' }))
  assert.equal((await stateOf(h.routes)).json.sound, 'default:approval', '小鲸鱼没开 approval → 我们响')

  h.emit('session/event', s, ev('turn/end', { turn: 3, reason: { kind: 'error', error: { message: 'x', code: 'y' } } }))
  assert.equal((await stateOf(h.routes)).json.sound, 'default:error', '错误音小鲸鱼不管 → 我们响')
})

test('smart：小鲸鱼没装（没有账本）时全都响', async () => {
  const h = boot()
  await setSettings(h.routes, { mode: 'smart' })
  h.emit('session/event', session('s1'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal((await stateOf(h.routes)).json.sound, 'default:done')
})

test('smart：小鲸鱼装了但关掉了任务结束音 → 我们响', async () => {
  const h = boot()
  writeWhale({ taskEnd: { on: false }, events: { question: { soundOn: false } } })
  await setSettings(h.routes, { mode: 'smart' })
  h.emit('session/event', session('s1'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal((await stateOf(h.routes)).json.sound, 'default:done')
})

test('非 smart 模式下小鲸鱼的开关不影响我们', async () => {
  const h = boot()
  writeWhale({ taskEnd: { on: true }, events: { question: { soundOn: true } } })
  await setSettings(h.routes, { mode: 'on' })
  const s = session('s1')
  h.emit('session/event', s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal((await stateOf(h.routes)).json.sound, 'default:done')
})

// ============================================================ 自定义音频

const TINY_WAV = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
  0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
])

test('自定义音频：上传 → 出现在目录 → 取回字节一致 → 删除后 404', async () => {
  resetAudio()
  const h = boot()

  const up = await getJson(h.routes, '/dsh-notify/audio', {
    method: 'POST',
    body: JSON.stringify({ name: '我的音效', mime: 'audio/wav', dataBase64: TINY_WAV.toString('base64') }),
  })
  assert.equal(up.status, 200)
  assert.equal(up.json.ok, true)
  const id = up.json.sound.id
  assert.ok(id.startsWith('custom:'))

  const list = await getJson(h.routes, '/dsh-notify/sounds.json')
  assert.equal(list.json.custom.length, 1)
  assert.equal(list.json.custom[0].name, '我的音效')

  const raw = await callRoute(h.routes.resolveRoute('/dsh-notify/audio/' + id.replace('custom:', '')),
    { url: '/dsh-notify/audio/' + id.replace('custom:', '') })
  assert.equal(raw.status, 200)
  assert.equal(raw.headers['content-type'], 'audio/wav')
  assert.ok(raw.buf.equals(TINY_WAV), '取回的字节必须与上传一致')

  const del = await getJson(h.routes, '/dsh-notify/audio/' + id.replace('custom:', ''), { method: 'DELETE' })
  assert.equal(del.status, 200)
  const after = await getJson(h.routes, '/dsh-notify/sounds.json')
  assert.equal(after.json.custom.length, 0)

  const gone = await getJson(h.routes, '/dsh-notify/audio/' + id.replace('custom:', ''))
  assert.equal(gone.status, 404)
})

test('自定义音频校验：非音频 mime / 空数据 / 超大 都被拒', async () => {
  resetAudio()
  const h = boot()
  const post = (payload) => getJson(h.routes, '/dsh-notify/audio', { method: 'POST', body: JSON.stringify(payload) })

  assert.equal((await post({ mime: 'application/zip', dataBase64: TINY_WAV.toString('base64') })).status, 400)
  assert.equal((await post({ mime: 'audio/wav', dataBase64: '' })).status, 400)

  // 超过 2MB 上限（解码后）
  const big = Buffer.alloc(2 * 1024 * 1024 + 16, 1)
  const tooBig = await post({ name: 'big', mime: 'audio/wav', dataBase64: big.toString('base64') })
  assert.equal(tooBig.status, 400)
  assert.match(tooBig.json.error, /上限|too large|超过/)
})

test('自定义音效可以在事件里被选中并原样播报', async () => {
  resetAudio()
  const h = boot()
  const up = await getJson(h.routes, '/dsh-notify/audio', {
    method: 'POST',
    body: JSON.stringify({ name: 'x', mime: 'audio/wav', dataBase64: TINY_WAV.toString('base64') }),
  })
  const id = up.json.sound.id
  await setSettings(h.routes, { events: { done: { sound: id } } })
  h.emit('session/event', session('s1'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal((await stateOf(h.routes)).json.sound, id)
})

// ============================================================ ping / 诊断 / 清理

test('ping：普通调用出声，静音时 none，force=1 绕过静音，kind 可选；GET 405', async () => {
  const h = boot()
  const p1 = await getJson(h.routes, '/dsh-notify/ping', { method: 'POST' })
  assert.equal(p1.json.kind, 'done')
  assert.equal(p1.json.sound, 'default:done')

  await getJson(h.routes, '/dsh-notify/mute.json', { method: 'POST', body: JSON.stringify({ muted: true }) })
  const p2 = await getJson(h.routes, '/dsh-notify/ping', { method: 'POST' })
  assert.equal(p2.json.sound, 'none', '静音时普通 ping 不出声')

  const p3 = await getJson(h.routes, '/dsh-notify/ping?force=1', { method: 'POST' })
  assert.notEqual(p3.json.sound, 'none', 'force=1 必须绕过静音')

  const p4 = await getJson(h.routes, '/dsh-notify/ping?kind=approval', { method: 'POST' })
  assert.equal(p4.json.kind, 'approval')

  const bad = await getJson(h.routes, '/dsh-notify/ping')
  assert.equal(bad.status, 405)
})

test('诊断位：包含 plugin / mode / muted / whale / 自定义数量 / 路由错误', async () => {
  const h = boot()
  const st = (await stateOf(h.routes)).json
  assert.equal(st.diagnostics.plugin, 'dsh-notify-sound-plus')
  assert.equal(st.diagnostics.mode, 'on')
  assert.equal(st.diagnostics.muted, false)
  assert.equal(typeof st.diagnostics.whaleInstalled, 'boolean')
  assert.equal(typeof st.diagnostics.customCount, 'number')
  assert.deepEqual(st.diagnostics.routeErrors, [])
  assert.ok(typeof st.diagnostics.settingsPath === 'string')
})

test('路由注册冲突会记录进 diagnostics.routeErrors（不抛）', async () => {
  const h = makeContext()
  // 让第二条注册必失败
  let calls = 0
  const realRegister = h.ctx.webServer.register
  h.ctx.webServer.register = (route) => {
    calls += 1
    if (calls === 2) throw new Error('duplicate route ' + route.path)
    return realRegister(route)
  }
  assert.doesNotThrow(() => {
    plugin.apply(h.ctx, {})
    h.ready()
  })
  const st = (await stateOf(h.routes)).json
  assert.equal(st.diagnostics.routeErrors.length, 1)
  assert.match(st.diagnostics.routeErrors[0].error, /duplicate route/)
})

test('outbox 保留最近的通知（不超过上限）且 seq 单调递增', async () => {
  const h = boot()
  const s = session('s1')
  for (let i = 1; i <= 30; i++) {
    h.emit('session/event', s, ev('turn/end', { turn: i, reason: { kind: 'completed' } }))
  }
  const st = (await stateOf(h.routes)).json
  assert.equal(st.seq, 30)
  assert.ok(st.outbox.length <= 24, 'outbox 不应无限增长')
  // 单调递增
  for (let i = 1; i < st.outbox.length; i++) {
    assert.ok(st.outbox[i].seq > st.outbox[i - 1].seq, 'seq 必须单调递增')
  }
})

test('webServer 注入声明了 webServer 服务，且只声明它', async () => {
  const h = boot()
  assert.deepEqual(h.injectedServices(), ['webServer'])
})

test('effect 清理会摘掉事件监听与全部路由', async () => {
  const h = boot()
  assert.equal(h.listenerCount('session/event'), 1)
  assert.ok(h.routes.size > 0)
  assert.ok(h.prefixRoutes.size > 0, '音频路由是 prefix 路由')
  for (const fn of h.cleanups) fn()
  assert.equal(h.listenerCount('session/event'), 0)
  assert.equal(h.routes.size, 0, '清理后 exact 路由应全部注销')
  assert.equal(h.prefixRoutes.size, 0, '清理后 prefix 路由也应注销')
})

test('插件导出形状正确', () => {
  assert.equal(plugin.name, 'dsh-notify-sound-plus')
  assert.equal(typeof plugin.apply, 'function')
})
