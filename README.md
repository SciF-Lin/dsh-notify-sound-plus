# dsh-notify-sound-plus

DSH 提示音插件：**任务完成**、**需要我回答**、**需要我授权**、**出错**时发出提示音。
在「通用设置」里逐事件选音，在对话输入框左下角有一个**临时静音喇叭**。
兼容 **DeepSeek Harness 桌面端（Electron）** 与 **网页端**。

- 提示音全部由 **Web Audio 实时合成**，不随包分发任何音频文件（没有二进制素材、没有素材许可问题）。
- 四段默认旋律音高集合互不相同，闭眼也能分辨是哪个事件。
- 「智能判断」模式：**小鲸鱼挂件**已经在响的事件就不重复响，它没开的事件仍由本插件响。
- 默认**不打扰**：子代理跑完不响、用户自己按停（aborted）不响、刷新页面不补播历史。

> 包名是 `dsh-notify-sound-plus`：npm 上 `dsh-notify-sound` 已被他人占用。

## 界面

### 通用设置 → 「声音提醒」

| 控件 | 作用 |
|---|---|
| **开 / 关 / 智能** | 总模式。`智能` = 小鲸鱼负责的事件不重复响 |
| 四个事件行 | 每行一个开关 + 一个声音下拉 + 「试听」 |
| 音量 | 0–100%，带「看着屏幕时不响」选项 |
| 自定义 | 上传自己的音频（mp3/wav/ogg/m4a，单个 ≤ 2MB，最多 20 个） |

### 对话输入框左下角 → 喇叭按钮

点一下**临时关闭**提示音（图标变成带叉的喇叭），再点一下恢复。
临时静音只存在宿主内存里，**重启即恢复**，不会写进配置文件——所以不会在你不记得的时候一直静音。

## 四种事件与默认音

| 事件 | 触发时机 | 默认音型 |
|---|---|---|
| `done` | 一轮对话正常结束（`turn/end` 且 `reason.kind === 'completed'`） | 下行双音 E6 → A5 |
| `question` | 模型调用了 `ask_user_question`，正等你回答 | 上行三音 D6 → F#6 → A6 |
| `approval` | 出现授权请求（`approval/asked`） | 低音三连 A5 → A5 → E6 |
| `error` | 这一轮以错误结束（`turn/end` 且 `reason.kind === 'error'`） | 低沉下坠 G5 → C5 |

另有 4 个内置合成音可选：**叮咚 / 铃音 / 轻柔 / 警示**。

以下**不会**响（有意为之）：`aborted`（你自己按的停止）、`interrupted`、`forked`、
`blocked`、`max-tokens`，以及子代理（subagent）会话。

## 安装

```powershell
# 桌面端
dsh plugin --profile desktop add dsh-notify-sound-plus

# 网页端
dsh plugin --profile web add dsh-notify-sound-plus
```

本地开发用 `link:`：

```powershell
dsh plugin --profile web add link:E:\download\app\news\dsh-notify-sound
```

装完**需要重启对应的 DSH**：宿主路由与客户端 boot graph 都在启动时注册。

## 智能判断（smart）怎么工作

「智能」模式读小鲸鱼挂件的账本 `$DSH_HOME/.dshw-usage.json`，看它自己那几个音效开关：

| 事件 | 小鲸鱼那边看哪个开关 | 判定 |
|---|---|---|
| `done` | `settings.taskEnd.on` | 它为 true → 本插件不响（避免双响） |
| `question` | `settings.events.question.soundOn` | 同上 |
| `approval` | `settings.events.approval.soundOn` | 同上 |
| `error` | —（小鲸鱼不管错误音） | 始终由本插件响 |

小鲸鱼没装、或读不到它的设置 → 一律视为「它不管」→ **本插件响**。
这正是「在小鲸鱼没开时响」的语义：宁可响，也不要漏。

## 服务端口（宿主 API）

全部在 `/dsh-notify` 下，都不需要 token：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/dsh-notify/state` | 通知状态 + 诊断（`seq`/`sound`/`muted`/`mode`/`waiting`/`routeErrors`） |
| GET/POST | `/dsh-notify/settings.json` | 读 / 合并写设置 |
| GET/POST | `/dsh-notify/mute.json` | 读 / 切换临时静音（POST `{}` 切换，`{muted:true}` 显式设置） |
| GET | `/dsh-notify/sounds.json` | 内置 + 自定义音效目录 |
| POST | `/dsh-notify/audio` | 上传自定义音频（base64） |
| GET/DELETE | `/dsh-notify/audio/<id>` | 取音频字节 / 删除 |
| POST | `/dsh-notify/ping` | 自检；`?force=1` 绕过静音/模式，`?kind=` 选事件 |

**判定只在宿主做一次**：宿主在通知产生的那一刻就把「该不该响、响哪个」算进
`state.sound`，客户端只负责播。所以关/开/智能/静音/小鲸鱼互斥的语义不会前后端各判一半。

```powershell
# 不用真跑一轮对话就能验证出声链路
Invoke-RestMethod http://127.0.0.1:19387/dsh-notify/ping -Method POST
Invoke-RestMethod http://127.0.0.1:19387/dsh-notify/state
```

页面里也有调试入口：

```js
__DSH_NOTIFY__.state                        // 当前状态
__DSH_NOTIFY__.play('preset:bell')          // 试听
__DSH_NOTIFY__.mute(true)                   // 临时静音
```

## 排障

完全没声音时，按顺序查：

1. `GET /dsh-notify/state` 通不通 → 不通说明宿主半区没挂上（重启 DSH）。
2. 首页 HTML 里有没有 `__DSH_BOOT__` 且含本包名 → 没有说明客户端模块没被组合（检查
   `package.json` 的 `dsh.client` 与 `exports["./client"]`）。
3. `__DSH_NOTIFY__.play('default:done')` → 有声说明音频链路正常，是事件没触发。
4. `__DSH_NOTIFY__.state.settings.mode` 与 `muted` 是不是被关掉了。

浏览器/Electron 的**自动播放策略**：页面在第一次点击或按键之前不允许出声。
插件会在第一次真实手势时自动解锁，并把被挡下的那一次补播出来。

## 实现要点

- **客户端 UI 走官方模块通道**：`package.json` 声明 `dsh.client` 与 `exports["./client"]`，
  由 `@deepseek-ai/dsh-client-modules` 自动扫描、自动提供 `/plugins` 路由并把 boot graph
  注入页面。插件**不需要**自己注册脚本路由，桌面端也因此自动兼容。
- 两个 slot：`settings.general.item`（通用设置行）、`conversation.input.left`（输入框左下角）。
- `client/client.js` 是**手写 CJS**（`window.__ModuleLoader__.load({id, factory})`），
  只 `require('react')`，不引入打包器——平台种子表里的模块才可解析。

## 测试

```powershell
# 单元测试
node --test test/host.test.js test/client-contract.test.js

# 端到端：全新 DSH_HOME 起隔离实例，装本插件，真的请求宿主路由、
# 官方 /plugins bundle，并抓首页确认 boot graph，跑完自动清理
pwsh -File scripts/verify-e2e.ps1
```

## 结构

```
dsh-notify-sound/
├── lib/index.js              宿主半区：事件判定 → sound；设置/静音/自定义音频 API
├── client/client.js          客户端半区：设置行 + 喇叭按钮 + Web Audio 播放
├── cordis.patch.yml          bundle 挂载声明
├── CONTRACT.md               实现契约（slot / HTTP / 设置形状）
├── test/                     单元测试
└── scripts/verify-e2e.ps1    隔离实例端到端验证
```

## 许可

MIT
