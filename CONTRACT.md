# dsh-notify-sound —— 实现契约（冻结）

日期：2026-10-05　状态：**已冻结，前后端按此实现**

## 0. 为什么从「手写注入脚本」换成 `dsh.client` 模块

旧实现（v1）用 `webserver/index-inject` 注入一段独立脚本。要让设置页与喇叭按钮出现在
**官方 slot 树**里，必须走官方客户端模块通道：

- `@deepseek-ai/dsh-client-modules` 的 node 半区**自动扫描**已启用 Loader 条目的
  `dsh.client` 声明，自动注册 `/plugins` 前缀路由，并自动把 boot graph 通过
  `webserver/index-inject` 推给页面。
- 因此**插件自己不需要注册任何 script 路由**，桌面端也自动兼容（走的是官方通道）。

关键事实（均已在本机 asar 中核对）：

| 事实 | 证据 |
|---|---|
| 路由前缀 `/plugins` | `dsh-client-modules/lib/index.js` `const PLUGIN_ROUTE = "/plugins"` |
| 自动注册路由 | `webCtx.effect(() => webCtx.webServer.register({kind:"prefix", path:PLUGIN_ROUTE, handler:this.serveBundle}))` |
| 自动推送 boot graph | `ctx.on("webserver/index-inject", (table) => { table.push(...bootInjections(this.composed)) })` |
| 需要 `pnpm run build` 产出 `lib/client.js` | README「Build requirements」；缺失会**大声报错**（不是静默） |

## 1. package.json 增补

```json
"exports": {
  ".": { "default": "./lib/index.js" },
  "./client": "./client/client.js",
  "./cordis.patch.yml": "./cordis.patch.yml",
  "./package.json": "./package.json"
},
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": [] }
}
```

`inject` 留空：本插件只依赖 `slots`（用 `ctx.slots.inject` 等 slot 出现，不硬依赖）。
**不要**在 `dsh.client.inject` 里写 `slots`——那是客户端 Loader 的服务名，写错会拖住整个模块。

## 2. client/client.js 打包格式

不需要 bundler：**手写** CJS 工厂即可（无 JSX，用 `React.createElement`）。

```js
window.__ModuleLoader__.load({
  id: 'dsh-notify-sound',            // 必须 === package.json 的 name
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    const React = require('react');   // 唯一外部依赖；构建期 external
    // ... 实现 ...
    exports.name = 'dsh-notify-sound';
    exports.apply = apply;
    return module.exports;
  }
});
```

外部可解析模块仅限平台种子表：`react`、`react-dom`、`react/jsx-runtime`、
`@deepseek-ai/dsh-client-ui-primitives`。本插件 require `react` + 官方 primitives，
但 **primitives 是可选依赖**：拿不到就整体降级为自绘控件，绝不能白屏。

## 3. 两个 slot

### 3.1 `settings.general.item`（通用设置里的行）

只放**摘要**：标题 + 模式下拉 + 播放图标按钮 + 齿轮按钮。完整设置走齿轮打开的弹窗。

```js
ctx.slots.inject('settings.general.item', () => ctx.slots.register({
  name: 'settings.general.item',
  id: 'dsh-notify-sound-plus',  // 必填
  order: 12,                    // Language=0, Appearance=10, FontSize=11, ComposerEnter=20
  inject: () => ({ api })       // 额外 props，会合并进组件 props
}, SoundRow))
```

组件收到的 props：`inject()` 返回的对象 + slot 自己的 props。组件读 `props.api`。

### 3.2 `conversation.input.left`（对话输入框左下角）

```js
ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
  name: 'conversation.input.left',
  id: 'dsh-notify-sound-plus-mute',
  order: 10,
  inject: () => ({ api })
}, MuteButton))
```

`kind: 'list'`、`scope: 'session'`，仅在真实会话中渲染（`sessionId === undefined` 时宿主不渲染该 slot）。

### 3.3 独立设置弹窗（点齿轮）

**不用官方 primitives 的 `Modal`**：它固定是 380px 窄卡片
（`.dialog{width:min(380px,100%)}`），而 DSH 里设置类界面用的是宽面板。
两者宽高比完全不同，塞进去既不像官方、内容也会被压扁。

改为自绘 overlay + sheet，但**尺寸与视觉 token 逐条照抄官方设置面板**
（见 `ui-settings-general` 的 `.overlay` / `.mask` / `.panel`）：

