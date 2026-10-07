/**
 * 客户端半区契约检查：在假 __ModuleLoader__ / 假 DOM / 假 React 里执行
 * client/client.js，确认它能被官方加载器接受。
 *
 * 这里查的是**加载器契约**（最容易出错、也最难在真实页面上报错的部分）：
 *   ① 顶层调用 window.__ModuleLoader__.load({id, factory})
 *   ② id 必须 === package.json 的 name（宿主用解析出的包名标识浏览器模块）
 *   ③ factory(require) 返回 { name, apply }，且 name 与 id 一致
 *   ④ apply(ctx) 只用官方客户端 ctx 的能力：effect / slots.inject / slots.register
 *   ⑤ 两个 slot 的注册形状正确（name / id / order / inject / 组件函数）
 *   ⑥ require 只请求平台种子表里允许的模块（这里是 react）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..')
const CLIENT_SRC = fs.readFileSync(path.join(PKG_ROOT, 'client', 'client.js'), 'utf8')
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))

/** 极简 React 假实现：只需要让组件函数能跑、hooks 不崩。 */
function fakeReact() {
  const states = []
  let cursor = 0
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) }
    },
    useState(initial) {
      const i = cursor++
      if (states[i] === undefined) states[i] = typeof initial === 'function' ? initial() : initial
      const setter = (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v }
      return [states[i], setter]
    },
    useEffect() { return undefined },
    useRef(v) { return { current: v } },
    __resetCursor() { cursor = 0 },
  }
}

/** 造一个假浏览器环境 + 假加载器。 */
function makeEnv() {
  const registered = []
  const styleTags = []
  const fetches = []
  const listeners = new Map()
  let requested = []

  const React = fakeReact()

  const win = {
    __ModuleLoader__: {
      load(row) { registered.push(row) },
    },
    AudioContext: class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
      createGain() { return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
      createOscillator() {
        return { type: '', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }
      }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    },
    Audio: class { constructor(u) { this.src = u } play() { return Promise.resolve() } },
    FileReader: class {},
    fetch(url, opts) {
      fetches.push({ url, opts })
      // 一律返回一个"空但合法"的响应，让 runtime.start() 能走完不炸
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      })
    },
    setInterval() { return 1 },
    clearInterval() {},
    setTimeout() { return 1 },
    clearTimeout() {},
    addEventListener(n, fn) {
      if (!listeners.has(n)) listeners.set(n, [])
      listeners.get(n).push(fn)
    },
    removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      visibilityState: 'visible',
      hasFocus: () => true,
      head: {
        appendChild(node) { styleTags.push(node) },
      },
      createElement(tag) {
        return { tagName: tag, textContent: '', setAttribute() {}, remove() {} }
      },
      querySelector: () => null,
    },
  }
  win.window = win

  const ctx = vm.createContext(win)
  return {
    win,
    ctx,
    registered,
    styleTags,
    fetches,
    get requested() { return requested },
    load() {
      // require 只允许平台种子表
      const requireFn = (name) => {
        requested.push(name)
        if (name === 'react') return React
        throw new Error('模块不可解析（不在平台种子表里）: ' + name)
      }
      vm.runInContext(CLIENT_SRC, ctx, {
        filename: 'client.js',
        // 让 factory 里的 require 指向我们的函数
      })
      // 顶层只注册工厂，这里手动执行它
      const row = registered[registered.length - 1]
      return row.factory(requireFn)
    },
  }
}

test('顶层调用 __ModuleLoader__.load，且 id === package.json 的 name', () => {
  const env = makeEnv()
  env.load()
  assert.equal(env.registered.length, 1, '应恰好注册一个模块行')
  const row = env.registered[0]
  assert.equal(typeof row.factory, 'function', 'factory 必须是函数')
  assert.equal(row.id, PKG.name, 'factory 的 id 必须等于包名（宿主用包名标识浏览器模块）')
})

test('只 require 平台种子表里的模块（react）', () => {
  const env = makeEnv()
  env.load()
  for (const name of env.requested) {
    assert.ok(
      name === 'react' || name === 'react/jsx-runtime' || name === 'react-dom' ||
      name === '@deepseek-ai/dsh-client-ui-primitives',
      '请求了非基线模块: ' + name,
    )
  }
  assert.ok(env.requested.indexOf('react') >= 0, '至少要用到 react')
})

test('factory 返回 {name, apply}，name 与包名一致', () => {
  const env = makeEnv()
  const mod = env.load()
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.name, PKG.name)
})

