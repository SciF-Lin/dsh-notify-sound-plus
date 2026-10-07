/**
 * dsh-notify-sound-plus —— 客户端半区契约测试（不依赖真实浏览器）
 *
 * 用 vm 在一个手写的假浏览器环境里执行 client/client.js，验证：
 *   ① 能被官方模块加载器接受（id / exports / inject）
 *   ② 只请求平台种子表里的模块；缺官方 ui-primitives 时能降级运行
 *   ③ 两个 slot 的注册形状正确
 *   ④ 通用设置行 = 模式 + 试听 + 齿轮（不再内联整块设置）
 *   ⑤ 齿轮打开独立弹窗（官方 Modal），面板含声音提示 / 系统通知 / 自定义音频
 *   ⑥ 换声音后自动试听；系统通知按权限与开关正确弹出
 *
 * 为了能断言「齿轮内部长什么样」，这里实现了一个极简递归渲染器：
 * 它会真正调用函数组件，把元素树展开到宿主元素（button/div/…）。
 *
 * 运行： node --test test/client-contract.test.js
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

/** 极简 React：createElement 把 children 放进 props.children；hooks 按下标存状态。 */
function fakeReact() {
  const slots = []
  let cursor = 0
  return {
    createElement(type, props, ...children) {
      const p = Object.assign({}, props || {})
      const kids = children
        .flat(Infinity)
        .filter((c) => c !== null && c !== undefined && c !== false && c !== true)
      if (kids.length > 0) p.children = kids.length === 1 ? kids[0] : kids
      return { type, props: p }
    },
    useState(initial) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      const setter = (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }
      return [slots[i], setter]
    },
    useEffect() { return undefined },
    useRef(v) {
      const i = cursor++
      if (!(i in slots)) slots[i] = { current: v }
      return slots[i]
    },
    __begin() { cursor = 0 },
  }
}

/** 把元素树递归展开成宿主元素树（会真正调用函数组件）。 */
function render(node, React) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((n) => render(n, React)).filter((n) => n !== null)
  if (typeof node.type === 'function') return render(node.type(node.props), React)
  const kids = node.props ? node.props.children : undefined
  const rendered = kids === undefined ? [] : [].concat(render(kids, React)).flat(Infinity).filter((n) => n !== null)
  return { type: node.type, props: node.props || {}, children: rendered }
}

/** 造一个假浏览器环境 + 假加载器。 */
function makeEnv(opts) {
  const o = opts || {}
  const registered = []
  const styleTags = []
  const fetches = []
  const notifications = []
  const listeners = new Map()
  const requested = []
  let notifPermission = o.permission || 'granted'

  const React = fakeReact()

  // 官方 ui-primitives 替身：保留 props（含 className / title）以便断言，并透传 children。
  // Button 的 icon 是 **prop** 而不是 children，真实 Button 会把它渲染进按钮里；
  // 这里必须同样把 icon 合进 props.children，否则树遍历看不到图标（测试会假阴性）。
  // 注意 children 必须放在 props 上 —— render() 对宿主元素只读 props.children。
  const passthrough = (tag) => (p) => ({ type: tag, props: p || {} })
  const buttonStub = (p) => {
    const kids = []
    if (p && p.icon) kids.push(p.icon)
    if (p && p.children !== undefined) kids.push(p.children)
    return { type: 'Button', props: Object.assign({}, p || {}, { children: kids }) }
  }
  const primitivesStub = {
    Menu: passthrough('Menu'),
    Button: buttonStub,
    Modal: passthrough('Modal'),
    Switch: passthrough('Switch'),
    IconChevronDownOutlineRegular: passthrough('Icon'),
    IconChevronUpOutlineRegular: passthrough('Icon'),
    IconPlayOutlineRegular: passthrough('Icon'),
    IconSettingsOutlineMedium: passthrough('Icon'),
    IconSettingsOutlineRegular: passthrough('Icon'),
  }

  const win = {
    __ModuleLoader__: { load(row) { registered.push(row) } },
    AudioContext: class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
      createGain() { return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
      createOscillator() { return { type: '', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} } }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    },
    Audio: class { constructor(u) { this.src = u } play() { return Promise.resolve() } },
    FileReader: class {},
    fetch(url, o2) {
      fetches.push({ url, opts: o2 })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
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
      head: { appendChild(node) { styleTags.push(node) } },
      createElement(tag) { return { tagName: tag, textContent: '', setAttribute() {}, remove() {} } },
      querySelector: () => null,
    },
  }
  win.window = win

  const NotificationStub = function (title, options) {
    notifications.push({ title, options })
    this.title = title
    this.options = options
    this.close = function () {}
  }
  if (o.notification !== false) {
    NotificationStub.permission = notifPermission
    NotificationStub.requestPermission = function () {
      notifPermission = o.requestDenied ? 'denied' : 'granted'
      return Promise.resolve(notifPermission)
    }
    win.Notification = NotificationStub
  }
  win.__setPermission = function (p) { notifPermission = p; NotificationStub.permission = p }

  const ctx = vm.createContext(win)
  return {
    win,
    ctx,
    React,
    registered,
    styleTags,
    fetches,
    notifications,
    requested,
    load() {
      const requireFn = (name) => {
        requested.push(name)
        if (name === 'react') return React
        if (name === '@deepseek-ai/dsh-client-ui-primitives') {
          if (o.noPrimitives) throw new Error('模块不可解析（模拟旧宿主）: ' + name)
          return primitivesStub
        }
        throw new Error('模块不可解析（不在平台种子表里）: ' + name)
      }
      vm.runInContext(CLIENT_SRC, ctx, { filename: 'client.js' })
      const row = registered[registered.length - 1]
      return row.factory(requireFn)
    },
    /** 渲染一棵元素树（带 hooks 复位，保证多次渲染读到最新 state）。 */
    render(node) {
      React.__begin()
      return render(node, React)
    },
    /**
     * 挂载一个组件并渲染。
     * 必须由这里统一「复位 hooks → 调用组件 → 展开树」：如果让调用方先 `Comp({})`
     * 再交给 render，hooks 的游标就会跨次累积，读到错位的 state（曾导致面板打不开）。
     */
    mount(Comp, props) {
      React.__begin()
      return render(React.createElement(Comp, props), React)
    },
  }
}

