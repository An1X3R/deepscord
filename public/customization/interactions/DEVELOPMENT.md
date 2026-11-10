# Deepscord 互动动画开发指南

适用源码：Deepscord `public/`、`lib/` 与 `desktop/`，核对日期 2026-11-09。此文件独立说明定义、动画、权限、传输及资源生命周期。源码路径以仓库根目录为起点；本文件位于 `public/customization/interactions/DEVELOPMENT.md`。

## 从哪里开始

在房间名称菜单打开“互动表情管理”。互动表情与静态服务器表情均使用全服统一目录，服务器所有域共享，没有域专属表情目录。炸弹、便便、轻轻捶你、收点小费与新增互动均在同一列表编辑、删除、导入导出；没有独立只读内置区或“添加示例”按钮。试投只在本机预览；上传或保存才提交签名治理变更，随后进入成员投掷菜单。

已验证的服主与服务器管理员可以管理两类全服表情；域主、域管理员与自定义权限组不因此获得管理权。权限以 `canManageServerCatalog(policy, selfKey)` 为准，服务端同时校验，不能只依赖界面隐藏按钮。普通成员可以使用全服表情，无需管理权限；投掷双方须处于同一语音频道、当前互动会话及对端连接就绪，不能投向自己。

桌面端在“资源管理（主题与表情）”选择“安装 ZIP 包”或“安装文件夹”导入完整互动包，无需手拆文件。根目录 `pack.json` 的共用格式、缩略图文件约定及包限额见 [资源包协议](../RESOURCE_PACKS.md)，客户端对应 `mods/RESOURCE_PACKS.md`。

发布 ZIP 自带 `mods/examples/interaction-examples/`，其中 `pack.json` 与四份互动定义组成可独立分享的完整示例包；在资源管理直接选择该文件夹安装即可。它默认尚未安装，也未绑定任何服务器。旁边 `mods/examples/sticker-example/` 是原创几何 AVIF 图片表情示例，不含个人图片；图片表情和互动动画按各自清单分包分发。

资源默认保存在 EXE 旁 `mods/`，源码开发使用仓库根 `mods/`；显式绝对路径 `DEEPSCORD_RESOURCE_ROOT` 优先，测试或专用配置仅设置 `DEEPSCORD_USER_DATA` 时使用该目录的 `mods/` 隔离资源，正常无覆盖配置仍随 EXE。完整包在 `mods/packs/<id>/`，登记在 `mods/registry.json`，本指南在 `mods/interactions/DEVELOPMENT.md`。开发指南及互动目录按钮打开 `mods/interactions/`；四项根目录 JSON 模板供开发参考，不属于任何服务器，不直接进入待上传列表。旧 AppData 资源升级时一次性复制并校验，旧件保留备份，完成后不再依赖旧路径。软件目录不可写会明确报错，不会偷偷改存系统盘。

安装后在资源管理将互动包“绑定当前服务器”，回到“互动表情管理”刷新并选择待上传定义，再明确上传或保存。**安装和绑定均不会自动发布服务器互动。** 仍需已验证服主或服务器管理员权限，并接受服务器全服 96 项预算检查；普通成员安装本机包不会取得发布权限。

兼容本地草稿使用 `mods/interactions/<服务器 UUID>/`，例如 `mods/interactions/550e8400-e29b-41d4-a716-446655440000/`。目录按 UUID 隔离，同名服务器不混用；管理面板同时提供绑定当前服务器的包定义。新服务器目录为空，不从已发布目录自动同步，不自动添加默认项。既有单份 JSON 草稿仍可读取；新包分发走资源管理完整安装。每个服务器最多读取 96 项定义、每个 JSON 最多 256 KiB，ID 不得重复；任一文件无效会指出路径并中止读取。其他服务器未绑定包和草稿不会混入。

本地草稿和服务器已发布目录各自独立。读取、编辑或删除本地 JSON 不会自动改写服务器签名目录，服务器删除也不会删除本地草稿；删除的互动只有再次明确上传或保存才会发布。上传受当前服务器的管理权限及全服 96 项预算限制。已发布互动仍在管理列表中编辑、删除；导出仍通过下载保存。网页端仍可通过文件选择器导入和浏览器下载导出。

## 定义与校验

运行时 parser 是规范，目前没有单独 JSON Schema 文件：

