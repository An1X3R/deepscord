# Deepscord 界面方案开发指南

核对日期为 2026-11-12。本文独立说明当前接口，不需要聊天上下文。源码路径均从含 package.json 的仓库根目录算起。

## 本地服务器选择页

启动工作区和创建、加入服务器窗口会在显示前读取本机保存的界面方案、参数及 CSS。基础方案沿用 `interface.css` 的配色，开放主题加载保存的 `presentation.css`，同时设置 `data-interface-package="true"`。方案参数仍通过 `--scheme-*` 生效。

CSS 可用 `:root[data-interface-surface="workspace"]` 定位服务器选择页，用 `:root[data-interface-surface="connections"]` 定位创建与加入窗口。主要容器为 `.workspace`、`.workspace-rail`、`.workspace-sidebar`、`.workspace-main` 和 `.connection-panel`。这些页面的按钮、表单和状态提示使用主题的 `--bg-*`、`--text-*`、`--accent*`、`--line*`、`--radius` 变量。房间内的 HTML 布局与隔离 JavaScript 接口继续在房间界面运行。修改主题后在自定义设置中重新选择并保存，即可更新本机保存的方案快照。

## 安装、更新与随软件保存

**只改源码里的 HTML 不会更新已经安装的主题。** 在“资源管理（主题与表情）”选择“安装 ZIP 包”或“安装文件夹”，一次导入完整资源包；使用者无需手动拆分和复制主题文件。资源包根目录必须有 `pack.json`，主题条目仍使用本文说明的方案清单及其引用的 HTML/CSS/JS。

共用包格式、目录、安全边界和限额见 [资源包协议](../RESOURCE_PACKS.md)。该协议随客户端放在 `mods/RESOURCE_PACKS.md`，本指南位于 `mods/interfaces/DEVELOPMENT.md`。

频道插槽中的每行结构为 `.channel-row[data-channel-row]`，内部 `.channel[data-channel-id]` 与 `.channel-settings[data-channel-settings]` 是并列按钮。右侧按钮承载频道设置与分享，至少保留 28×28 像素的可点击区域，使用主题变量着色；不要将其嵌入频道按钮或用覆盖层挡住。列表会按稳定 ID 保留节点，样式不要依赖成员或频道是容器的第几个直接子节点。

头像裁剪属于主程序弹窗：`#avatarCropEditor`、`.avatar-crop-frame`、`.avatar-crop-zoom` 可通过主题 CSS 调整外观，操作、JPEG 压缩和保存由主程序保管；保留窄窗口下的缩放与确认按钮。`#railSettingsBtn` 与主题的 `command("settings")` 打开“软件设置”（`#softwareSettingsPanel`）；`#voiceSettingsBtn` 打开独立的“语音与共享设置”（`#voiceSettingsPanel`），请保留各自用途与无障碍标签。主题若自带软件设置按钮，应隐藏自身布局中的 `.rail-settings`，避免重复入口。软件设置内的 `#themeCustomizationMenuBtn` 打开本机界面自定义，其下提供 `#notificationJoinSoundMenuBtn`、`#notificationLeaveSoundMenuBtn` 和 `#notificationResetSoundsMenuBtn`。域菜单不再放置这些本机偏好。它们打开系统音频文件选择窗口，提示音是独立的本机偏好，不属于服务器权限或主题资源，不会因切换主题而被替换。

权限、删除、加密迁移及密钥分享的最终确认不开放给主题：Windows 使用主进程控制的独立本机窗口，网页端使用浏览器原生确认。主题可以设计入口，但不能伪造确认通过、接触签名私钥或覆盖确认窗口。

| 位置 | 用途 |
| --- | --- |
| 仓库 `public/customization/interfaces/` | 开发源码；清单引用 `packages/<主题>/` 中的内容 |
| EXE 旁 `mods/interfaces/` | 兼容本机方案及本指南；软件内开发指南链接打开这里 |
| EXE 旁 `mods/packs/<id>/` | 资源管理安装的完整包，由 `mods/registry.json` 登记 |
| 本机偏好中的 `interfaceSelection` | 上次保存的完整主题快照，选择并保存后应用 |