| 元素 | 规格 |
|---|---|
| `.dshns-overlay` | `position:fixed; inset:0; z-index:1001; flex 居中; padding: max(24px,var(--dsh-frame-overlay-top,24px)) 24px` |
| `.dshns-mask` | `inset: var(--dsh-frame-chrome-top,0px) 0 0`；`background: var(--dsw-alias-bg-mask-1)`；`backdrop-filter: var(--dsw-mask-blur)` |
| `.dshns-sheet` | `width:600px`（官方 800px 的 3/4）；`height:min(800px, 100vh - 2*max(24px,var(--dsh-frame-overlay-top,24px)))`；`max-width:calc(100vw - 48px)`；`border-radius:var(--dsw-radius-panel)`；`background:var(--dsw-alias-bg-layer-2)`；`box-shadow:var(--dsw-elevation-prominent)` |

关闭有**三条路径**，全部由插件自己接管：右上角 X、点遮罩、按 Esc（打开期间挂
document keydown，卸载即摘）。不走嵌套弹层的内部行为。

内部布局用官方 **Setting-Cell** 模式（与「通用设置」里的行同构）：
左侧标题(14/22) + 可选说明(12px secondary)，右侧控件，行间 `.5px` 发丝线。

分组：

- **声音提示**：四事件（开关 + 声音下拉 + 播放按钮）、音量、「应用在前台运行时不提示」
- **系统通知**：**只有总开关**。打开后哪些事件弹由宿主默认值决定
  （`done/question/approval` 弹、`error` 不弹）
- **自定义音频**：上传 + 已上传列表

**模式不放进弹窗**——它已经显示在通用设置那一行，重复一份只会让人怀疑两处不同步。

### 3.4 控件全部自绘，规格照抄官方（零 primitives 依赖）

⚠️ **血泪教训**：早期版本 `require('@deepseek-ai/dsh-client-ui-primitives')` 后
按官方组件渲染，拿不到就"降级"。实测在真实宿主里拿不到，于是：

- 齿轮退化成 `⚙` 文字符号（跟官方图标完全不是一回事）
- 下拉退化成原生 `<select>` —— 弹层是操作系统的蓝色高亮列表，与官方菜单天差地别
- 开关退化成原生 checkbox
- 界面上还挂着一句"已降级显示"的提示

现在**唯一 require 的是 `react`**，其余全部自绘，规格逐条对齐官方 CSS：

| 控件 | 对齐来源 | 关键规格 |
|---|---|---|
| 图标 | `*OutlineArtwork` 的 path | viewBox `0 0 16 16`、`stroke="currentColor"`、`fill="none"`、`aria-hidden`；笔画 Regular=1 / Medium=1.3 |
| 下拉卡片 | `Menu.module.css` `.list` | `padding:4px`、`min-width:144px`、`max-width:360px`、`radius-lg`、`--dsw-menu-surface-fill` + `--dsw-menu-backdrop-filter`、`elevation-prominent` |
| 下拉选项 | `Menu.module.css` `.item` | `min-height:34px`、`padding:6px 8px`、`radius-md`、`13px/20px`、hover `interactive-bg-hover` |
| 选中标记 | `.selected` + `.check` | **不打底色**，右侧一个 14px 的勾 |
| 开关 | `Switch.module.css` | 36×20 轨道 / 2px 内边距 / 16px 圆滑块 / 选中 `translateX(16px)`；关=`border-l3`+`switch-thumb`，开=`brand-primary`；用 `role="switch"`+`aria-checked` |
| 图标按钮 | `Modal.module.css` `.close` | 28×28、`radius-sm`、透明底、`label-secondary` → hover `label-primary` + 浅底 |

图标路径内联在 `client.js` 顶部的 `ICON_PATHS`（settings / play / chevronDown /
close / check），改宿主版本也不会漂移。

**Esc 分层**：下拉的 Esc 处理挂在 `.dshns-dd` 元素上并 `stopPropagation`，
所以只收下拉、不关设置弹窗 —— 官方 Menu 也是"只有最上层响应 Esc"的语义。

### 3.5 图标动作按钮（试听 / 设置）

两个按钮**共用同一个 `IconAction` 实现**，避免各长一样：28×28 方形、
16px 图标槽、`label-secondary` → hover `label-primary` + 浅底、无文字
（标签只走 `title` / `aria-label`）。

### 3.6 官方组件参考（已核实，但本插件不再依赖）