| 文件 | 职责 |
| --- | --- |
| [customization-protocol.js](../../js/customization-protocol.js) | `parseCustomInteraction(value)`、`canManageServerCatalog(policy, selfKey)`；`customInteractions(policy, domainId)` 返回独立副本，迁移后所有域读取同一全服定义 |
| [interaction-scene.js](../../js/interaction-scene.js) | `parseInteractionScene(value)` 与 `scenePose(actor, progress, sender, target)` |
| `public/js/interaction-defaults.js`、`interaction-scene-examples.js` | 四项初始普通互动及版本 1 的固定场景数据；参与签名日志重放，发布后不得改写版本 1 内容 |
| `public/js/customization-files.js` | JSON 文件读取与下载，最大 256 KiB |
| `public/js/customization-ui.js` | 编辑、导入导出、上传缩略图及本地试投 |
| `public/js/interaction-catalog.js` | 旧协议播放兼容、`interactionRevision(definition)` 及播放定义解析 |
| `public/js/interactions.js`、`interaction-protocol.js` | 会话、目标、版本及事件传输 |
| `public/js/interaction-renderer.js`、`interaction-scene-drawing.js` | 单画布播放、模型绘制及清理 |
| `public/js/interaction-audio.js` | 仅本地播放内置音效，不接入采集与媒体发送轨 |
| `lib/server-governance.cjs`、`lib/governance-store.cjs` | 签名权限记录、持久化及恢复 |

完整定义没有顶层 `version`；只有可选 `scene` 内需要 `version:1`。

| 顶层字段 | 契约 |
| --- | --- |
| `id` | 1–80 位安全 ASCII 字母、数字、下划线或短横线，不能为 `bomb`、`poop`、`__proto__`、`prototype`、`constructor` |
| `name` | 1–24 个字符，不能全空白或含控制字符 |
| `thumbnail` | 必须明确给出 `null` 或已经校验并上传的静态 AVIF `MediaMetadata`；不能填任意图片 URL |
| `model` | `bomb` / `poop` / `thumbnail`，即使带场景也要保留此合法字段 |
| `trajectory` | `linear` / `arc`；有 `scene` 时播放使用关键帧 |
| `sound` | `none` / `bomb-1` / `bomb-2` / `bomb-3` / `bomb-4` / `poop` |
| `durationMs` | 整数；无场景 300–2000ms，有场景 300–4000ms |
| `scene` | 可省略；给出时必须是合法场景对象，不能用 `null` 代替省略 |

额外字段从 parser 返回值剥离，非法或缺失字段明确报错。省略 `scene` 不会补入空场景，旧定义的规范化形态与版本摘要保持兼容。迁移后的互动只有全服目录，同一 ID 表示同一已发布互动，不再有域覆盖或继承项。`bomb`、`poop` 保留给旧事件类型，初始普通互动使用非保留 ID `default-bomb`、`default-poop`、`playful-fist`、`dollar-wallet`。全服互动最多 96 项；旧域数据的 24 项范围限制仅用于历史记录兼容。单份治理日志还有 2 MiB/2048 个事件及房间同步预算限制，动画数量上限不是可无条件填满的存储承诺。

## 场景格式与坐标

`scene` 为 `{ "version":1, "actors":[...] }`，包含 1–8 个 actor；每个 actor 只有 `model` 和 `keyframes`，支持 `fist`、`dollar`、`wallet`、`bomb`、`poop`、`thumbnail`。同一互动共用一份 `thumbnail`；任何 actor 使用它时，顶层必须提供有效静态资源。

每个 actor 有 2–12 个关键帧。下表所有字段必须显式填写，数值均有限，首帧 `at` 必须为 0、末帧为 1，中间严格递增。JSON 不能使用 NaN 或 Infinity。

| 字段 | 范围与单位 |
| --- | --- |
| `at` | 0–1，归一化时间；实际时刻为 `at × durationMs` |
| `anchor` | `sender`（使用者头像中心）或 `target`（目标头像中心） |
| `x`, `y` | -480–480，屏幕 CSS 像素偏移；右为正 x，下为正 y |
| `z` | -240–240，透视深度与排序；正值靠近观察者 |
| `scale` | 0–4，相对基础模型大小；0 不绘制 |
| `rotateX`, `rotateY`, `rotateZ` | -1080–1080，角度制 |
| `opacity` | 0–1；0 不绘制 |

各相邻关键帧线性插值，包括锚点的当前屏幕位置；从 `target` 切到 `sender` 即从目标飞回使用者。头像移动后位置按当前边界重新计算。基础半径受头像大小约束为 13–23px，`z` 再影响透视缩放。钱包为本地几何面，美元为绘制图形，拳头使用系统 Emoji；这是 Canvas 中的模型动画，并非任意 GLTF/WebGL 模型加载器。不同系统 Emoji 的形状可能不同。

## 完整示例：拳头轻捶

保存为 `.json` 后导入互动定义。`model:"poop"` 是合法兼容字段，实际绘制取自 `scene.actors` 的拳头。

