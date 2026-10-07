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
`@deepseek-ai/dsh-client-ui-primitives`。**本插件只 require `react`**（避免 primitives 版本差异）。

## 3. 两个 slot

### 3.1 `settings.general.item`（通用设置里的行）

```js
ctx.slots.inject('settings.general.item', () => ctx.slots.register({
  name: 'settings.general.item',
  id: 'dsh-notify-sound',      // 必填
  order: 12,                   // Language=0, Appearance=10, FontSize=11, ComposerEnter=20
  inject: () => ({ api })      // 额外 props，会合并进组件 props
}, SoundRow))
```

组件收到的 props：`inject()` 返回的对象 + slot 自己的 props。组件读 `props.api`。

### 3.2 `conversation.input.left`（对话输入框左下角）

```js
ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
  name: 'conversation.input.left',
  id: 'dsh-notify-sound-mute',
  order: 10,
  inject: () => ({ api })
}, MuteButton))
```

`kind: 'list'`、`scope: 'session'`，仅在真实会话中渲染（`sessionId === undefined` 时宿主不渲染该 slot）。

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