// ============================================================ 加载器契约

test('顶层调用 __ModuleLoader__.load，且 id === package.json 的 name', () => {
  const env = makeEnv()
  env.load()
  assert.equal(env.registered.length, 1, '应恰好注册一个模块行')
  const row = env.registered[0]
  assert.equal(typeof row.factory, 'function', 'factory 必须是函数')
  assert.equal(row.id, PKG.name, 'factory 的 id 必须等于包名（宿主用包名标识浏览器模块）')
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
  // 该数组在 vm 的 realm 里创建，deepStrictEqual 会因原型不同失败，故逐项比较
  assert.equal(mod.inject.length, 1, '只应声明 slots')
  assert.equal(mod.inject[0], 'slots')
})

test('模拟 cordis 的代理守门：没 inject 就取不到 slots', () => {
  function makeGatedCtx(injectList) {
    const injectCalls = []
    const registrations = []
    const raw = {
      effect() { return () => {} },
      slots: {
        inject(s, r) { injectCalls.push(s); r() },
        register(m) { registrations.push(m); return () => {} },
      },
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

  const bad = makeGatedCtx([])
  assert.throws(() => mod.apply(bad.ctx), /without inject/, '未声明 inject 时应当被代理挡住')

  const good = makeGatedCtx(mod.inject)
  assert.doesNotThrow(() => mod.apply(good.ctx))
  assert.deepEqual(good.injectCalls.sort(), ['conversation.input.left', 'settings.general.item'])
  assert.equal(good.registrations.length, 2)
})

test('只请求平台种子表里的模块（react + 官方 primitives）', () => {
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
  assert.ok(env.requested.indexOf('@deepseek-ai/dsh-client-ui-primitives') >= 0,
    '应当尝试用官方 primitives（Menu/Button/Modal/Switch 等）')
})

test('官方 primitives 缺失时必须降级运行，而不是整块 UI 挂掉', () => {
  const env = makeEnv({ noPrimitives: true })
  const mod = env.load()
  assert.equal(typeof mod.apply, 'function', '缺 primitives 也要能加载')
  const regs = []
  assert.doesNotThrow(() => {
    mod.apply({
      effect() { return () => {} },
      slots: { inject(s, r) { r() }, register(m, c) { regs.push({ m, c }); return () => {} } },
    })
  }, '缺 primitives 时 apply 不能抛')
  for (const { m, c } of regs) {
    assert.ok(c({}), m.name + ' 降级后仍应渲染出内容')
  }
})
test('注入了样式，且样式带插件标记（便于清理/排查）', () => {
  const env = makeEnv()
  const mod = env.load()
  mod.apply({
    effect() { return () => {} },
    slots: { inject(s, r) { r() }, register() { return () => {} } },
  })
  assert.ok(env.styleTags.length >= 1, '应插入一个 <style>')
  const css = env.styleTags[0].textContent
  assert.ok(css.length > 100, '样式内容不该为空')
  assert.ok(css.indexOf('.dshns-') >= 0, '样式应包含本插件的类名前缀')
})

test('两个组件在设置未就绪时都能安全渲染', () => {
  const env = makeEnv()
  const mod = env.load()
  const comps = []
  mod.apply({
    effect() { return () => {} },
    slots: { inject(s, r) { r() }, register(m, c) { comps.push(c); return () => {} } },
  })
  for (const c of comps) {
    assert.doesNotThrow(() => env.mount(c, {}), '设置未就绪时组件不能抛错')
  }
})

// ============================================================ 通用设置行

test('通用设置行 = 标题 + 模式 + 试听图标 + 齿轮，且不内联整块设置', () => {
  const { env, tree } = setupRow()

  assert.ok(collectText(tree).indexOf('声音提醒') >= 0, '应有标题「声音提醒」')

  // 模式：官方 Menu 路径下是 Button 触发器，带 dshns-mode
  const mode = find(tree, (n) => n.props && n.props.className && String(n.props.className).indexOf('dshns-mode') >= 0)
  assert.ok(mode, '应有模式控件（读取 modeLabelOf 传入的当前值）')

  // 试听：图标按钮，无文字（Button 替身会把 icon 放进 children，所以断言"没有文本"而非"没有子节点"）
  const preview = find(tree, (n) => n.props && n.props.className === 'dshns-iconbtn' && /试听/.test(String(n.props.title || '')))
  assert.ok(preview, '应有试听按钮')
  assert.deepEqual(collectText(preview), [], '试听按钮应只有图标、没有文字（标签走 title/aria-label）')

  // 齿轮
  const gear = find(tree, (n) => n.props && n.props.className === 'dshns-iconbtn' && /设置/.test(String(n.props.title || '')))
  assert.ok(gear, '应有齿轮设置按钮')

  // 未点齿轮时不该有完整设置面板
  assert.equal(find(tree, (n) => n.props && n.props.className === 'dshns-panel'), null,
    '未点齿轮时不该内联渲染设置面板')
})

test('齿轮用的是与「通用设置」一致的官方图标（Medium 笔画，16px）', () => {
  const { tree } = setupRow()
  const icons = findAll(tree, (n) => n.type === 'Icon')
  // 齿轮按钮内的图标：size 16（通用设置用的就是 Medium/16）
  const gears = icons.filter((i) => i.props && i.props.size === 16)
  assert.ok(gears.length >= 1, '齿轮图标应为 16px（与侧边栏「通用设置」一致）')
})

test('齿轮打开独立弹窗（官方 Modal），且面板里不再重复「模式」', () => {
  const setup = setupRow()
  const { tree, panel } = openPanel(setup)

  // 外层必须是官方 Modal（独立窗口），不是内联 div
  const modal = find(tree, (n) => n.type === 'Modal')
  assert.ok(modal, '设置面板应由官方 Modal 承载（独立弹窗）')
  assert.equal(modal.props.open, true)
  assert.equal(typeof modal.props.onClose, 'function', '应当能关闭')

  const texts = collectText(panel)
  for (const t of ['声音提示', '音量', '前台不提示', '系统通知', '自定义音频']) {
    assert.ok(texts.indexOf(t) >= 0, '设置面板应含「' + t + '」')
  }
  assert.equal(texts.indexOf('模式'), -1, '弹窗里不该再出现「模式」（它已在通用设置行上显示）')
})

test('设置面板：四个事件都同时出现在声音提示与系统通知两组里', () => {
  const setup = setupRow()
  const { panel } = openPanel(setup)
  const texts = collectText(panel)
  for (const label of ['任务完成', '需要我回答', '需要我授权', '出错']) {
    const n = texts.filter((x) => x === label).length
    assert.ok(n >= 2, '「' + label + '」应同时出现在两组里，实际 ' + n)
  }
})

// ============================================================ 面板交互

test('面板：四个声音下拉，换音后自动试听', () => {
  const setup = setupRow()
  const played = []
  setup.rt.play = (id) => { played.push(id) }
  const { panel } = openPanel(setup)

  const menus = findAll(panel, (n) => n.type === 'Menu')
  const soundMenus = menus.filter((m) => ((m.props && m.props.items) || []).some((it) => it.id === 'preset:bell'))
  assert.equal(soundMenus.length, 4, '四个事件各一个声音下拉，实际 ' + soundMenus.length)

  soundMenus[0].props.onSelect('preset:bell')
  assert.equal(played.length, 1, '换完声音应立刻试听一次')
  assert.equal(played[0], 'preset:bell', '试听的应是刚选中的那个')
})

test('面板：系统通知总开关会申请权限并写入 system.enabled', () => {
  // 权限未授予时才应当申请（已授予还弹权限框是骚扰）
  const setup = setupRow({ notifyPermission: 'default' })
  const saved = []
  const permCalls = []
  setup.rt.saveSettings = (patch) => { saved.push(patch); return Promise.resolve() }
  setup.rt.requestPermission = () => { permCalls.push(1); return Promise.resolve('granted') }
  const { panel } = openPanel(setup)

  const master = toggleByTitle(panel, '在系统通知中心弹出提醒')
  assert.ok(master, '应能找到系统通知总开关')

  master.props.onChange(true)
  const patch = saved.find((p) => p.system && typeof p.system.enabled === 'boolean')
  assert.ok(patch, '总开关应写入 system.enabled')
  assert.equal(patch.system.enabled, true)
  assert.equal(permCalls.length, 1, '权限未授予时，打开总开关应申请一次')
})

test('面板：权限已授予时不再申请', () => {
  const setup = setupRow({ notifyPermission: 'granted' })
  const permCalls = []
  setup.rt.saveSettings = () => Promise.resolve()
  setup.rt.requestPermission = () => { permCalls.push(1); return Promise.resolve('granted') }
  const { panel } = openPanel(setup)
  toggleByTitle(panel, '在系统通知中心弹出提醒').props.onChange(true)
  assert.equal(permCalls.length, 0, '已授权时不该再弹权限请求')
})

test('面板：逐事件系统通知开关写入 system.events', () => {
  // 总开关要先开着，逐事件开关才是"可切换"的（关闭时它们是禁用状态）
  const setup = setupRow({ systemEnabled: true })
  const saved = []
  setup.rt.saveSettings = (patch) => { saved.push(patch); return Promise.resolve() }
  const { tree } = openPanel(setup)

  const sysToggles = findAll(tree, (n) => n.type === 'Switch' && n.props && String(n.props.title || '').indexOf('这个事件是否弹系统通知') >= 0)
  assert.equal(sysToggles.length, 4, '四个事件各一个系统通知开关，实际 ' + sysToggles.length)
  sysToggles[0].props.onChange(true)
  const patch = saved.find((p) => p.system && p.system.events)
  assert.ok(patch, '逐事件开关应写入 system.events')
  const key = Object.keys(patch.system.events)[0]
  assert.equal(patch.system.events[key], true)
  assert.ok(['done', 'question', 'approval', 'error'].indexOf(key) >= 0, '键应是事件名: ' + key)
})

test('面板：逐事件开关在总开关关闭时禁用', () => {
  const setup = setupRow()  // 默认 system.enabled = false
  const { tree } = openPanel(setup)
  const sysToggles = findAll(tree, (n) => n.type === 'Switch' && n.props && String(n.props.title || '').indexOf('先打开上面的系统通知总开关') >= 0)
  assert.equal(sysToggles.length, 4, '总开关关闭时四个逐事件开关都应提示先开总开关，实际 ' + sysToggles.length)
  for (const sw of sysToggles) {
    assert.equal(sw.props.disabled, true, '总开关关闭时逐事件开关应禁用')
  }
})

test('面板：音量与「应用在前台运行时不提示」可写', () => {
  const setup = setupRow()
  const saved = []
  setup.rt.saveSettings = (patch) => { saved.push(patch); return Promise.resolve() }
  const { tree, panel } = openPanel(setup)

  const range = find(panel, (n) => n.type === 'input' && n.props && n.props.type === 'range')
  assert.ok(range, '应有音量滑杆')
  range.props.onChange({ target: { value: '0.3' } })
  assert.equal(saved[saved.length - 1].volume, 0.3)

  const focusToggle = toggleByTitle(tree, '应用在前台运行时不出声')
  assert.ok(focusToggle, '应能找到「应用在前台运行时不提示」开关')
  focusToggle.props.onChange(true)
  assert.equal(saved[saved.length - 1].muteWhenFocused, true)

  const texts = collectText(panel)
  assert.ok(texts.indexOf('应用在前台运行时不提示') >= 0, '应出现「应用在前台运行时不提示」')
  assert.equal(texts.indexOf('看着屏幕时不响'), -1, '旧文案不该残留')
})

// ============================================================ 系统通知

function modWithRuntime(envOpts) {
  const env = makeEnv(envOpts)
  const mod = env.load()
  mod.apply({
    effect() { return () => {} },
    slots: { inject(s, r) { r() }, register() { return () => {} } },
  })
  return { env, rt: env.win.__DSH_NOTIFY__.runtime }
}

test('系统通知：已授权时能弹出，标题按事件区分，tag 含事件类型', () => {
  const { env, rt } = modWithRuntime({ permission: 'granted' })
  assert.equal(rt.permission(), 'granted')
  assert.equal(rt.notifySystem('question', false), true)
  assert.equal(env.notifications.length, 1)
  assert.equal(env.notifications[0].title, '需要你回答')
  assert.ok(String(env.notifications[0].options.tag).indexOf('question') >= 0,
    'tag 应含事件类型，便于同类通知合并')
})

test('系统通知：未授权时不弹（也不反复骚扰用户）', () => {
  const { env, rt } = modWithRuntime({ permission: 'denied' })
  assert.equal(rt.notifySystem('approval', false), false)
  assert.equal(env.notifications.length, 0)
})

test('系统通知：环境不支持时安全降级', () => {
  const { env, rt } = modWithRuntime({ notification: false })
  assert.equal(rt.notificationsSupported(), false)
  assert.doesNotThrow(() => rt.notifySystem('done', true))
  assert.equal(env.notifications.length, 0)
})

test('系统通知：requestPermission 返回授权结果', async () => {
  const { rt } = modWithRuntime({ permission: 'default' })
  assert.equal(await rt.requestPermission(), 'granted')
})

test('系统通知：四类事件各有自己的标题', () => {
  const { env, rt } = modWithRuntime({ permission: 'granted' })
  for (const kind of ['done', 'question', 'approval', 'error']) {
    rt.notifySystem(kind, false)
  }
  const titles = env.notifications.map((n) => n.title)
  assert.deepEqual(titles, ['任务完成', '需要你回答', '需要你授权', '出错了'])
  assert.equal(new Set(titles).size, 4, '四个标题应互不相同')
})

// ============================================================ 喇叭按钮

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
  let btn = env.mount(MuteButton, {})
  assert.equal(btn.props['aria-label'], '已开启提示音')
  assert.equal(btn.props.title, '已开启提示音')

  rt.set({ muted: true })
  btn = env.mount(MuteButton, {})
  assert.equal(btn.props['aria-label'], '已关闭提示音')
  assert.equal(btn.props.title, '已关闭提示音')
  for (const t of [btn.props.title, btn.props['aria-label']]) {
    assert.ok(t.indexOf('（') < 0 && t.indexOf('(') < 0, '不应含括号: ' + t)
  }
})