资源默认随 EXE 放在同级 `mods` 目录，源码开发使用仓库根 `mods`。显式绝对路径 `DEEPSCORD_RESOURCE_ROOT` 优先；测试或专用配置只设置 `DEEPSCORD_USER_DATA` 时使用该目录的 `mods` 隔离资源，正常无覆盖配置仍随 EXE。旧 AppData 自定义资源只在升级时复制、校验并迁移一次，旧文件留作备份；迁移完成后读取和安装不再依赖旧路径。软件目录不可写时明确报错，请将软件放在可写位置；不会暗中改存系统盘。

本仓库的三套开放主题是 **“工程站·开放主题”**、**“构成报刊·开放主题”** 和 **“Lanart · 测绘与星轨双模态”**；它们与“工程站 · 低动效”“构成主义索引”等参数方案是不同条目。开发时分别参考 `industrial-open.json` 与 `packages/industrial/`、`constructivist-open.json` 与 `packages/constructivist/`、`lanart-open.json` 与 `packages/lanart/`，为分发目录添加共用协议规定的 `pack.json`，保留清单中的相对文件关系，再作为 ZIP 或文件夹安装。

发布 ZIP 将三套完整主题打包在 `mods/examples/industrial-open/`、`mods/examples/constructivist-open/` 和 `mods/examples/lanart-open/`，可直接复制修改或在资源管理逐个安装文件夹。示例包不含个人登记与服务器绑定；对应默认方案会在首次初始化时登记，之后主动删除的方案不会重新出现。制作新主题时同时修改包 ID 和方案 ID，分享 ZIP 时让 `pack.json` 位于第一层。

1. 打开资源管理并安装完整包。相同包 ID 再次安装用于更新；安装结果以资源管理显示为准。
2. 返回“本机界面自定义”，重新展开列表，选择对应开放主题，预览后点“保存界面方案”。**更新当前主题后也必须重新选择并保存，才能替换旧内容快照。**
3. 关闭设置检查布局，重启客户端检查保存结果。安装、更新、选择主题只修改本机外观，不会发布到服务器。

使用中的主题须先切换到其他主题并保存，再在资源管理移除。移除未完成会保留提示和重试入口，不等于卸载成功。`mods/interfaces/` 内既有本地清单仍可读取；日常分发与更新使用完整资源包，勿手改 `mods/registry.json`。

交付主题至少带齐 `pack.json`、唯一 ID 的方案清单、清单引用的内容文件及实际安装验证结果。起点可复制 `industrial-open.json`，修改方案 `id`、`name` 和三条 `files` 路径，再复制对应内容目录。普通网页仍须适配下面的七个插槽和脚本 SDK；不要把整页 `<script>`、`<style>`、业务 UI 的替代节点直接塞进布局。

排查“安装了但还是旧界面”时，检查完整包安装结果、`entries[].file`、清单 `files`、所选开放主题及重新选择保存步骤。初始化标记不用于更新；不要直接修改正在使用的 `client-preferences.json`。默认示例和指南由安装包提供，个人笔记另存。非法文件明确指出路径并中止读取，修好后刷新。

所有普通成员都可选择本机主题。浏览器仅读取随网站发布的方案，不具备 Windows 资源管理和文件夹访问能力。

## 完整方案示例

以下每段都是独立文件，复制即可使用。id 在目录内必须唯一。复制修改方案时请同时修改 id 与 name。

```json
{
  "version": 1,
  "id": "industrial",
  "name": "工程站 · 低动效",
  "description": "紧凑的工业控制台，保留固定频道栏和低动态表现。",
  "theme": {
    "accent": "#87d8ce",
    "background": "charcoal",
    "density": "comfortable",
    "corners": "square"
  },
  "interfaceProfile": {
    "version": 1,
    "preset": "industrial",
    "motion": "reduced",
    "navigation": "rail",
    "memberPanel": "expanded"
  },
  "options": [
    {
      "id": "content-spacing",
      "label": "内容间距",
      "type": "range",
      "default": 12,
      "min": 8,
      "max": 24,
      "step": 1,
      "unit": "px",
      "cssVariable": "--scheme-content-spacing"
    },
    {
      "id": "title-scale",
      "label": "标题比例",
      "type": "range",
      "default": 1,
      "min": 0.8,
      "max": 1.4,
      "step": 0.05,
      "unit": "",
      "cssVariable": "--scheme-title-scale"
    }
  ]
}
```

