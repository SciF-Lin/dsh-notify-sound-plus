/*!
 * dsh-notify-sound-plus — 客户端半区（Client half）
 *
 * 由 @deepseek-ai/dsh-client-modules 自动扫描 package.json 的 dsh.client 声明，
 * 经 /plugins 路由下发到页面，作为 __ModuleLoader__ 工厂执行。**手写 CJS**，
 * 不引入打包器：外部依赖只有平台种子表里的 react 与官方 ui-primitives。
 *
 * 职责（严格只做这三件事）：
 *   ① UI：在「通用设置」放一行摘要 + 齿轮按钮（齿轮打开官方 Modal 承载完整设置）；
 *      在对话输入框左下角放一个喇叭按钮。
 *   ② 出声：轮询 /dsh-notify/state，宿主说该提示（sound != 'none'）就播那个声音。
 *   ③ 系统通知：宿主说 notify=true 时弹一条系统通知（桌面通知中心/浏览器通知）。
 *
 * 「该不该提示」的判定**全在宿主**（见 lib/index.js 的 resolveSound/resolveNotify）；
 * 这里不做任何模式/静音/小鲸鱼判断，避免前后端各判一半导致行为不一致。
 *
 * ⚠️ 官方 ui-primitives 是**可选**依赖：整个包必须能在缺它时降级运行
 *    （自绘控件），否则一旦宿主版本不同就会整块 UI 白掉。见 PRIMITIVES 探测。
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
    var REPO_URL = 'https://github.com/SciF-Lin/dsh-notify-sound-plus'

    // ============================================== 官方图标（路径内联，零依赖）
    // 为什么内联而不是 require 官方 ui-primitives 的图标组件：
    // 一是 primitives 在真实宿主里并不总能解析到（拿不到就只能画个文字符号，
    // 齿轮变成 ⚙ 字形，和官方完全不是一回事）；二是即便拿得到，图标组件的
    // 解析结果也会随宿主版本漂移。直接内联官方 artwork 的 path，任何宿主、
    // 任何版本画出来都完全一致。
    //
    // 数据来源：@deepseek-ai/dsh-client-ui-primitives 的 *OutlineArtwork
    //   · viewBox 一律 "0 0 16 16"，path 只带 stroke="currentColor"
    //   · 笔画宽度：Regular = 1，Medium = ICON_MEDIUM_STROKE = 1.3
    var ICON_PATHS = {
      // IconSettingsOutlineArtwork（齿轮；Medium 1.3px，与侧边栏「通用设置」同一个）
      settings: [
        { d: 'M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z' },
        { d: 'M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z', miterlimit: 10 },
      ],
      // IconPlayOutlineArtwork（试听）
      play: [
        { d: 'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z' },
        { d: 'M10.3329 7.91346C10.3996 7.95195 10.3996 8.04818 10.3329 8.08667L6.78304 10.1362C6.71638 10.1747 6.63304 10.1266 6.63304 10.0496L6.63304 5.95055C6.63304 5.87357 6.71638 5.82546 6.78304 5.86395L10.3329 7.91346Z' },
      ],
      // IconChevronDownOutlineArtwork（下拉箭头）
      chevronDown: [
        { d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6' },
      ],
      // IconCloseOutlineArtwork（关闭）
      close: [
        { d: 'M2.5 2.5L13.5 13.5' },
        { d: 'M13.5 2.5L2.5 13.5' },
      ],
      // IconCheckOutlineArtwork（下拉里选中项右侧的勾）
      check: [
        { d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4' },
      ],
    }
    var ICON_MEDIUM_STROKE = 1.3

    /** 渲染一个官方轮廓图标。size 默认 16（官方 artwork 的原生尺寸）。 */
    function SvgIcon(props) {
      var paths = ICON_PATHS[props.name] || []
      var size = props.size || 16
      var kids = []
      for (var i = 0; i < paths.length; i++) {
        kids.push(h('path', {
          key: i,
          d: paths[i].d,
          stroke: 'currentColor',
          strokeMiterlimit: paths[i].miterlimit,
        }))
      }
      return h('svg', {
        className: props.className,
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        focusable: 'false',
        strokeWidth: props.strokeWidth || ICON_MEDIUM_STROKE,
      }, kids)
    }

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
      { kind: 'question', label: '需要回答' },
      { kind: 'approval', label: '需要授权' },
      { kind: 'error', label: '运行出错' },
    ]

    // ================================================================ 样式
    var CSS = [
      '.dshns-row{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0;display:flex;flex-direction:column;gap:10px}',
      '.dshns-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshns-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;flex:1;min-width:120px}',
      '.dshns-mode{flex:none}',
      '.dshns-btn{border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}',
      '.dshns-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshns-btn:disabled{opacity:.5;cursor:default}',
      // —— 下拉：外观逐条对齐官方 Menu.module.css ——
      '.dshns-dd{position:relative;display:inline-flex;flex:none}',
      '.dshns-ddTrigger{display:inline-flex;align-items:center;justify-content:space-between;gap:6px;min-width:112px;height:28px;padding:0 6px 0 10px;border:none;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}',
      '.dshns-ddTrigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshns-ddTrigger:disabled{opacity:.4;cursor:not-allowed}',
      '.dshns-ddLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}',
      '.dshns-ddCard{box-sizing:border-box;position:absolute;top:calc(100% + 4px);right:0;z-index:100;display:flex;flex-direction:column;padding:4px;min-width:144px;max-width:360px;border-radius:var(--dsw-radius-lg);background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      '.dshns-ddItem{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}',
      '.dshns-ddItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshns-ddItemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshns-ddCheck{flex:none;color:var(--dsw-alias-label-primary)}',
      // —— 开关：尺寸与配色照抄官方 Switch.module.css ——
      '.dshns-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}',
      '.dshns-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.dshns-switch:disabled{cursor:default;opacity:.5}',
      '.dshns-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.dshns-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}',
      '.dshns-switch[aria-checked="false"] .dshns-thumb{background:var(--dsw-alias-switch-thumb)}',
      '.dshns-switch[aria-checked="true"] .dshns-thumb{transform:translateX(16px)}',
      '.dshns-chk{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;flex:none}',
      '.dshns-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      // 图标动作按钮（播放 / 齿轮）：28×28 方形，安静色，hover 转主色 + 浅底
      '.dshns-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;flex:none;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dshns-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshns-iconbtn:disabled{opacity:.4;cursor:not-allowed}',
      '.dshns-vol{display:flex;align-items:center;gap:10px}',
      '.dshns-vol>input{flex:1;max-width:240px}',
      '.dshns-range{flex:1;max-width:200px}',
      '.dshns-volv{color:var(--dsw-alias-label-secondary);font-size:12px;width:36px;text-align:right;flex:none}',
      '.dshns-customs{display:flex;flex-direction:column;gap:4px}',
      '.dshns-custom{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dshns-customname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}',
      '.dshns-x{border:none;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:12px;cursor:pointer;padding:2px 6px}',
      '.dshns-msg{font-size:12px;color:var(--dsw-alias-state-warn-primary)}',
      // 独立设置界面：尺寸与样式**逐条对齐官方设置面板**
      // （见 ui-settings-general 的 .panel / .overlay / .mask：
      //   overlay fixed inset 0 + z-index 1000 + 居中 + 24px 边距；
      //   panel 800×800（高度随视口收缩）、radius-panel、bg-layer-2、elevation-prominent）
      '.dshns-panel{display:flex;flex-direction:column;gap:0;width:100%}',
      // 分组标题：与官方设置页一致的弱化小标题
      '.dshns-pSection{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;letter-spacing:.02em;margin:18px 0 2px}',
      '.dshns-pSection:first-child{margin-top:2px}',
      '.dshns-pGroup{display:flex;flex-direction:column}',
      // Setting-Cell：左标题(+说明) / 右控件 / 行间发丝线
      // （尺寸照抄官方 ui-settings-general 与 locale 的 LanguageRow）
      '.dshns-srow{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshns-srow:last-child{border-bottom:none}',
      '.dshns-srowText{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}',
      '.dshns-srowTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:400}',
      '.dshns-srowDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dshns-srowCtl{display:flex;align-items:center;gap:8px;flex:none}',
      '.dshns-overlay{position:fixed;inset:0;z-index:1001;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}',
      '.dshns-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}',
      '.dshns-sheet{position:relative;z-index:1;box-sizing:border-box;display:flex;flex-direction:column;width:600px;max-width:calc(100vw - 48px);height:min(800px,calc(100vh - 2 * max(24px,var(--dsh-frame-overlay-top,24px))));border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);overflow:hidden}',
      '.dshns-sheetHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px;flex:none}',
      '.dshns-sheetTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;line-height:24px;font-weight:500}',
      '.dshns-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit}',
      '.dshns-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshns-sheetBody{flex:1;min-height:0;overflow:auto;padding:0 24px 24px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      // 页脚：常驻在滚动区之外，顶部一条发丝线跟上方的设置行区分开
      '.dshns-sheetFoot{flex:none;padding:12px 24px 14px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dshns-repo{display:flex;flex-direction:column;gap:2px}',
      '.dshns-repoLink{color:var(--dsw-alias-brand-primary);font-size:12px;line-height:18px;text-decoration:none}',
      '.dshns-repoLink:hover{text-decoration:underline}',
      '.dshns-repoUrl{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
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
        lastTitle: '',
        lastSession: '',
        notifyPermission: 'default',
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

      // ------------------------------------------------------- 系统通知
      /** 当前环境是否支持系统通知。 */
      function notificationsSupported() {
        try { return typeof window.Notification === 'function' } catch (err) { return false }
      }

      function permission() {
        try { return notificationsSupported() ? String(window.Notification.permission || 'default') : 'unsupported' } catch (err) { return 'unsupported' }
      }

      /** 请求通知权限（必须在用户手势里调用，否则浏览器直接拒绝）。 */
      function requestPermission() {
        if (!notificationsSupported()) return Promise.resolve('unsupported')
        try {
          var r = window.Notification.requestPermission()
          if (r && typeof r.then === 'function') {
            return r.then(function (v) { emit(); return v }, function () { emit(); return permission() })
          }
        } catch (err) {}
        emit()
        return Promise.resolve(permission())
      }

      var NOTIFY_TEXT = {
        done: { title: '任务完成', body: '本轮任务已完成' },
        question: { title: '需要你回答', body: '正在等待你的回答' },
        approval: { title: '需要你授权', body: '正在等待你的授权' },
        error: { title: '运行出错', body: '本轮以错误结束' },
      }

      /**
       * 弹一条系统通知。
       * 权限没给就静默跳过（不反复弹权限框骚扰用户）。
       * @param {'done'|'question'|'approval'|'error'} kind
       * @param {boolean} force 试听用：绕过权限检查之外的开关（权限仍必须已授予）
       */
      function notifySystem(kind, force) {
        if (!notificationsSupported()) return false
        if (permission() !== 'granted') return false
        var meta = NOTIFY_TEXT[kind] || NOTIFY_TEXT.done
        try {
          var title = meta.title
          var body = meta.body
          // 带上会话名，多个会话同时跑时能分清是哪一个
          var st = state.settings
          if (state.lastTitle) body = state.lastTitle + ' · ' + body
          var n = new window.Notification(title, {
            body: body,
            tag: PLUGIN_ID + ':' + kind + ':' + (state.lastSession || ''),
            silent: false,
          })
          try {
            n.onclick = function () {
              try { window.focus() } catch (err) {}
              try { n.close() } catch (err) {}
            }
          } catch (err) {}
          // 系统通知有时限，几秒后自己收掉，避免堆积
          if (force) {
            try { window.setTimeout(function () { try { n.close() } catch (err) {} }, 4000) } catch (err) {}
          }
          return true
        } catch (err) {
          return false
        }
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
          // 记下会话信息，系统通知里带上它好分辨是哪个会话
          if (st.title) state.lastTitle = String(st.title)
          if (st.session) state.lastSession = String(st.session)
          if (st.kind) state.lastKind = String(st.kind)
          // 宿主已经把「该不该提示」判好了，这里只认 sound / notify
          if (st.sound && st.sound !== 'none') play(st.sound)
          if (st.notify === true && st.kind) notifySystem(st.kind, false)
        }).then(null, function () {})
      }

      function start() {
        refreshSettings().then(refreshSounds).then(function () {
          if (disposed) return
          set({ notifyPermission: permission() })
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
        notifySystem: notifySystem,
        requestPermission: requestPermission,
        notificationsSupported: notificationsSupported,
        permission: permission,
      }
    }

    function mergeSettings(base, patch) {
      var out = {
        mode: base && base.mode ? base.mode : 'on',
        volume: base && typeof base.volume === 'number' ? base.volume : 0.6,
        muteWhenFocused: !!(base && base.muteWhenFocused),
        events: {},
        system: { enabled: !!(base && base.system && base.system.enabled), events: {} },
      }
      var kinds = ['done', 'question', 'approval', 'error']
      for (var i = 0; i < kinds.length; i++) {
        var k = kinds[i]
        var b = base && base.events && base.events[k] ? base.events[k] : {}
        out.events[k] = { on: b.on !== false, sound: b.sound || ('default:' + k) }
        var sb = base && base.system && base.system.events ? base.system.events[k] : undefined
        // 默认与宿主 defaultSettings 保持一致：
        // 需要你回答 / 需要你授权 / 任务完成 三类弹，error 不弹
        out.system.events[k] = typeof sb === 'boolean' ? sb : (k !== 'error')
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
      if (patch.system && typeof patch.system === 'object') {
        if (typeof patch.system.enabled === 'boolean') out.system.enabled = patch.system.enabled
        if (patch.system.events && typeof patch.system.events === 'object') {
          for (var s = 0; s < kinds.length; s++) {
            var sk = kinds[s]
            if (typeof patch.system.events[sk] === 'boolean') out.system.events[sk] = patch.system.events[sk]
          }
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

    // 事件元数据与模式选项提到模块作用域：两个组件（摘要行 / 设置面板）共用。
    var MODE_OPTIONS = [
      { id: 'on', label: '开启提醒', hint: '所有事件均提醒' },
      { id: 'off', label: '关闭提醒', hint: '所有事件均不提醒' },
      { id: 'smart', label: '智能判断', hint: '与小鲸鱼挂件协助提醒（未开启事件由本插件提醒）' },
    ]

    function modeLabelOf(mode) {
      for (var i = 0; i < MODE_OPTIONS.length; i++) {
        if (MODE_OPTIONS[i].id === mode) return MODE_OPTIONS[i].label
      }
      return MODE_OPTIONS[0].label
    }
    function modeHintOf(mode) {
      for (var i = 0; i < MODE_OPTIONS.length; i++) {
        if (MODE_OPTIONS[i].id === mode) return MODE_OPTIONS[i].hint
      }
      return MODE_OPTIONS[0].hint
    }

    // ============================================ 官方风格下拉（自绘，零依赖）
    /**
     * 单选下拉。外观**逐条对齐**官方 Menu（`Menu.module.css`）：
     *   · 触发器：药丸按钮（同官方 Pill 的尺寸观感）
     *   · 卡片：padding 4px、radius-lg、prominent 立体阴影、菜单材质底色
     *   · 选项行：min-height 34px / padding 6px 8px / radius-md / 13px 文字
     *   · hover 用 interactive-bg-hover；**选中项不打底色，而是在右侧打勾**
     *     （官方 `.selected{background:transparent}` + 尾部 check 就是这么设计的）
     *
     * 之前这里在拿不到官方组件时退回原生 <select>，弹层是操作系统的蓝色高亮列表，
     * 和官方完全是两种东西 —— 现在改成自绘，任何宿主下都是同一个样子。
     *
     * @param props.items     [{ id, label }]
     * @param props.value     当前选中 id
     * @param props.onChange  (id) => void
     */
    function Dropdown(props) {
      var openPair = React.useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var rootRef = React.useRef(null)
      var items = props.items || []
      var current = null
      for (var i = 0; i < items.length; i++) if (items[i].id === props.value) current = items[i]

      // 展开期间才挂全局监听：点外面收起
      React.useEffect(function () {
        if (!open) return undefined
        function onDown(e) {
          var el = rootRef.current
          var t = e && e.target
          if (el && t && el.contains && el.contains(t)) return
          setOpen(false)
        }
        try { document.addEventListener('mousedown', onDown) } catch (err) {}
        return function () {
          try { document.removeEventListener('mousedown', onDown) } catch (err) {}
        }
      }, [open])

      var rows = []
      for (var j = 0; j < items.length; j++) {
        rows.push(h('button', {
          key: items[j].id,
          className: 'dshns-ddItem',
          type: 'button',
          role: 'option',
          'aria-selected': items[j].id === props.value ? 'true' : 'false',
          onClick: (function (id) {
            return function () {
              setOpen(false)
              if (id !== props.value) props.onChange(id)
            }
          })(items[j].id),
        },
          h('span', { className: 'dshns-ddItemLabel' }, items[j].label),
          items[j].id === props.value ? h(SvgIcon, { name: 'check', size: 14, className: 'dshns-ddCheck' }) : null,
        ))
      }

      return h('div', {
        className: 'dshns-dd' + (props.className ? ' ' + props.className : ''),
        ref: rootRef,
        // Esc 只收起这一层：stopPropagation 挡住冒泡，设置弹窗那层就不会跟着关。
        // 官方 Menu 也是「只有最上层响应 Esc」的语义（靠 modal layer 栈）。
        onKeyDown: function (e) {
          if (e && e.key === 'Escape' && open) {
            try { e.stopPropagation() } catch (err) {}
            try { e.preventDefault() } catch (err) {}
            setOpen(false)
          }
        },
      },
        h('button', {
          className: 'dshns-ddTrigger',
          type: 'button',
          disabled: !!props.disabled,
          title: props.title,
          'aria-haspopup': 'listbox',
          'aria-expanded': open ? 'true' : 'false',
          onClick: function () { setOpen(!open) },
        },
          h('span', { className: 'dshns-ddLabel' }, current ? current.label : (props.placeholder || '请选择')),
          h(SvgIcon, { name: 'chevronDown', size: 14, strokeWidth: 1.3 }),
        ),
        open ? h('div', { className: 'dshns-ddCard', role: 'listbox' }, rows) : null,
      )
    }

    /**
     * 图标动作按钮（无文字）—— 播放与齿轮共用同一个实现。
     *
     * 规格统一，避免两个按钮长得不一样：28×28 方形、28px 高度、16px 图标槽、
     * 常规色 label-secondary、hover 转 label-primary + 浅底（同官方 Modal 关闭键）。
     */
    function IconAction(props) {
      return h('button', {
        className: 'dshns-iconbtn',
        type: 'button',
        title: props.title,
        'aria-label': props.title,
        onClick: props.onClick,
      }, h(SvgIcon, { name: props.icon, size: 16, strokeWidth: ICON_MEDIUM_STROKE }))
    }

    /** 试听按钮：与齿轮同规格的图标动作。 */
    function PreviewButton(props) {
      return h(IconAction, {
        title: props.title || '试听',
        icon: 'play',
        onClick: props.onClick,
      })
    }

    /**
     * 齿轮按钮：打开独立设置界面。
     * 用官方 IconSettingsOutline 的 Medium 笔画（1.3px）——就是侧边栏
     * 「通用设置」那一行用的同一个图标，两处外观完全一致。
     */
    function GearButton(props) {
      return h(IconAction, {
        title: props.title || '设置',
        icon: 'settings',
        onClick: props.onClick,
      })
    }

    /**
     * 开关。自绘并**照抄官方 Switch 的规格**（`Switch.module.css`）：
     * 36×20 胶囊轨道、2px 内边距、16×16 圆形滑块、选中 16px 位移；
     * 关 = border-l3 底 + switch-thumb 滑块，开 = brand-primary 底 + 白滑块。
     * 用 `role="switch"` + `aria-checked`，和官方一样让语义与视觉来自同一个状态。
     */
    function Toggle(props) {
      return h('button', {
        className: 'dshns-switch',
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        disabled: !!props.disabled,
        title: props.title,
        'aria-label': props.label || props.title || '开关',
        onClick: function () { props.onChange(!props.checked) },
      }, h('span', { className: 'dshns-thumb' }))
    }

    /**
     * 一行设置（官方 Setting-Cell 模式）：左边标题 + 可选说明，右边控件，行间发丝线。
     * 与「通用设置」里「权限 / 语言 / 字号大小」那些行同构 —— 界面统一性的关键。
     */
    function SettingRow(props) {
      return h('div', { className: 'dshns-srow' },
        h('div', { className: 'dshns-srowText' },
          h('div', { className: 'dshns-srowTitle' }, props.title),
          props.desc ? h('div', { className: 'dshns-srowDesc' }, props.desc) : null,
        ),
        h('div', { className: 'dshns-srowCtl' }, props.children),
      )
    }

    /**
     * 承载独立设置界面的容器。
     *
     * 为什么不用官方 primitives 的 `Modal`：它是 **380px 窄卡片**
     * （`.dialog{width:min(380px,100%)}`），而设置类界面在 DSH 里用的是
     * 800×800 的面板（见 ui-settings-general 的 `.panel`）。两者宽高比完全不同，
     * 塞进去既不像官方、内容也会被压扁。
     *
     * 所以这里自绘 overlay + sheet，但**尺寸与视觉 token 逐条照抄官方设置面板**，
     * 外观与「通用设置」那个窗口一致；关闭由我们自己接管（点 X / 点遮罩 / Esc 都能关），
     * 不依赖嵌套弹层的内部行为。
     */
    function Panel(props) {
      // Esc 关闭：只在打开期间挂 document 监听，卸载即摘掉
      React.useEffect(function () {
        function onKey(e) {
          if (e && e.key === 'Escape' && !e.shiftKey) {
            try { e.preventDefault() } catch (err) {}
            props.onClose()
          }
        }
        try { document.addEventListener('keydown', onKey) } catch (err) {}
        return function () {
          try { document.removeEventListener('keydown', onKey) } catch (err) {}
        }
      }, [])

      return h('div', { className: 'dshns-overlay', role: 'presentation' },
        h('div', {
          className: 'dshns-mask',
          'aria-hidden': 'true',
          onClick: function () { props.onClose() },
        }),
        h('div', {
          className: 'dshns-sheet',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': props.title,
        },
          h('div', { className: 'dshns-sheetHead' },
            h('h2', { className: 'dshns-sheetTitle' }, props.title),
            h('button', {
              className: 'dshns-close',
              type: 'button',
              'aria-label': '关闭',
              title: '关闭',
              onClick: function () { props.onClose() },
            }, h(SvgIcon, { name: 'close', size: 16 })),
          ),
          h('div', { className: 'dshns-sheetBody' }, props.children),
          props.footer ? h('div', { className: 'dshns-sheetFoot' }, props.footer) : null,
        ),
      )
    }

    // ================================================== 独立设置界面（齿轮打开）
    function SettingsPanel(props) {
      var rt = props.rt
      var s = rt.state
      var settings = s.settings
      var fileRef = React.useRef(null)
      var msgPair = React.useState('')
      var msg = msgPair[0]
      var setMsg = msgPair[1]
      if (!settings) return null

      var sys = settings.system || { enabled: false, events: {} }

      function setEvent(kind, patch) {
        var ev = {}
        ev[kind] = patch
        rt.saveSettings({ events: ev })
      }

      // 声音候选：内置 + 自定义
      var options = []
      for (var i = 0; i < s.sounds.builtin.length; i++) {
        options.push({ id: s.sounds.builtin[i].id, label: s.sounds.builtin[i].name })
      }
      for (var j = 0; j < s.sounds.custom.length; j++) {
        options.push({ id: s.sounds.custom[j].id, label: '自定义 · ' + s.sounds.custom[j].name })
      }
      function valueOf(kind) {
        var cur = settings.events[kind].sound
        for (var k = 0; k < options.length; k++) if (options[k].id === cur) return cur
        // 选中的自定义音已被删除 → 回落默认，避免下拉显示空白
        return 'default:' + kind
      }

      var perm = s.notifyPermission || 'default'
      var permText = perm === 'granted' ? '已开启'
        : perm === 'denied' ? '已拒绝，需在系统设置中恢复'
          : perm === 'unsupported' ? '当前环境不支持'
            : '未开启'

      var eventRows = EVENT_META.map(function (meta) {
        var ev = settings.events[meta.kind]
        return h(SettingRow, { key: meta.kind, title: meta.label },
          h(Toggle, {
            checked: ev.on !== false,
            disabled: settings.mode === 'off',
            label: meta.label,
            title: settings.mode === 'off' ? '模式为「关闭提醒」时不可单独开启' : '是否提醒',
            onChange: function (v) { setEvent(meta.kind, { on: v }) },
          }),
          h(Dropdown, {
            items: options,
            value: valueOf(meta.kind),
            disabled: settings.mode === 'off' || ev.on === false,
            title: '选择声音',
            align: 'end',
            onChange: function (id) {
              setEvent(meta.kind, { sound: id })
              // 换完立刻试听，不用再去点播放按钮确认选对了
              rt.play(id, { force: true })
            },
          }),
          h(PreviewButton, {
            title: '试听',
            onClick: function () { rt.play(valueOf(meta.kind), { force: true }) },
          }),
        )
      })

      // 系统通知只保留总开关（按需简化）：哪些事件弹由宿主默认值决定，
      // 不在界面上再暴露逐事件开关。
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

      var footer = h('div', { className: 'dshns-repo' },
        h('a', {
          className: 'dshns-repoLink',
          href: REPO_URL,
          target: '_blank',
          rel: 'noreferrer noopener',
          title: REPO_URL,
        }, '欢迎访问GitHub仓库送上star与issue！'),
        h('span', { className: 'dshns-repoUrl' }, 'github.com/SciF-Lin/dsh-notify-sound-plus'),
      )

      // 注意：模式不在这里 —— 它已经在「通用设置」那一行（二级页面）上显示了，
      // 弹窗里重复一份只会让人怀疑两处会不会不同步。
      return h(Panel, { title: '声音提醒设置', onClose: props.onClose, footer: footer },
        h('div', { className: 'dshns-panel' },
          // —— 提醒 ——
          h('div', { className: 'dshns-pSection' }, '提醒'),
          h('div', { className: 'dshns-pGroup' }, eventRows),
          h('div', { className: 'dshns-pGroup' },
            h(SettingRow, { title: '音量' },
              h('input', {
                className: 'dshns-range',
                type: 'range', min: 0, max: 1, step: 0.05,
                value: settings.volume,
                title: '音量',
                onChange: function (e) { rt.saveSettings({ volume: Number(e.target.value) }) },
              }),
              h('span', { className: 'dshns-volv' }, Math.round(settings.volume * 100) + '%'),
            ),
            h(SettingRow, {
              title: '前台运行时不提醒',
              desc: '仅在后台运行时提醒',
            },
              h(Toggle, {
                checked: !!settings.muteWhenFocused,
                label: '前台运行时不提醒',
                title: '仅在后台运行时提醒',
                onChange: function (v) { rt.saveSettings({ muteWhenFocused: v }) },
              }),
            ),
          ),

          // —— 系统通知 ——（只保留总开关）
          h('div', { className: 'dshns-pSection' }, '系统通知'),
          h('div', { className: 'dshns-pGroup' },
            h(SettingRow, {
              title: '系统通知',
              desc: '需要回答 / 授权 / 任务完成时 系统通知 · 权限：' + permText,
            },
              h(Toggle, {
                checked: !!sys.enabled,
                label: '系统通知',
                title: '通过系统通知提醒',
                onChange: function (v) {
                  rt.saveSettings({ system: { enabled: v } })
                  // 打开总开关时顺手申请权限（必须在用户手势里发起）
                  if (v && perm !== 'granted') {
                    rt.requestPermission().then(function (r) {
                      setMsg(r === 'granted' ? '已开启通知权限' : '未获得通知权限，系统通知将无法使用')
                    })
                  }
                },
              }),
            ),
          ),

          // —— 自定义音频 ——
          h('div', { className: 'dshns-pSection' }, '自定义音频'),
          h('div', { className: 'dshns-pGroup' },
            h(SettingRow, {
              title: '上传音频',
              desc: 'mp3 / wav / ogg / m4a，单个 ≤ 2MB',
            },
              h('button', {
                className: 'dshns-btn',
                type: 'button',
                onClick: function () { if (fileRef.current) fileRef.current.click() },
              }, '选择文件'),
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
                    setMsg(sound ? '已添加「' + sound.name + '」，可在上方声音列表中选择' : '已添加')
                  }).then(null, function (err) {
                    setMsg('上传失败：' + (err && err.message ? err.message : err))
                  })
                  e.target.value = ''
                },
              }),
            ),
            customLines.length
              ? h(SettingRow, { title: '已上传', desc: '删除后，使用该项的事件将回落到默认声音' },
                h('div', { className: 'dshns-customs' }, customLines))
              : null,
          ),

          (msg || s.error) ? h('div', { className: 'dshns-msg' }, msg || s.error) : null,
        ),
      )
    }

    // ================================== 通用设置里的摘要行（模式 + 试听 + 齿轮）
    function SoundRow() {
      var rt = useRuntime()
      var openPair = React.useState(false)
      var panelOpen = openPair[0]
      var setPanelOpen = openPair[1]
      if (!rt) return null
      var s = rt.state
      var settings = s.settings

      if (!settings) {
        return h('div', { className: 'dshns-row' },
          h('div', { className: 'dshns-title' }, '声音提醒'),
          h('div', { className: 'dshns-hint' }, s.error || '正在读取设置…'),
        )
      }

      var doneSound = settings.events.done.sound

      return h('div', { className: 'dshns-row' },
        h('div', { className: 'dshns-head' },
          h('div', { className: 'dshns-title' }, '声音提醒'),
          h(Dropdown, {
            items: MODE_OPTIONS.map(function (m) { return { id: m.id, label: m.label } }),
            value: settings.mode,
            className: 'dshns-mode',
            title: modeHintOf(settings.mode),
            align: 'end',
            onChange: function (m) { rt.saveSettings({ mode: m }) },
          }),
          h(PreviewButton, {
            title: '试听',
            onClick: function () { rt.play(doneSound, { force: true }) },
          }),
          h(GearButton, {
            title: '声音提醒设置',
            onClick: function () { setPanelOpen(true) },
          }),
        ),
        h('div', { className: 'dshns-hint' }, modeHintOf(settings.mode)),
        panelOpen ? h(SettingsPanel, { rt: rt, onClose: function () { setPanelOpen(false) } }) : null,
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