test('导出了 cordis 服务 inject（否则 ctx.slots 会被代理挡住）', () => {
  const env = makeEnv()
  const mod = env.load()
  assert.ok(Array.isArray(mod.inject), 'exports.inject 必须是数组')
  // 注意：这个数组在 vm 的 realm 里创建，deepStrictEqual 会因为原型不同而失败，
  // 所以只比较内容与长度。
  assert.equal(mod.inject.length, 1, '只应声明 slots')
  assert.equal(mod.inject[0], 'slots')
  // 只用 slots：数据走 fetch，不依赖 connection/locale，声明多了反而会拖住挂载
  assert.equal(mod.inject.join(','), 'slots')
})

test('模拟 cordis 的代理守门：没 inject 就取不到 slots', () => {
  // 复刻 cordis ReflectService.handler 的语义：未声明 inject 的服务属性一取就抛。
  function makeGatedCtx(injectList) {
    const slots = {
      inject(s, r) { injectCalls.push(s); r() },
      register(m) { registrations.push(m); return () => {} },
    }
    const injectCalls = []
    const registrations = []
    const raw = {
      effect() { return () => {} },
      slots,
    }
    const allowed = new Set(injectList)
    const ctx = new Proxy(raw, {
      get(target, prop) {
        if (prop in target) {
          if (prop === 'slots' && !allowed.has('slots')) {
            throw new Error(`cannot get property "${String(prop)}" without inject`)
          }
          return target[prop]
        }
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    })
    return { ctx, injectCalls, registrations }
  }

  const env = makeEnv()
  const mod = env.load()

  // ① 不声明 inject：必须抛（证明这个门是真的，测试不会假绿）
  const bad = makeGatedCtx([])
  assert.throws(() => mod.apply(bad.ctx), /without inject/, '未声明 inject 时应当被代理挡住')

  // ② 按模块自己声明的 inject 放行：必须不抛，且两个 slot 都注册上
  const good = makeGatedCtx(mod.inject)
  assert.doesNotThrow(() => mod.apply(good.ctx))
  assert.deepEqual(good.injectCalls.sort(), ['conversation.input.left', 'settings.general.item'])
  assert.equal(good.registrations.length, 2)
})

test('apply 只用官方客户端 ctx 能力，并注册两个 slot', () => {
  const env = makeEnv()
  const mod = env.load()

  const registrations = []
  const injects = []
  const effects = []
  const fakeCtx = {
    effect(cb, label) { effects.push({ cb, label }); return () => {} },
    slots: {
      inject(slot, register) { injects.push(slot); register() },
      register(meta, component) { registrations.push({ meta, component }); return () => {} },
    },
  }

  mod.apply(fakeCtx)

  assert.deepEqual(injects.sort(), ['conversation.input.left', 'settings.general.item'])
  assert.equal(registrations.length, 2, '应注册两个 slot 条目')

  for (const r of registrations) {
    assert.equal(typeof r.meta.name, 'string')
    assert.equal(r.meta.name, injects.find((s) => s === r.meta.name) || r.meta.name, 'meta.name 应是该 slot 名')
    assert.equal(typeof r.meta.id, 'string', 'id 必填')
    assert.ok(r.meta.id.length > 0)
    assert.equal(typeof r.component, 'function', '必须给一个组件函数')
  }

  const names = registrations.map((r) => r.meta.name).sort()
  assert.deepEqual(names, ['conversation.input.left', 'settings.general.item'])
})

test('注入了样式，且样式带插件标记（便于清理/排查）', () => {
  const env = makeEnv()
  const mod = env.load()
  mod.apply({
    effect() { return () => {} },
    slots: { inject(s, r) { r() }, register(m, c) { return () => {} } },
  })
  assert.ok(env.styleTags.length >= 1, '应插入一个 <style>')
  const css = env.styleTags[0].textContent
  assert.ok(css.length > 100, '样式内容不该为空')
  assert.ok(css.indexOf('.dshns-') >= 0, '样式应包含本插件的类名前缀')
})

test('两个组件都能渲染成元素树而不抛错（含水位未就绪的早期状态）', () => {
  const env = makeEnv()
  const mod = env.load()
  const registrations = []
  mod.apply({
    effect() { return () => {} },
    slots: { inject(s, r) { r() }, register(m, c) { registrations.push(c); return () => {} } },
  })

  // runtime 已经 start()，但 fetch 是假的（返回 {}），settings 可能为 null。
  // 组件在 settings 缺失时必须优雅降级，不能抛。
  for (const comp of registrations) {
    assert.doesNotThrow(() => comp({}), '组件在设置未就绪时不能抛错')
  }
})

test('组件能渲染出真实控件（设置行有事件选择、喇叭按钮是 <button>）', () => {
  const env = makeEnv()
  const mod = env.load()
  const regs = []
  mod.apply({
    effect() { return () => {} },
    slots: { inject(s, r) { r() }, register(m, c) { regs.push({ m, c }); return () => {} } },
  })

  // 直接把 runtime 设置成"已就绪"，验证完整渲染路径
  const rt = env.win.__DSH_NOTIFY__.runtime
  rt.set({
    ready: true,
    settings: {
      mode: 'on',
      volume: 0.6,
      muteWhenFocused: false,
      events: {
        done: { on: true, sound: 'default:done' },
        question: { on: true, sound: 'default:question' },
        approval: { on: true, sound: 'default:approval' },
        error: { on: true, sound: 'default:error' },
      },
    },
    sounds: { builtin: [{ id: 'default:done', name: 'D' }], custom: [] },
  })

  for (const { m, c } of regs) {
    const tree = c({})
    assert.ok(tree, m.name + ' 应渲染出内容')
  }
})

test('设置行：模式改为下拉选择，且带三项标签', () => {
  const env = setupRow()
  const tree = env.row({})
  const mode = find(tree, (n) => n.props && n.props.className === 'dshns-mode')
  assert.ok(mode, '应渲染模式下拉（select.dshns-mode）')
  assert.equal(mode.type, 'select', '模式必须用下拉而不是按钮组')
  const labels = mode.children.map((o) => o.children.join(''))
  assert.deepEqual(labels, ['开启声音提示', '关闭声音提示', '智能判断'])
  // 旧的按钮组必须已经不存在
  assert.equal(find(tree, (n) => n.props && n.props.className === 'dshns-seg'), null,
    '按钮组 .dshns-seg 应该已被删除')
})

test('设置行：模式下拉 onChange 会保存所选模式', () => {
  const env = setupRow()
  let saved = null
  env.rt.saveSettings = (patch) => { saved = patch; return Promise.resolve() }
  const tree = env.row({})
  const mode = find(tree, (n) => n.props && n.props.className === 'dshns-mode')
  mode.props.onChange({ target: { value: 'smart' } })
  // 注意：patch 对象在 vm 的 realm 里创建，deepStrictEqual 会因为原型不同而失败，
  // 所以逐字段断言。
  assert.ok(saved, 'onChange 应当调用 saveSettings')
  assert.equal(saved.mode, 'smart')
})

test('设置行：试听按钮文本是「▶试听」', () => {
  const env = setupRow()
  const tree = env.row({})
  // 只挑"试听"按钮（上传音频也是 .dshns-btn，但不是试听）
  const btns = findAll(tree, (n) => n.props && n.props.className === 'dshns-btn' && n.props.title === '试听')
  assert.equal(btns.length, 5, '四个事件行各一个 + 顶部一个，实际: ' + btns.length)
  for (const b of btns) {
    assert.equal(b.children.join(''), '▶试听', '试听按钮文本应带三角符号')
  }
})

test('设置行：换声音后自动试听（不用再点按钮）', () => {
  const env = setupRow()
  const played = []
  env.rt.play = (id) => { played.push(id) }
  const tree = env.row({})
  const selects = findAll(tree, (n) => n.props && n.props.className === 'dshns-select')
  assert.equal(selects.length, 4, '四个事件各一个声音下拉')
  selects[0].props.onChange({ target: { value: 'preset:bell' } })
  assert.equal(played.length, 1, '换完声音应当立刻试听')
  assert.equal(played[0], 'preset:bell', '试听的应是刚选中的那个')
})

test('设置行：「应用在前台运行时不提示」文案正确且可切换', () => {
  const env = setupRow()
  let saved = null
  env.rt.saveSettings = (patch) => { saved = patch; return Promise.resolve() }
  const tree = env.row({})
  const texts = collectText(tree)
  assert.ok(texts.indexOf('应用在前台运行时不提示') >= 0,
    '应出现新文案，实际文本: ' + JSON.stringify(texts))
  assert.equal(texts.indexOf('看着屏幕时不响'), -1, '旧文案不该残留')

  // 该文案旁边的复选框（音量行里最后一个 checkbox）
  const boxes = findAll(tree, (n) => n.type === 'input' && n.props && n.props.type === 'checkbox')
  const focusBox = boxes[boxes.length - 1]
  focusBox.props.onChange({ target: { checked: true } })
  assert.ok(saved, 'onChange 应当调用 saveSettings')
  assert.equal(saved.muteWhenFocused, true)
})

test('喇叭按钮：提示文案为「已开启/已关闭提示音」，不含括号', () => {
  const env = makeEnv()
  const mod = env.load()
  let MuteButton = null
  mod.apply({
    effect() { return () => {} },
    slots: {
      inject(s, r) { r() },
      register(m, c) { if (m.name === 'conversation.input.left') MuteButton = c; return () => {} },
    },
  })
  const rt = env.win.__DSH_NOTIFY__.runtime

  rt.set({ muted: false })
  let btn = MuteButton({})
  assert.equal(btn.props['aria-label'], '已开启提示音')
  assert.equal(btn.props.title, '已开启提示音')

  rt.set({ muted: true })
  btn = MuteButton({})
  assert.equal(btn.props['aria-label'], '已关闭提示音')
  assert.equal(btn.props.title, '已关闭提示音')
  for (const t of [btn.props.title, btn.props['aria-label']]) {
    assert.ok(t.indexOf('（') < 0 && t.indexOf('(') < 0, '不应含括号: ' + t)
  }
})

// —— 上面几个测试共用的小工具 —

/** 起一个插件实例，返回已就绪的 runtime 与设置行组件。 */
function setupRow() {
  const env = makeEnv()
  const mod = env.load()
  let row = null
  mod.apply({
    effect() { return () => {} },
    slots: {
      inject(s, r) { r() },
      register(m, c) { if (m.name === 'settings.general.item') row = c; return () => {} },
    },
  })
  const rt = env.win.__DSH_NOTIFY__.runtime
  rt.set({
    ready: true,
    settings: {
      mode: 'on',
      volume: 0.6,
      muteWhenFocused: false,
      events: {
        done: { on: true, sound: 'default:done' },
        question: { on: true, sound: 'default:question' },
        approval: { on: true, sound: 'default:approval' },
        error: { on: true, sound: 'default:error' },
      },
    },
    sounds: {
      builtin: [
        { id: 'default:done', name: 'D' },
        { id: 'default:question', name: 'Q' },
        { id: 'default:approval', name: 'A' },
        { id: 'default:error', name: 'E' },
        { id: 'preset:bell', name: '铃音' },
      ],
      custom: [],
    },
  })
  return { env, rt, row }
}

/** 在元素树里找第一个满足条件的节点。 */
function find(node, pred) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const c of node) { const hit = find(c, pred); if (hit) return hit }
    return null
  }
  if (pred(node)) return node
  for (const c of node.children || []) { const hit = find(c, pred); if (hit) return hit }
  return null
}

