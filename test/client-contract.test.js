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
  const cleanups = []
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
    // 立即执行 effect（相当于 mount 后跑一次）。不模拟依赖数组与卸载时机，
    // 但足以验证「Esc 监听有没有挂上」这类副作用。
    useEffect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    useRef(v) {
      const i = cursor++
      if (!(i in slots)) slots[i] = { current: v }
      return slots[i]
    },
    __begin() { cursor = 0 },
    /** 显式触发所有已登记清理（模拟卸载）。 */
    __cleanup() {
      for (const fn of cleanups.splice(0)) {
        try { fn() } catch (err) {}
      }
    },
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
      // 极简 document 事件表：Esc 关闭弹窗要靠它验证
      _listeners: {},
      addEventListener(n, fn) {
        const a = (this._listeners[n] = this._listeners[n] || [])
        a.push(fn)
      },
      removeEventListener(n, fn) {
        const a = this._listeners[n] || []
        const i = a.indexOf(fn)
        if (i >= 0) a.splice(i, 1)
      },
      dispatch(n, ev) {
        for (const f of (this._listeners[n] || []).slice()) f(ev)
      },
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

test('只需要 react：不再请求官方 ui-primitives（外观改由内联图标 + 自绘控件保证）', () => {
  const env = makeEnv()
  env.load()
  for (const name of env.requested) {
    assert.equal(name, 'react', '唯一应当请求的模块是 react，实际请求了: ' + name)
  }
  assert.ok(env.requested.indexOf('react') >= 0, '至少要用到 react')
  assert.equal(env.requested.indexOf('@deepseek-ai/dsh-client-ui-primitives'), -1,
    '不该再依赖 primitives —— 它在真实宿主里不保证能解析到，会导致齿轮退化成文字符号、下拉退化成原生 select')
})