```json
{
  "id": "playful-fist",
  "name": "轻轻捶你",
  "thumbnail": null,
  "model": "poop",
  "trajectory": "linear",
  "sound": "none",
  "durationMs": 1400,
  "scene": {
    "version": 1,
    "actors": [
      {
        "model": "fist",
        "keyframes": [
          {"at":0,"anchor":"target","x":24,"y":-5,"z":0,"scale":0.8,"rotateX":0,"rotateY":0,"rotateZ":-20,"opacity":1},
          {"at":0.18,"anchor":"target","x":0,"y":0,"z":30,"scale":1.15,"rotateX":0,"rotateY":0,"rotateZ":0,"opacity":1},
          {"at":0.34,"anchor":"target","x":24,"y":-5,"z":0,"scale":0.8,"rotateX":0,"rotateY":0,"rotateZ":-20,"opacity":1},
          {"at":0.5,"anchor":"target","x":0,"y":0,"z":30,"scale":1.15,"rotateX":0,"rotateY":0,"rotateZ":0,"opacity":1},
          {"at":0.66,"anchor":"target","x":24,"y":-5,"z":0,"scale":0.8,"rotateX":0,"rotateY":0,"rotateZ":-20,"opacity":1},
          {"at":0.82,"anchor":"target","x":0,"y":0,"z":30,"scale":1.15,"rotateX":0,"rotateY":0,"rotateZ":0,"opacity":1},
          {"at":1,"anchor":"target","x":0,"y":0,"z":0,"scale":1,"rotateX":0,"rotateY":0,"rotateZ":0,"opacity":1}
        ]
      }
    ]
  }
}
```

## 完整示例：美元飞回钱包

美元从目标处起飞并翻转，落入使用者处的钱包；钱包是独立 actor。

```json
{
  "id": "dollar-wallet",
  "name": "收点小费",
  "thumbnail": null,
  "model": "poop",
  "trajectory": "linear",
  "sound": "none",
  "durationMs": 1900,
  "scene": {
    "version": 1,
    "actors": [
      {
        "model": "dollar",
        "keyframes": [
          {"at":0,"anchor":"target","x":0,"y":-6,"z":0,"scale":1,"rotateX":-12,"rotateY":0,"rotateZ":-12,"opacity":1},
          {"at":0.2,"anchor":"target","x":0,"y":-48,"z":35,"scale":1.15,"rotateX":-12,"rotateY":90,"rotateZ":-15,"opacity":1},
          {"at":0.72,"anchor":"sender","x":0,"y":-48,"z":25,"scale":0.9,"rotateX":-12,"rotateY":360,"rotateZ":8,"opacity":1},
          {"at":0.92,"anchor":"sender","x":0,"y":3,"z":-15,"scale":0.55,"rotateX":0,"rotateY":360,"rotateZ":0,"opacity":1},
          {"at":1,"anchor":"sender","x":0,"y":12,"z":-30,"scale":0,"rotateX":0,"rotateY":360,"rotateZ":0,"opacity":0}
        ]
      },
      {
        "model": "wallet",
        "keyframes": [
          {"at":0,"anchor":"sender","x":0,"y":14,"z":0,"scale":1,"rotateX":-18,"rotateY":-18,"rotateZ":0,"opacity":1},
          {"at":0.8,"anchor":"sender","x":0,"y":14,"z":0,"scale":1,"rotateX":-18,"rotateY":-18,"rotateZ":0,"opacity":1},
          {"at":0.93,"anchor":"sender","x":0,"y":14,"z":0,"scale":1.14,"rotateX":-18,"rotateY":-18,"rotateZ":0,"opacity":1},
          {"at":1,"anchor":"sender","x":0,"y":14,"z":0,"scale":1,"rotateX":-18,"rotateY":-18,"rotateZ":0,"opacity":1}
        ]
      }
    ]
  }
}
```

## 导入、保存与资源生命周期

导入完整定义后只进入编辑器。创建新互动时 UI 会生成新 UUID，编辑已有互动时保留原 ID，导入文件里的 ID 不会强行覆盖另一个已存条目。场景文本框只粘贴 `scene` 对象；文本最多 65536 个字符。空白表示普通投掷。有编排文本时，表单禁用普通模型和轨迹控件并说明由编排接管，时长上限切为 4000ms；清空后恢复普通投掷的 2000ms 上限。完整文件最大 256 KiB，保存仍受 parser 与治理预算校验。

导出名为 `Deepscord-interaction.json`，保存当前草稿完整定义；导出不发布。若草稿新选了缩略图，试投、导出或保存都会先校验并上传该资源，因此“本地试投”指不广播互动事件，并不表示从未访问后端。导出只含资源描述符，不内嵌图片；另一房间未持有相应授权资源时不可直接移植该描述符，应重新选择本地文件上传。

缩略图可从 PNG/JPEG/WebP/GIF/AVIF 来源选择，经媒体管线转为并校验静态 AVIF；动画缩略图被拒绝。`model:"thumbnail"` 或场景 thumbnail actor 必须有资源。选择的临时对象 URL 在替换、移除、关闭时释放；已经上传但未发布的文件按现有媒体未引用回收规则处理，不因关面板立即删除仍被其他记录引用的文件。