/** 找出所有满足条件的节点。 */
function findAll(node, pred, out) {
  out = out || []
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const c of node) findAll(c, pred, out); return out }
  if (pred(node)) out.push(node)
  for (const c of node.children || []) findAll(c, pred, out)
  return out
}

/** 收集树里所有纯字符串文本。 */
function collectText(node, out) {
  out = out || []
  if (typeof node === 'string') { out.push(node); return out }
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const c of node) collectText(c, out); return out }
  for (const c of node.children || []) collectText(c, out)
  return out
}

test('apply 是幂等的：重复调用不会叠加样式或残留旧实例', () => {
  const env = makeEnv()
  const mod = env.load()
  const mk = () => ({
    effect() { return () => {} },
    slots: { inject(s, r) { r() }, register() { return () => {} } },
  })
  mod.apply(mk())
  const first = env.win.__DSH_NOTIFY__.runtime
  mod.apply(mk())
  const second = env.win.__DSH_NOTIFY__.runtime
  assert.notEqual(first, second, '重复 apply 应换一个新 runtime')
  assert.equal(env.styleTags.length, 1, '样式只应插入一次（不能每次 apply 都加一个 <style>）')
})

test('teardown 会释放 runtime', () => {
  const env = makeEnv()
  const mod = env.load()
  let teardown = null
  mod.apply({
    effect(cb) { teardown = cb(); return () => {} },
    slots: { inject(s, r) { r() }, register() { return () => {} } },
  })
  assert.equal(typeof teardown, 'function', 'effect 应返回清理函数')
  assert.doesNotThrow(() => teardown())
  assert.equal(env.win.__DSH_NOTIFY__.runtime, null)
})