```json
{
  "version": 1,
  "id": "constructivist",
  "name": "构成主义索引",
  "description": "以索引导航和切入动效组织频道，使用红色重点和紧凑成员栏。",
  "theme": {"accent":"#dc5148","background":"slate","density":"compact","corners":"square"},
  "interfaceProfile": {"version":1,"preset":"constructivist","motion":"full","navigation":"index","memberPanel":"compact"},
  "options": [
    {"id":"content-spacing","label":"内容间距","type":"range","default":16,"min":8,"max":24,"step":1,"unit":"px","cssVariable":"--scheme-content-spacing"},
    {"id":"title-scale","label":"标题比例","type":"range","default":1.15,"min":0.8,"max":1.4,"step":0.05,"unit":"","cssVariable":"--scheme-title-scale"}
  ]
}
```

## 字段与可调项

运行时规范是 public/js/interface-scheme.js，没有独立 JSON Schema 文件。必需字段非法或缺失会报错，多余字段剥离。每文件最多 256 KiB，每目录最多 64 个方案；文件必须是普通文件，符号链接不接受。

- version：数字 1。
- id：1–64 位，以小写字母开头，其余为小写字母、数字、短横线。
- name：1–80 个可打印字符；description：1–512 个可打印字符。
- theme：明确给出 null 或 `{accent,background,density,corners}`。accent 是六位十六进制 RGB；background 为 charcoal/slate/midnight；density 为 comfortable/compact；corners 为 square/soft。构成报刊引擎固定纸红墨，配色字段不覆盖其固定色板。
- interfaceProfile：完整 `{version:1,preset,motion,navigation,memberPanel}`。preset 为 industrial/constructivist，motion 为 full/reduced，navigation 为 rail/index，memberPanel 为 expanded/compact。系统减少动效仍优先。
- options：0–16 项，仅这里声明的参数出现在方案下方。无选项时显示“此方案没有开放可调参数”。

每个 option 必须有 id、label、type、default 和 cssVariable。id 遵循方案 id 规则；label 最多 80 字；cssVariable 必须以 --scheme- 开头，后面仅小写字母、数字、短横线。选项 id 和变量名在同一方案中不能重复。

- range：还需 min、max、step、unit。数值有限且绝对值不超过 10000，min < max，0 < step <= max-min；default 与保存值必须落在区间并符合步长。unit 为 px/rem/%/空字符串。
- select：还需 choices（1–24 项），每项为 `{value,label,cssValue}`。value 为安全小写 id，default 必须匹配其中一项；cssValue 是简单 CSS 字面量。
- toggle：default 为 boolean，还需 on、off 两个 CSS 字面量。

CSS 字面量只允许简单数字/单位、颜色、关键词及空格分隔值，不允许 URL、函数、分号或任意 CSS 声明。选项值转换为声明的变量，并不自动创造一个界面功能：引擎样式必须实际读取此变量。当前两个引擎读取 --scheme-content-spacing（stage-grid 间距、消息左右留白）和 --scheme-title-scale（舞台标题比例）。可以把 select 的 cssValue 映射为 12px/20px 调整间距，也可以由 toggle 的 on/off 设置现有变量的两种值；为新行为增加新变量时需修改随客户端发布的样式代码。

## 完整 HTML、CSS 与 JavaScript 主题包

开放主题可以定义自己的 HTML 结构、完整样式与隔离 JavaScript，不限于上面的参数。方案继续保留 `version`、`id`、`name`、`description`、`theme`、`interfaceProfile`、`options`；额外选择下面一种内容来源。`options` 可以为空数组，或提供供主题读取的可调参数。

磁盘清单增加 `files`，以下是应合并到完整方案 JSON 的字段示意：

```text
"files": {
  "html": "packages/my-theme/layout.html",
  "css": "packages/my-theme/style.css",
  "script": "packages/my-theme/script.js"
}
```

三个路径均必须明确提供，分别以 `.html`、`.css`、`.js` 结尾；路径相对于清单所在目录。兼容目录只读取第一层 `.json` 清单；完整资源包按 `pack.json` 的 `entries` 指定清单，内容文件可放子目录。禁止绝对路径、`..`、`.`、空路径段、Windows 非法路径字符、符号链接或目录联接；解析后的真实路径必须仍位于清单目录内。每份清单最多 256 KiB，每个内容文件最多 128 KiB，使用 UTF-8。缺文件、路径越界、扩展名错误、链接或内容超限均明确报错。