test('宿主不给官方组件时，UI 也照常渲染（因为压根不依赖）', () => {
  const env = makeEnv({ noPrimitives: true })
  const mod = env.load()
  assert.equal(typeof mod.apply, 'function')
  const regs = []
  assert.doesNotThrow(() => {
    mod.apply({
      effect() { return () => {} },
      slots: { inject(s, r) { r() }, register(m, c) { regs.push({ m, c }); return () => {} } },
    })
  })
  for (const { m, c } of regs) {
    assert.ok(c({}), m.name + ' 应当渲染出内容')
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

test('试听与设置是两个规格完全一致的图标按钮（同 28×28 / 同 16px 图标）', () => {
  const { env, tree } = setupRow()
  const btns = findAll(tree, (n) => n.props && n.props.className === 'dshns-iconbtn')
  assert.equal(btns.length, 2, '通用设置行应恰有两个图标按钮（试听 + 设置），实际 ' + btns.length)

  for (const b of btns) {
    assert.equal(b.type, 'button', '应是原生 button')
    const icon = find(b, (n) => n.type === 'svg')
    assert.ok(icon, '每个按钮都应带一个内联图标')
    assert.equal(icon.props.width, 16, '图标槽应为 16px')
    assert.equal(icon.props.height, 16)
    assert.equal(icon.props.viewBox, '0 0 16 16', '应与官方 artwork 的 viewBox 一致')
    // 无文字：标签只走 title / aria-label
    assert.deepEqual(collectText(b), [], '图标按钮不应带文字')
  }

  // 尺寸契约写在 CSS 里
  const css = env.styleTags[0].textContent
  assert.ok(css.indexOf('.dshns-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0') >= 0,
    '图标按钮应是 28×28 方形且无内边距')
})

test('齿轮/播放/箭头/关闭/勾 都是内联的官方 artwork（viewBox 16、currentColor、Medium 1.3px）', () => {
  const { tree } = setupRow()
  const svgs = findAll(tree, (n) => n.type === 'svg')
  assert.ok(svgs.length >= 3, '通用设置行至少应有 模式箭头 + 播放 + 齿轮 三个图标，实际 ' + svgs.length)
  for (const s of svgs) {
    assert.equal(s.props.viewBox, '0 0 16 16')
    assert.equal(s.props.fill, 'none')
    assert.equal(s.props['aria-hidden'], 'true', '装饰性图标应对读屏隐藏')
    const paths = findAll(s, (n) => n.type === 'path')
    assert.ok(paths.length >= 1, '图标至少应有一条 path')
    for (const p of paths) assert.equal(p.props.stroke, 'currentColor', 'path 用 currentColor 跟随文字色')
  }
  // 齿轮必须是官方 Medium 笔画的 2 段 artwork（外齿 + 中心圆）
  const gear = find(tree, (n) => n.props && n.props.className === 'dshns-iconbtn' && /设置/.test(String(n.props.title || '')))
  const gearSvg = find(gear, (n) => n.type === 'svg')
  assert.equal(gearSvg.props.strokeWidth, 1.3, '齿轮应用官方 Medium 笔画 1.3px')
  assert.equal(findAll(gearSvg, (n) => n.type === 'path').length, 2, '官方齿轮 artwork 是两段 path')
})

test('齿轮打开独立弹窗，且面板里不再重复「模式」', () => {
  const setup = setupRow()
  const { tree, panel } = openPanel(setup)

  // 承载容器：自绘 overlay + sheet（宽高比照抄官方设置面板，见下一条样式断言）
  const overlay = find(tree, (n) => n.props && n.props.className === 'dshns-overlay')
  assert.ok(overlay, '应由全屏 overlay 承载（独立弹窗）')
  const mask = find(tree, (n) => n.props && n.props.className === 'dshns-mask')
  assert.ok(mask, '应有遮罩层')
  assert.equal(typeof mask.props.onClick, 'function', '点遮罩应当能关闭')

  const texts = collectText(panel)
  for (const t of ['提醒', '音量', '系统通知', '自定义音频']) {
    assert.ok(texts.indexOf(t) >= 0, '设置面板应含「' + t + '」')
  }
  assert.equal(texts.indexOf('模式'), -1, '弹窗里不该再出现「模式」（它已在通用设置行上显示）')
})

test('弹窗尺寸对齐官方设置面板，宽度按要求缩到 3/4（600px）', () => {
  const env = makeEnv()
  const mod = env.load()
  mod.apply({ effect() { return () => {} }, slots: { inject(s, r) { r() }, register() { return () => {} } } })
  const css = env.styleTags[0].textContent
  // 逐条对齐官方 ui-settings-general 的 .panel / .overlay / .mask
  const must = [
    'width:600px',
    'height:min(800px,calc(100vh - 2 * max(24px,var(--dsh-frame-overlay-top,24px))))',
    'max-width:calc(100vw - 48px)',
    'border-radius:var(--dsw-radius-panel)',
    'background:var(--dsw-alias-bg-layer-2)',
    'box-shadow:var(--dsw-elevation-prominent)',
    'background:var(--dsw-alias-bg-mask-1)',
    'inset:var(--dsh-frame-chrome-top,0px) 0 0',
  ]
  for (const t of must) {
    assert.ok(css.indexOf(t) >= 0, '样式应含官方设置面板的：' + t)
  }
  // 设置行要用官方 Setting-Cell 的排版（标题 14/22、行距 16px 0、发丝线）
  for (const t of ['padding:16px 0', 'font-size:14px;line-height:22px', 'border-bottom:.5px solid var(--dsw-alias-border-l2)']) {
    assert.ok(css.indexOf(t) >= 0, '设置行样式应对齐官方 Setting-Cell：' + t)
  }
})

test('下拉卡片与选项行逐条对齐官方 Menu.module.css', () => {
  const env = makeEnv()
  const mod = env.load()
  mod.apply({ effect() { return () => {} }, slots: { inject(s, r) { r() }, register() { return () => {} } } })
  const css = env.styleTags[0].textContent
  const must = [
    // 卡片：4px 内边距、radius-lg、prominent 立体阴影、菜单材质底色
    'padding:4px;min-width:144px;max-width:360px',
    'border-radius:var(--dsw-radius-lg)',
    'background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-overlay))',
    'backdrop-filter:var(--dsw-menu-backdrop-filter)',
    '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1)',
    // 选项行：min-height 34 / padding 6px 8px / radius-md / 13px 文字
    'min-height:34px;padding:6px 8px',
    'border-radius:var(--dsw-radius-md)',
    'font-size:13px;line-height:20px',
    // hover 填充
    '.dshns-ddItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    // 选中项不打底色，靠尾部勾标记
    '.dshns-ddCheck{flex:none;color:var(--dsw-alias-label-primary)}',
  ]
  for (const t of must) {
    assert.ok(css.indexOf(t) >= 0, '下拉样式应对齐官方 Menu：' + t)
  }
})

test('开关尺寸与配色逐条对齐官方 Switch.module.css', () => {
  const env = makeEnv()
  const mod = env.load()
  mod.apply({ effect() { return () => {} }, slots: { inject(s, r) { r() }, register() { return () => {} } } })
  const css = env.styleTags[0].textContent
  const must = [
    'width:36px;height:20px;padding:2px;border:0;border-radius:999px',
    'background:var(--dsw-alias-border-l3)',
    '.dshns-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
    'width:16px;height:16px;border-radius:50%',
    'background:var(--dsw-alias-switch-thumb)',
    '.dshns-switch[aria-checked="true"] .dshns-thumb{transform:translateX(16px)}',
  ]
  for (const t of must) {
    assert.ok(css.indexOf(t) >= 0, '开关样式应对齐官方 Switch：' + t)
  }
})

test('弹窗关闭：点右上角 X 能关掉（本次修的 bug）', () => {
  const setup = setupRow()
  const { tree } = openPanel(setup)

  const close = find(tree, (n) => n.props && n.props.className === 'dshns-close')
  assert.ok(close, '应有右上角关闭按钮')
  assert.equal(typeof close.props.onClick, 'function', '关闭按钮必须有 onClick')
  assert.equal(close.props['aria-label'], '关闭')

  close.props.onClick()
  const after = setup.env.mount(setup.row, {})
  assert.equal(find(after, (n) => n.props && n.props.className === 'dshns-sheet'), null,
    '点 X 之后弹窗应当消失')
})

test('弹窗关闭：点遮罩、按 Esc 也能关掉', () => {
  // 点遮罩
  const s1 = setupRow()
  const r1 = openPanel(s1)
  find(r1.tree, (n) => n.props && n.props.className === 'dshns-mask').props.onClick()
  assert.equal(find(s1.env.mount(s1.row, {}), (n) => n.props && n.props.className === 'dshns-sheet'), null,
    '点遮罩应当关闭')

  // Esc
  const s2 = setupRow()
  openPanel(s2)
  s2.env.win.document.dispatch('keydown', { key: 'Escape', shiftKey: false, preventDefault() {} })
  assert.equal(find(s2.env.mount(s2.row, {}), (n) => n.props && n.props.className === 'dshns-sheet'), null,
    'Esc 应当关闭')
})

test('系统通知只保留总开关，不再有逐事件开关', () => {
  const setup = setupRow({ systemEnabled: true })
  const { tree, panel } = openPanel(setup)

  const texts = collectText(panel)
  assert.ok(texts.indexOf('系统通知') >= 0, '应有系统通知分组')

  // 逐事件系统通知开关必须已经不存在
  const perEvent = findAll(tree, (n) => isSwitch(n) &&
    /这个事件是否弹系统通知|先打开上面的系统通知总开关/.test(String(n.props.title || '')))
  assert.equal(perEvent.length, 0, '系统通知不该再有逐事件开关')

  // 总开关仍在
  const master = toggleByTitle(tree, '通过系统通知提醒')
  assert.ok(master, '总开关必须保留')
})

test('面板：开关数量与预期一致（4 个声音 + 前台不提示 + 系统通知总开关）', () => {
  const setup = setupRow()
  const { tree } = openPanel(setup)
  const switches = findAll(tree, isSwitch)
  assert.equal(switches.length, 6, '四个声音事件 + 前台不提示 + 系统通知总开关，实际 ' + switches.length)
  for (const sw of switches) {
    assert.equal(sw.type, 'button', '开关应是原生 button')
    assert.equal(sw.props['aria-checked'] === 'true' || sw.props['aria-checked'] === 'false', true,
      '开关必须暴露 aria-checked（与官方 Switch 一样让语义与视觉同源）')
    assert.ok(find(sw, (n) => n.props && n.props.className === 'dshns-thumb'), '开关应有圆形滑块')
  }
})

test('设置面板：四个事件名都出现在声音提示分组里', () => {
  const setup = setupRow()
  const { panel } = openPanel(setup)
  const texts = collectText(panel)
  for (const label of ['任务完成', '需要回答', '需要授权', '运行出错']) {
    assert.ok(texts.indexOf(label) >= 0, '提醒分组应含「' + label + '」')
  }
})

test('设置页底部附 GitHub 仓库地址', () => {
  const setup = setupRow()
  const { tree, panel } = openPanel(setup)

  const foot = find(tree, (n) => n.props && n.props.className === 'dshns-sheetFoot')
  assert.ok(foot, '设置页应有页脚')

  const link = find(foot, (n) => n.type === 'a')
  assert.ok(link, '页脚应有仓库链接')
  assert.equal(link.props.href, 'https://github.com/SciF-Lin/dsh-notify-sound-plus')
  assert.equal(link.props.target, '_blank', '外链应新开标签，避免把 DSH 页面导航走')
  assert.ok(/noreferrer/.test(String(link.props.rel)))
  assert.equal(collectText(link).join(''), '欢迎访问GitHub仓库送上star与issue！')

  // 页脚在滚动区之外（常驻可见），且不打乱面板正文
  assert.ok(collectText(foot).join('|').indexOf('github.com/SciF-Lin/dsh-notify-sound-plus') >= 0,
    '页脚应显示仓库地址')
  const body = find(tree, (n) => n.props && n.props.className === 'dshns-sheetBody')
  assert.equal(collectText(body).join('').indexOf('欢迎访问'), -1, '页脚不该混进滚动正文')
  assert.ok(collectText(panel).indexOf('提醒') >= 0, '正文仍在')
})

test('文案口径统一：用「提醒」而非「声音提示」，且不留旧措辞', () => {
  const env = makeEnv()
  const mod = env.load()
  mod.apply({ effect() { return () => {} }, slots: { inject(s, r) { r() }, register() { return () => {} } } })
  const src = CLIENT_SRC

  // 用户点名的替换
  assert.equal(src.indexOf('开启声音提示'), -1)
  assert.equal(src.indexOf('关闭声音提示'), -1)
  assert.equal(src.indexOf('试听「'), -1, '试听按钮的提示应只剩「试听」')
  assert.equal(src.indexOf('切到别的应用'), -1)
  assert.equal(src.indexOf('权限：已授权'), -1, '权限文案应为「已开启」')

  assert.ok(src.indexOf("label: '开启提醒'") >= 0)
  assert.ok(src.indexOf("label: '关闭提醒'") >= 0)
  assert.ok(src.indexOf('与小鲸鱼挂件协助提醒（未开启事件由本插件提醒）') >= 0)
  assert.ok(src.indexOf('仅在后台运行时提醒') >= 0)
  assert.ok(src.indexOf('需要回答 / 授权 / 任务完成时 系统通知 · 权限：') >= 0)
})

// ============================================================ 面板交互

test('面板：四个声音下拉，展开后是官方样式的卡片，换音后自动试听', () => {
  const setup = setupRow()
  const played = []
  setup.rt.play = (id) => { played.push(id) }
  openPanel(setup)

  // 声音下拉 = 不带 dshns-mode 的下拉（模式那个在通用设置行里，带 dshns-mode）
  const t1 = setup.env.mount(setup.row, {})
  const soundDds = findAll(t1, (n) => n.props && n.props.className === 'dshns-dd')
  assert.equal(soundDds.length, 4, '四个事件各一个声音下拉，实际 ' + soundDds.length)

  // 展开第一个：只有展开时才出现卡片
  const trig = find(soundDds[0], (n) => n.props && n.props.className === 'dshns-ddTrigger')
  assert.ok(trig, '下拉应有触发器')
  assert.equal(trig.props['aria-expanded'], 'false')
  trig.props.onClick()

  const t2 = setup.env.mount(setup.row, {})
  const cards = findAll(t2, (n) => n.props && n.props.className === 'dshns-ddCard')
  assert.equal(cards.length, 1, '同一时刻只应展开一个下拉卡片')

  // 卡片里的选项行：选中的那项右侧带勾（官方是「不打底色 + 尾部勾」）
  const items = findAll(cards[0], (n) => n.props && n.props.className === 'dshns-ddItem')
  assert.ok(items.length >= 5, '应列出全部内置音色，实际 ' + items.length)
  const checked = items.filter((it) => find(it, (n) => n.type === 'svg'))
  assert.equal(checked.length, 1, '应恰好一项带选中勾，实际 ' + checked.length)

  // 点「铃音」→ 写入 + 立刻试听
  const bell = items.find((it) => collectText(it).join('') === '铃音')
  assert.ok(bell, '卡片里应有「铃音」这一项')
  bell.props.onClick()
  assert.equal(played.length, 1, '换完声音应立刻试听一次')
  assert.equal(played[0], 'preset:bell', '试听的应是刚选中的那个')
})

test('下拉：按 Esc 只收起下拉（不连设置弹窗一起关），点外面也收起', () => {
  const setup = setupRow()
  openPanel(setup)

  function openFirstSoundDd() {
    const t = setup.env.mount(setup.row, {})
    const dd = findAll(t, (n) => n.props && n.props.className === 'dshns-dd')[0]
    assert.ok(dd, '应能找到声音下拉')
    find(dd, (n) => n.props && n.props.className === 'dshns-ddTrigger').props.onClick()
    const after = setup.env.mount(setup.row, {})
    assert.equal(findAll(after, (n) => n.props && n.props.className === 'dshns-ddCard').length, 1, '下拉应已展开')
    return findAll(after, (n) => n.props && n.props.className === 'dshns-dd')[0]
  }

  // —— Esc：只收下拉 ——
  let dd = openFirstSoundDd()
  dd.props.onKeyDown({ key: 'Escape', stopPropagation() {}, preventDefault() {} })
  let t = setup.env.mount(setup.row, {})
  assert.equal(findAll(t, (n) => n.props && n.props.className === 'dshns-ddCard').length, 0, 'Esc 应收起下拉')
  assert.ok(find(t, (n) => n.props && n.props.className === 'dshns-sheet'), 'Esc 不该把设置弹窗一起关掉')

  // —— 点外面 ——
  dd = openFirstSoundDd()
  setup.env.win.document.dispatch('mousedown', { target: {} })
  t = setup.env.mount(setup.row, {})
  assert.equal(findAll(t, (n) => n.props && n.props.className === 'dshns-ddCard').length, 0, '点外面应收起下拉')
  assert.ok(find(t, (n) => n.props && n.props.className === 'dshns-sheet'), '点外面也不该关掉设置弹窗')
})

test('面板：系统通知总开关会申请权限并写入 system.enabled', () => {
  // 权限未授予时才应当申请（已授予还弹权限框是骚扰）
  const setup = setupRow({ notifyPermission: 'default' })
  const saved = []
  const permCalls = []
  setup.rt.saveSettings = (patch) => { saved.push(patch); return Promise.resolve() }
  setup.rt.requestPermission = () => { permCalls.push(1); return Promise.resolve('granted') }
  const { panel } = openPanel(setup)

  const master = toggleByTitle(panel, '通过系统通知提醒')
  assert.ok(master, '应能找到系统通知总开关')

  master.props.onClick()
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
  toggleByTitle(panel, '通过系统通知提醒').props.onClick()
  assert.equal(permCalls.length, 0, '已授权时不该再弹权限请求')
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

  const focusToggle = toggleByTitle(tree, '仅在后台运行时提醒')
  assert.ok(focusToggle, '应能找到「应用在前台运行时不提示」开关')
  focusToggle.props.onClick()
  assert.equal(saved[saved.length - 1].muteWhenFocused, true)

  const texts = collectText(panel)
  assert.ok(texts.indexOf('前台运行时不提醒') >= 0, '应出现「前台运行时不提醒」')
  assert.equal(texts.indexOf('切到别的应用'), -1, '旧文案不该残留')
  assert.equal(texts.join('').indexOf('不看 DSH'), -1, '旧文案不该残留')
  assert.equal(texts.join('').indexOf('已降级显示'), -1, '不该再出现「界面已降级显示」提示')
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
  assert.deepEqual(titles, ['任务完成', '需要你回答', '需要你授权', '运行出错'])
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

/** 是不是一个开关（自绘的官方样式 Switch：button[role=switch]）。 */
function isSwitch(n) {
  return n && n.type === 'button' && n.props && n.props.role === 'switch'
}

/** 按 title 找一个开关（比按下标稳：将来加行不会让测试错位）。 */
function toggleByTitle(tree, title) {
  return findAll(tree, (n) => isSwitch(n) && String(n.props.title || '').indexOf(title) >= 0)[0]
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