// ============================================================ 生命周期

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
  assert.equal(env.styleTags.length, 1, '样式只应插入一次')
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

// ============================================================ 测试工具

/** 起一个插件实例，返回 env / 已就绪的 runtime / 设置行组件。 */
function setupRow(opts) {
  const o = opts || {}
  const env = makeEnv(o)
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
    notifyPermission: o.notifyPermission || 'granted',
    settings: {
      mode: o.mode || 'on',
      volume: 0.6,
      muteWhenFocused: false,
      events: {
        done: { on: true, sound: 'default:done' },
        question: { on: true, sound: 'default:question' },
        approval: { on: true, sound: 'default:approval' },
        error: { on: true, sound: 'default:error' },
      },
      system: {
        enabled: !!o.systemEnabled,
        events: { done: false, question: true, approval: true, error: false },
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
  return { env, rt, row, tree: env.mount(row, {}) }
}

/** 点开齿轮，返回 { tree, panel }（tree 是整棵树，panel 是面板内容）。 */
function openPanel(setup) {
  const gear = find(setup.tree, (n) => n.props && n.props.className === 'dshns-iconbtn' && /设置/.test(String(n.props.title || '')))
  assert.ok(gear, '应能找到齿轮按钮')
  gear.props.onClick()
  const tree = setup.env.mount(setup.row, {})
  const panel = find(tree, (n) => n.props && n.props.className === 'dshns-panel')
  assert.ok(panel, '点齿轮后应渲染设置面板')
  return { tree, panel }
}

/** 按 title 找一个开关（比按下标稳：将来加行不会让测试错位）。 */
function toggleByTitle(tree, title) {
  const sw = findAll(tree, (n) => n.type === 'Switch' && n.props && String(n.props.title || '').indexOf(title) >= 0)
  return sw[0]
}

/** 在宿主元素树里找第一个满足条件的节点。 */
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