也可在完整方案中直接增加 `presentation` 对象，显式给出 `html`、`css`、`script` 三个字符串，例如 `"presentation":{"html":"<main>My theme</main>","css":"main { padding: 24px; }","script":""}`。允许空 CSS 或脚本，缺字段或非字符串不接受；每个字符串按 UTF-8 编码后最多 128 KiB。`files` 和 `presentation` 不能同时出现，避免两个来源互相覆盖。多余字段由 parser 剥离。

桌面读取磁盘清单时将三个文件读入 `presentation` 内容快照并剥离 `files`，之后才交给公共 parser。完整规范化方案序列化为 JSON 后最多 512 KiB，限制包含转义字符膨胀。保存的 `interfaceSelection` 只携带内容快照和选项，所有本机偏好共用 1 MiB 文件预算；不会将主题文件路径传给运行中的主题。改动清单或任一内容文件后，返回窗口刷新目录，再重新选择、预览并保存，当前已应用快照不会随文件变化。

公共 `parseInterfaceScheme` 只校验内容，不执行 HTML、CSS 或脚本，也不会自行解析磁盘路径；直接将未展开的 `files` 清单传给它会报错。主题执行由客户端的隔离主题运行时负责，主题不能直接访问房间页面、桌面接口或本机私人库。

## 隔离运行时 SDK

实现规范为 `public/js/interface-package.js`。HTML 与 CSS 负责布局、颜色、字体和装饰；脚本在独立、无同源权限的 `sandbox="allow-scripts"` iframe 中运行，通过 `globalThis.deepscordTheme` 操作自己的布局。脚本不能读取主界面 DOM、消息正文、成员密钥、Electron 接口或本机私人库；网络请求由隔离框架的 CSP 禁止。这里开放完整外观与受控行为，不授予宿主进程脚本权限。

### HTML 插槽与元素

主题 HTML 必须各包含恰好一个以下插槽，不能嵌套，不能添加未知插槽：

| `data-deepscord-slot` | 放入的现有应用节点 |
| --- | --- |
| `rail` | `#serverRail`，域导航 |
| `sidebar` | `.sidebar`，频道列表 |
| `topbar` | `.topbar`，当前频道工具栏 |
| `radio` | `#radioStrip`，电台 |
| `content` | `.main > .content`，现有聊天、语音和共享区域 |
| `members` | `#members`，成员栏 |
| `self` | `#selfPanel`，自己的语音控制 |

运行时使用 `moveBefore` 将原节点移入插槽，退出主题时移回原位置；不复制节点或重建媒体元素。客户端必须支持保持节点状态的 `moveBefore`，不支持时明确报错。主题可自由安排七块区域的位置与尺寸，并为外围结构编写自己的元素。

所有显式 HTML ID 必须以 `theme-` 开头，其后 1–80 位 ASCII 字母、数字、下划线或短横线；同一布局不能重复，也不能与当前页面已有 ID 冲突。脚本只可操作原始主题 HTML 中的自有元素，不能借插槽访问移入的应用节点。以下是可修改的最小布局骨架：

```html
<main id="theme-demo">
  <h1 id="theme-demo-name">My theme</h1>
  <button id="theme-demo-settings" type="button" data-theme-action="settings">设置</button>
  <nav data-deepscord-slot="rail"></nav>
  <aside data-deepscord-slot="sidebar"></aside>
  <header data-deepscord-slot="topbar"></header>
  <section data-deepscord-slot="radio"></section>
  <section data-deepscord-slot="content"></section>
  <aside data-deepscord-slot="members"></aside>
  <footer data-deepscord-slot="self"></footer>
</main>
```

HTML 不接受 `script`、`style`、`link`、`meta`、`base`、iframe/frame、object/embed 或 form；脚本放独立 `.js`，样式放独立 `.css`。禁止内联事件、`srcdoc`、表单动作等可执行或导航属性；图片 `src` 只允许嵌入的图片 data URL，`href`/`xlink:href` 只允许当前文档 `#` 锚点。CSS 可用完整声明、选择器、布局与颜色，不受参数选项的简单字面量规则限制；禁止网络导入、`@import`、`image-set`、`expression` 及行为绑定。`url()` 仅接受 PNG/JPEG/WebP/AVIF/SVG 图片和 WOFF/WOFF2/TTF 字体的 data URL，不能用相对路径或远程地址。

### 状态、动作与方法