| 组件 | 关键 props |
|---|---|
| `Menu` | `open`(受控) / `anchor` / `items:[{id,label}]` / `selectedId` / `selection:'check'` / `onSelect(id)` / `onClose` / `portal` / `align` |
| `Button` | `variant:'ghost'\|'outline'\|'primary'\|'toolbar'` / `size:'sm'\|'md'` / `icon` / `title` |
| `Modal` | `open` / `onClose` / `title` / `closeLabel`（**本插件不用它**，见 3.3） |
| `Switch` | `checked` / `onChange(next)` / `disabled` / `label` / `title` |
| 图标 | `IconSettingsOutlineMedium`（16px，与侧边栏「通用设置」同一个）、`IconPlayOutlineRegular`、`IconChevronDownOutlineRegular` |

⚠️ `Menu` 的 `className` 落在 anchor 包装元素上；调用方给的布局类必须显式并进去，
否则官方路径下类会被丢掉（降级路径反而生效）。

## 4. 宿主 HTTP 契约（冻结）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-notify/state` | `{seq, kind, at, session, title, sound, muted, mode, settings, whale, outbox, diagnostics}` |
| GET | `/dsh-notify/settings.json` | `{ok:true, settings, whale, muted}` |
| PUT/POST | `/dsh-notify/settings.json` | 合并 patch → `{ok:true, settings}` |
| POST | `/dsh-notify/mute.json` | `{muted:boolean}` → `{ok:true, muted}` |
| GET | `/dsh-notify/sounds.json` | `{ok:true, builtin:[...], custom:[...]}` |
| POST | `/dsh-notify/audio` | `{name, mime, dataBase64}` → `{ok:true, sound}` |
| DELETE | `/dsh-notify/audio/<id>` | → `{ok:true}` |
| GET | `/dsh-notify/audio/<id>` | 音频字节（`Content-Type` 取自索引） |
| POST | `/dsh-notify/ping` | 自检：`?force=1` 绕过静音/智能判定强制响一次 |

**命中判定的唯一来源是 `state.sound`**：宿主在通知产生的那一刻算好「该不该响、响哪个」，
客户端只负责播。这样关/开/智能判断/静音的语义集中在一处，不会前后端各判一半。

## 5. 设置数据形状

```js
{
  mode: 'on' | 'off' | 'smart',        // 总模式；smart = 小鲸鱼没开这个事件的音时才响
  volume: 0.6,                          // 0..1
  muteWhenFocused: false,               // 前台且有焦点时不响
  events: {
    done:     { on: true, sound: 'default:done' },
    question: { on: true, sound: 'default:question' },
    approval: { on: true, sound: 'default:approval' },
    error:    { on: true, sound: 'default:error' },
  },
}
```

- `muted`（喇叭按钮）**不落盘**，只存在宿主内存里，重启即恢复——符合「临时关闭」。
- 设置落盘到 `$DSH_HOME/.dsh-notify-settings.json`。

## 6. 声音 id 命名

- `default:<kind>` —— 内置合成旋律（done/question/approval/error 四段，音高互不相同）
- `preset:<name>` —— 额外内置合成音：`chime`(叮咚) `bell`(铃) `soft`(柔和) `alert`(警示)
- `custom:<id>` —— 用户上传的音频文件
- `none` —— 静音

## 7. 智能判断（smart）语义

读小鲸鱼账本 `$DSH_HOME/.dshw-usage.json`（候选路径见 whale `USAGE_FILE_CANDIDATES`）：

- `done`     → 鲸鱼 `settings.taskEnd.on` 为 true 时，我**不响**（否则双响）
- `question` → 鲸鱼 `settings.events.question.soundOn` 为 true 时不响
- `approval` → 鲸鱼 `settings.events.approval.soundOn` 为 true 时不响
- `error`    → 鲸鱼不管错误音，始终由我响

鲸鱼未安装 / 文件不存在 → 视为「它不管」→ 我响。这正是用户要的
「智能判断（在小鲸鱼没开时响）」。

## 8. 验收标准

1. `node --test test/*.test.js` 全绿（含：设置读写、静音、smart 判定、自定义音索引、上传体积上限）
2. `pwsh -File scripts/verify-e2e.ps1` 在隔离实例上全绿，且新增断言：
   - boot graph (`window.__DSH_BOOT__`) 含 `dsh-notify-sound` 条目
   - `/plugins/dsh-notify-sound/client.js` 返回 200 且是 `__ModuleLoader__.load` 工厂
3. 设置页出现「声音提醒」行；三个事件可各自选音；模式可切换
4. 对话左下角出现喇叭按钮，点击即时静音/恢复，且跨标签页同步