服主或服务器管理员连接就绪并完成身份验证后，以签名命令 `{type:"migrateServerCatalog"}` 将旧全服与域互动聚合到全服目录，静态服务器表情也统一为全服，并在派生 policy 标记 `interactionCatalogVersion:2`。迁移保留旧签名事件及重放规则，不回写历史记录。互动按原全服目录优先、旧域 ID 确定顺序聚合；重 ID 条目使用确定性新 ID 保留，不静默覆盖。旧域主题配置仍保留，不属于两类表情迁移对象。

未初始化过的旧目录仅在剩余容量内补入缺少的初始互动，优先完整保留用户原有条目；已带 `interactionCatalogVersion:1` 的目录不补回任何已删除初始项。版本 2 标记持久化后不再迁移或补默认项，删除互动不会在重开面板、重入或后端重启时复活。迁移仍受签名日志与同步预算校验，失败须明确提示，不能假装成功。

保存提交 `{type:"putInteraction", domainId:null, interaction}`，删除提交 `{type:"deleteInteraction", domainId:null, interactionId}`；两类表情的新管理命令均必须使用全服 `domainId:null`，非空域被拒绝。客户端签署治理事件，后端核验当前身份与权限并持久保存，收到成功更新后界面显示结果。不要直接改写 `server-governance.json` 或工作区里的签名内容。重开房 seed 和 Steam 检查点携带治理记录，媒体文件另走授权读取与副本恢复；仅有 JSON 不代表拥有文件副本。

运行时最多保留 8 个活动投掷和 8 个待触发结束事件，共用一个画布、DPR 上限 1.5，无事件时不运行绘制循环。缩略图读取返回 `{url,release}` 租约并支持 AbortSignal；结束、成员离开、清空和销毁会取消任务、释放租约及定时器。页面隐藏移除画布；音效结束定时器有独立策略，不能将隐藏动画理解为关闭声音。系统减少动效时显示场景结束姿态，避免完整运动。

## 传输、版本与音效

自定义仍走原互动会话的成员间事件通道，事件类型使用 `kind:"custom"`，携带 `customId` 和 `customRevision`（规范化定义 SHA-256，64 位小写十六进制），`soundIndex:0`。完整定义及场景不随每次投掷重复发送，而从已验证治理目录解析。接收端目录没有对应 ID/摘要时不播放，不用猜测或回退成内置互动；修改定义后摘要改变。事件同时绑定频道、发送/目标/接收会话、递增序号与事件 ID，离开再加入的旧事件不属于新会话。

投掷菜单仅展示治理目录，初始炸弹、便便与拳头、钱包均按 `kind:"custom"` 发送；空目录显示空状态，不补回默认项。初始炸弹默认音效为可编辑的 `bomb-1`。旧协议兼容仍保留 `kind:"bomb"` 的 0–3 音效索引及 `kind:"poop"` 的索引 0，供旧事件传输与播放使用，不作为新菜单中的独立条目。旧客户端没有 scene 解析能力时不能保证播放新场景，双方需更新，省略 scene 的旧定义则保持原签名形态和普通轨迹行为。

音效只可选择随包五个文件，无自定义 URL 或音频上传。只有使用者和目标可听到；旁观者能看见动画但不播放声音。目标提示音取本机互动音量，发送者回听还受本机总输出音量与闭音影响；关闭界面声音或互动声音均停止对应播放。目标提示并非从对方麦克风传来，不进入伴奏、采集或网络媒体轨。默认互动音量为 20%，与电台默认 10% 是不同设置。播放还受单次启动和并发限制，页面生命周期及成员清理须同时维护声音与绘制资源。

## 开发与验证

增加本地模型时同步更新 `SceneModel`、parser 白名单、`interaction-scene-drawing.js` 及管理列表图标；添加字段时同时检查规范化摘要、签名日志、独立副本和老定义兼容。不能把 JavaScript、SVG 文本、HTML、动态模块地址塞进定义，执行代码只能随客户端源码审阅和发布。

从仓库根目录执行：

```powershell
npm run typecheck
npm run test:customization-guides
node --test test/interaction-scene.mjs
node --test test/server-governance.mjs test/interaction-catalog-server.mjs
node test/interaction-renderer.mjs
node test/interaction-ui.mjs
node test/interaction-session.mjs
npm run test:interaction-audio
```

场景测试检查数值上限、旧形态、锚点插值、签名往返与副本隔离；真实页面测试需要项目 Chromium/Electron 环境。此列表是验收入口，不宣称本轮全部执行。人工仍需检查完整编辑导入导出、权限变化、缩略图失效、取消、离开语音及长期重复播放后的清理；异地 Steam 多账号传输与原生接替不能由本机 parser/页面测试替代。