脚本启动时取得桥接对象并注册监听；桥就绪后收到当前状态，之后随应用状态更新。方法不返回业务结果，非法操作会使本主题脚本停止并显示错误提示。

| 方法 | 参数与效果 |
| --- | --- |
| `on('state', handler)` | 回调接收 `{serverName:string, channelName:string, connected:boolean, memberCount:number}`。这是只含名称、连接状态和人数的快照，不是完整房间状态或聊天消息 |
| `on('action', handler)` | 用户真实点击主题自有 `[data-theme-action]` 元素时，接收 `{action:string}`，值取自该属性。脚本合成点击不会取得命令权限 |
| `setText(id, text)` | 更新自有元素的纯文本，最多 8000 字符；不能替换插槽本身或任何包含插槽的容器 |
| `setAttribute(id, name, value)` | 只可设置 `data-*`、`aria-*`、`class`、`hidden`；`value` 为最多 1000 字符的字符串，传 `null` 删除属性。不能修改 `data-deepscord-slot`。显示元素时应删除 `hidden`，不要设置字符串 `"false"` |
| `setVariable(name, value)` | 设置任意合法 CSS 自定义属性，例如 `--theme-gap`、`--accent`；名称最多 80 字符，值最多 2000 字符，仍经过 CSS 资源校验。退出主题时恢复此前值 |
| `animate(id, keyframes, options)` | 在自有元素上播放有界动画，参数见下方。系统减少动效时不启动动画，切换为减少动效时取消活动动画 |
| `command(name)` | 允许 `settings`、`toggleMic`、`toggleDeafen`、`serverMenu`、`toggleMembers`，分别打开设置、切换麦克风、切换闭音、打开服务器菜单、切换成员栏 |

`command` 必须由当前真实用户动作触发：在 `action` 回调中立即调用，每次动作凭据最多使用一次，宿主接收有效期为 1500ms。`state` 回调、启动脚本或延迟定时器不取得此权限。普通外观更新无需命令凭据。桥接操作上限为每秒 240 条，不要用逐帧消息驱动动效。

```javascript
const theme = globalThis.deepscordTheme;
theme.on('state', state => {
  theme.setText('theme-demo-name', state.serverName);
});
theme.on('action', event => {
  if (event.action === 'settings') theme.command('settings');
});
```

`animate` 需要 2–60 个关键帧，属性仅支持 `opacity`、`transform`、`translate`、`rotate`、`scale`、`filter`、`backgroundColor`、`color`、`clipPath`、`offset`，值为字符串或数字。`options` 必须显式提供 `{duration, iterations, easing}`：时长为 0–10000ms，次数为 1–20 的整数，缓动为最多 100 字符的有效 Web Animations 缓动字符串。同时最多 32 个活动动画；完成或取消后释放。示例：

```javascript
theme.animate('theme-demo-name', [
  {opacity: 0, transform: 'translateX(-12px)'},
  {opacity: 1, transform: 'translateX(0)'}
], {duration: 220, iterations: 1, easing: 'ease-out'});
```

脚本抛错、未处理的 Promise 拒绝或桥接校验失败会关闭脚本通道、移除脚本 iframe、取消其活动动画并提示错误；已建立的布局和原应用节点保留，不宣称脚本继续运行。重新应用或退出主题才重建或清理该运行时。取消预览、切换主题和清空方案时撤销监听、关闭通道、恢复原节点与变量。

## 三套可直接编辑的完整例子

复制一套清单及对应内容目录，修改清单 `id`、`name` 与 `files`，即可做自己的主题。别只复制 HTML 丢下 CSS 或脚本；三项路径必须与新目录一致。下面三套均是作者编写的产品设计，不代表复刻了其他产品的原始动效。

