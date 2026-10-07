# 上架说明（dsh-market 社区市场）

## 结论先说：两个市场，一个能上，一个不存在

| 市场 | 能否上架 | 依据 |
|---|---|---|
| **官方市场** | ❌ **不存在** | DeepSeek 官方仓库 CONTRIBUTING.md 明确写「目前不接受外部 PR」；官方 `publish.md` 教程只讲 `dsh plugin add`（本地路径 / npm / GitHub），**从未提到任何市场、注册表或投稿流程**；官方 bundle 列表 `packages/bundle/*` 只含内置包。我也在本机 `app.asar`（121MB）里字节搜索 `awesome-dsh-plugin` / `dshmarket` / `plugins.json` / `插件市场`，**全部 0 命中**。 |
| **社区市场 dshmarket** | ✅ **能上** | 开放 PR 到公开仓库，机械 CI + 维护者人工读一遍。无需付费、无账号门槛。 |

**所以「上架官方市场」这件事没有可执行路径**——不是被审核挡住，而是它根本不存在。官方给的唯一生态指引是给仓库打 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic。

## 社区市场的机制（已核实到源码）

- 市场数据来自 `https://awesome-dsh-plugin.com/plugins.json`（实测 5,303,604 字节 / 4414 条 / 更新于 2026-10-05）。
- **它不是 npm 自动发现**：npm 只提供下载量与版本列，且仅当已发布包的 `repository` 字段指回被收录的仓库时才建立映射。
- **安装有白名单闸门**：`dshmarket/src/routes.ts:5454` —— 不在目录里的 URL 直接 `400 plugin is not in the curated registry`。
- **投稿 = 往目录仓库提一个文件**，不是往市场仓库提：
  - 仓库：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
  - 文件：`data/plugins/<owner>__<repo>.yml`
  - 一个 PR 最多 3 条；README 由脚本生成，**不要手改**。

### 硬性要求（CI 会查，逐条）

1. `package.json` 声明 **`dsh.bundle`**（只声明 `dsh.client` 会被拒——这是最常见的被拒原因）。
   本插件两个都有：见 `package.json` 的 `dsh.bundle` 与 `dsh.client`。
2. 仓库有真实可用代码（非占位/纯 README）。
3. **仓库创建满 1 天**（自动检查，PR 前几分钟建的仓库会被拒）。
4. 给仓库打 `dsh-plugin` topic。
5. 描述必须**属实**，会对照代码核验。
6. 分类选最贴合的：本插件用 `notify`（Notifications & Integrations）。
7. `@deepseek-ai/*` 要声明成 `peerDependencies` 而不是 `dependencies`——本插件不直接依赖任何
   `@deepseek-ai/*` 包（宿主运行时提供），所以无需声明，也就避开了预发布版本的 ERESOLVE 陷阱。
8. 描述里含 `: `（冒号加空格）必须加引号，否则 YAML 解析失败。

## 我卡在哪：缺少你的账号凭据

以下动作**必须由你本人完成**，我无法代做（也没有伪造）：

| 步骤 | 状态 | 原因 |
|---|---|---|
| `git init` + 提交 | ✅ 已完成（本地仓库已建） | 本地操作 |
| 创建 GitHub 公开仓库 | ⛔ 待你操作 | 本机 `npm whoami` 未登录；无 `GITHUB_TOKEN`/`GH_TOKEN`；未安装 `gh` CLI；git 凭据是 Windows Credential Manager（需交互） |
| 推送到 GitHub | ⛔ 待你操作 | 同上 |
| 打 `dsh-plugin` topic | ⛔ 待你操作 | 需要 GitHub 网页或 API 凭据 |
| 发布 npm 包（可选） | ⛔ 待你操作 | npm 未登录（`npm error ENEEDAUTH`） |
| 向目录仓库提 PR | ⛔ 待你操作 | 需要 GitHub 凭据 |

**你可以直接把下面第 4 节那个 YAML 文件内容粘进去**，省掉手写。

## 需要你执行的步骤

```powershell
cd E:\download\app\news\dsh-notify-sound

# 1) 本地仓库已初始化并提交过；确认一下
git log --oneline -1

# 2) 在 GitHub 建一个公开仓库（网页建最省事，名字建议 dsh-notify-sound-plus）
#    然后把 <you> 换成你的 GitHub 用户名：
git remote add origin https://github.com/<you>/dsh-notify-sound-plus.git
git branch -M main
git push -u origin main

# 3) 给仓库加 dsh-plugin topic（网页 About → Topics，或 API）

# 4) 等仓库满 1 天（CI 自动检查）

# 5) 可选：发 npm（能省掉安装方的 allowBuilds 构建授权）
npm login
npm publish --access public

# 6) 向目录仓库提 PR：新增一个文件
#    data/plugins/<you>__dsh-notify-sound-plus.yml
#    内容见本文件第 4 节
```

## 4. 目录条目（把 `<you>` 换成你的 GitHub 用户名后提交）

```yaml
url: https://github.com/<you>/dsh-notify-sound-plus
name: <you>/dsh-notify-sound-plus
category: notify
description:
  en: 'Four synthesized notification sounds for DeepSeek Harness — turn-complete, question, approval and error — each independently configurable and auditionable from a General-settings row, with optional custom audio upload and a temporary mute button in the composer. Zero bundled audio assets: every tone is generated at runtime with the Web Audio API. Works on both the web GUI and the Electron desktop app.'
  zh: 'DSH 提示音插件：任务完成 / 需要回答 / 需要授权 / 出错四类事件各用一段 Web Audio 实时合成的旋律提醒，可在「通用设置」里逐个试听与选音、上传自定义音频，对话输入框左下角有临时静音喇叭；不随包分发任何音频文件；网页端与桌面端（Electron）均可用。'
```

> 注意：描述里我刻意写的是**可核验的具体功能**（四个事件、设置行、上传、喇叭、零音频文件、
> Web Audio、两端可用），没有形容词堆砌——目录的评审规则明确说「夸大是让一个本来不错的插件被打回的主要原因」。

## 5. 与已收录插件的区分（评审会查「是否已被覆盖」）

目录里已有 `ldchaowin/dsh-plugin-notify-sound`（category `voice`）以及约 40 条 `notify` 条目。
按规则「两者做同一件事时更好者收录」，本插件与它们的**实质差异**（都能在代码里核对）：

1. **UI 集成深度**：走官方 `settings.general.item` 与 `conversation.input.left` 两个 slot，
   设置与静音都长在原生界面上；不是只弹通知或只写配置文件。
2. **零音频素材**：所有声音由 Web Audio 振荡器实时合成，仓库里没有任何 `.mp3/.wav`。
3. **互斥逻辑（smart）**：读 `dsh-whale-widget` 的账本，它已在响的事件不重复响——这是
   解决「两个提示音插件同时装会双响」的机制，其它 notify 插件没有。
4. **官方客户端模块通道**：声明 `dsh.client` 由 `@deepseek-ai/dsh-client-modules` 自动提供
   `/plugins` 路由与 boot graph，不使用手工脚本注入。

## 6. 可选加分项：截图

市场详情页支持 App Store 式截图。在**你自己的仓库**里放 `screenshots.json`（与 `package.json` 同级）：

```json
[
  "assets/screenshot-settings.png",
  "assets/screenshot-mute.png"
]
```

放自己仓库的好处：以后换图只推自己的仓库，下次构建自动生效，不用再来提 PR。
路径不能跳出插件目录（不能以 `/` 开头、不能含 `..`）。