| 清单与内容目录 | 可编辑位置与实际行为 |
| --- | --- |
| `industrial-open.json`；`packages/industrial/{layout.html,style.css,script.js}` | HTML 使用 `theme-workstation` 结构组织工作台、频道、成员和底部自己的控制。CSS 中修改背景、强调色、网格列宽和间距。脚本将状态写入 `theme-industrial-server/channel/status/count`；“紧凑排布”按钮修改自有 `data-density`、`aria-pressed` 和 `--theme-workstation-density`，“设置”按钮发起 `command('settings')` |
| `constructivist-open.json`；`packages/constructivist/{layout.html,style.css,script.js}` | HTML 使用 `theme-newspaper` 组织报头、目录、阅读区与成员栏。CSS 中修改纸色、红黑强调、标题比例、网格布局和窄屏规则。脚本通过 `data-directory` 展开目录、通过 `data-density` 切换排印密度；频道名称变化时播放 220ms 标题进入动画，“设置”通过同一命令桥打开 |
| `lanart-open.json`；`packages/lanart/{layout.html,style.css,script.js}` | HTML 保留七个原生功能插槽，CSS 提供白昼测绘与暗夜轨道布局；脚本切换 `data-art-mode` 并完整恢复两套色彩变量，也提供窄屏目录、紧凑排布及原生软件设置入口。新增业务功能由插槽内的主程序提供，勿复制旧版业务控件 |

这些脚本的密度、目录展开及 Lanart 的昼夜模式是本次主题运行时内的局部状态，不会自动持久保存；需要可保存参数时在清单 `options` 声明，并通过相应 CSS 变量设计样式。先修改 HTML 自有元素，再同步调整脚本的 `theme-*` ID；删除脚本仍引用的元素会明确报错。保留七个插槽并检查窄屏、减少动效、切换频道、预览取消与重新打开主题后的行为。

## 实际开发接口

- parseInterfaceScheme(value)：校验并返回完整方案新对象。
- parseSchemeValues(scheme, values)：验证保存值，缺少的选项使用方案显式 default，多余键剥离。
- resolveInterfaceScheme(scheme, values)：返回 `{theme,interfaceProfile,variables,values}`，variables 是 CSS 变量名到字符串值的映射。
- parseInterfaceSelection(value)：校验 `{scheme,values}` 选择快照。
- public/js/interface-scheme-runtime.js：加载目录/网页方案、预览和清理 CSS 变量。
- public/js/interface-package.js：完整布局校验、原节点移动、隔离脚本桥、有界动画和销毁恢复。
- public/js/interface-scheme-ui.js：从方案 options 生成面板，提供自绘列表、键盘操作、返回窗口刷新及 dispose。
- desktop/customization-store.cjs：磁盘初始化、读取限额、指南更新。desktop/main.js 校验可信房间调用后打开固定目录；preload 暴露 listInterfaceSchemes() 和 openCustomizationDirectory('interfaces')，不接受任意系统路径。

保存到本机 client-preferences.json 的 interfaceSelection 是完整方案与选项快照，同时派生兼容的 localTheme/interfaceProfile。文件修改不会偷偷改变正在用的界面；重新选择该方案后预览并保存新版本。文件删除后已保存快照仍能启动，打开编辑器时提示文件不在目录，需选择有效方案再保存。关闭未保存面板恢复原快照，切服务器也不会变成其他用户的外观。

完整开放主题在隔离运行时中编写 HTML、CSS 与 JavaScript；兼容参数方案仍使用随客户端发布的 `interface-profile.js` 与 `public/interface.css`。主题不能通过换皮重建 `voiceStage`、`stageGrid`、`audioSinks`、`chat`、`selfPanel` 等通信与媒体节点。取消预览、关闭面板、隐藏页面和销毁时应撤销监听、观察器、动画与变量；禁止闲置绘制循环。所有新注释用 English，外部数据必须经过 parser。

## 开发与验收

Node >=22.13，在仓库根执行 npm ci，桌面依赖使用 npm run desktop:deps。根 public/lib/server.js 是源码，desktop/app-server 是生成副本；开发启动前 npm run desktop:sync，不要手改生成副本。

```powershell
npm run typecheck
npm run test:customization-guides
node test/interface-scheme.mjs
node test/interface-package.mjs
node test/interface-package-ui.mjs
npm run test:interface
```

Chrome 测试可通过 CHROME_PATH 指定本机 chrome.exe。真实桌面目录验收为 test/customization-directory-native.mjs，DEEPSCORD_ACCEPTANCE_PACKAGE 指向完整候选客户端目录。测试使用隔离资料；正常产品资料不能用作测试临时目录。

验收需覆盖：文件新增和移除、空目录与错误文件仍能打开加号、鼠标/方向键/Home/End/Enter/Escape、两套风格与窄屏、声明选项的真实样式变化、未保存取消、保存/重启、另一客户端不变及媒体节点不被替换。开发指南另一份位于相邻 interactions 目录；部署与信任边界参阅仓库根 NETWORKING.md。
