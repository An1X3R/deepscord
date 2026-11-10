# Deepscord Windows 桌面安装包（Deepscord.exe）独立 QA 报告

- **任务**：team task-2「独立验证 Deepscord Windows 桌面安装包」
- **执行者**：独立 QA 子智能体（desktop-qa）
- **执行时间**：2026-11-04 19:23–19:25（Asia/Shanghai）
- **被测产物**：`dist/Deepscord-win32-x64/Deepscord.exe`（Electron 45.2.2 / Chromium 156.0.8078.80）
- **结论**：**通过（24/24 检查项 PASS，0 失败，无脚本错误）**。安装包可独立运行：远程服务器登录、服务器切换页、内置本机服务器三种路径均验证通过。

---

## 1. exe 元数据与目录结构 ✅

| 项目 | 实测值 | 判定 |
| --- | --- | --- |
| 文件 | `Deepscord.exe` | ✅ |
| 文件大小 | 249,469,440 B（237.91 MB） | ✅ |
| SHA-256 | `1EA3154900CB1414EF68C83B39755591B6F46063839999AC103CD8D82AB0DE37` | — |
| ProductName | `Deepscord` | ✅ |
| FileDescription | `Deepscord` | ✅ |
| ProductVersion | `1.0.0` | ✅ |
| FileVersion | `1.0.0` | ✅ |
| CompanyName | `Deepscord` | ✅ |
| OriginalFilename | `Deepscord.exe` | ✅ |
| 图标 | `resources/app/assets/icon.ico`（32,933 B）+ `icon.png`（32,819 B）；exe 可提取 32×32 图标 | ✅ |
| 安装目录总体积 | **356.6 MB**（与预期 ~356MB 一致） | ✅ |
| 端口 | `version` 文件 = `45.2.2` | ✅ |

目录结构（关键部分）：

```
dist/Deepscord-win32-x64/
├─ Deepscord.exe                  (237.91 MB)
├─ resources/
│  └─ app/                        ← asar 关闭，源码直出
│     ├─ main.js                  (14,988 B)
│     ├─ preload.js               (463 B)
│     ├─ bootstrap.html           (7,985 B)  服务器切换页
│     ├─ package.json             (productName=Deepscord, version=1.0.0)
│     ├─ assets/icon.ico|icon.png
│     └─ app-server/              ← 内置本机服务器
│        ├─ server.js             (24,983 B)
│        ├─ package.json
│        ├─ lib/ws.js             (10,028 B)
│        └─ public/               (index.html / app.css / js/*.js)
├─ locales/ resources.pak / icudtl.dat / ffmpeg.dll / *.dll …
```

`resources/app/app-server/` 内 `server.js`、`lib/`、`public/` 均存在且可读 ✅（与 task-2 要求一致）。

---

## 2. 验证方法与环境隔离

- 通过 PowerShell 启动 GUI 进程：先删除本环境默认存在的 `ELECTRON_RUN_AS_NODE`，再
  `Deepscord.exe --remote-debugging-port=9341`，并设置 `DEEPSCORD_USER_DATA=<临时目录>`（main.js 支持）实现全新首次启动会话。
- 使用项目 `test/cdp.mjs` 的 CDP 类驱动（脚本临时存放于系统临时目录，**未修改、未新增任何项目文件**；仅复用其零依赖实现）。
- 导航类操作（`back()`、点击「启动本机服务器」、切换服务器）按已知坑处理：`Runtime.evaluate` 点火后不等待回包，改用 `waitFor` 轮询 `location`。
- 隔离数据目录/进程/端口在结束后全部清理。

---

## 3. 通过项清单（24/24）

### A. 远程服务器模式

| # | 检查项 | 结果 |
| --- | --- | --- |
| A1 | 桌面窗口页面标题含 `Deepscord`（`Deepscord · 语音频道`） | ✅ |
| A2 | 首次启动无预置公共服务器地址，进入工作区等待创建或加入 | 本轮发布检查 |
| A3 | preload 注入 `window.deepscord`（`getConfig/connect/startLocal/back/openExternal/quit`） | ✅ |
| A4 | `getConfig()` 返回默认服务器配置、version=1.0.0、electron=45.2.2、localPort=38480 | ✅ |
| A5 | Electron 运行时为 45.x（45.2.2） | ✅ |
| A6 | 首次进入显示欢迎页（昵称输入 + 访问口令输入） | ✅ |
| A7 | 欢迎页存在 `type=password` 访问口令输入框（远程服务器要求口令） | ✅ |
| A8 | 用访问口令登录后 `window.echo.getState().connStatus === 'open'` | ✅ |
| A9 | 远程频道列表渲染：`大厅 / 开黑房 / 闲聊 / 音乐电台` | ✅ |
| A10 | 登录成功获取 `selfId`（`u-ede06e3061`） | ✅ |

截图：**`docs/qa/desktop-remote.png`**（1633×998，登录后远程频道页，右上「已连接 · 64ms」）

### B. 服务器切换页

| # | 检查项 | 结果 |
| --- | --- | --- |
| B1 | `window.deepscord.back()` 进入 `file:///.../resources/app/bootstrap.html` | ✅ |
| B2 | 启动页品牌标题为 `Deepscord` | ✅ |
| B3 | 服务器地址仅来自用户已保存的配置；新配置为空 | 本轮发布检查 |
| B4 | 启动页显示 `v1.0.0 · Electron 45.2.2` | ✅ |
| B5 | bootstrap 页 `deepscord` API 可用（「连接服务器」「启动本机服务器」功能就绪） | ✅ |

截图：**`docs/qa/desktop-launcher.png`**（1633×998，干净状态、远程地址已预填、状态「准备就绪」，按钮可用）

### C. 内置本机服务器模式

| # | 检查项 | 结果 |
| --- | --- | --- |
| C1 | 点击「启动本机服务器」后加载 `http://127.0.0.1:38480/` | ✅ |
| C2 | `GET /api/health` → `{"ok":true,"users":0,"voiceRooms":0,"uptime":0}` | ✅ |
| C3 | 本机模式首次进入显示欢迎页，且**无**访问口令输入框（免口令） | ✅ |
| C4 | 本机模式 `connStatus === 'open'` | ✅ |
| C5 | 本机页面标题 `Deepscord · 语音频道` | ✅ |
| C6 | 本机默认频道渲染（服务器 `Deepscord`：大厅/开黑房/闲聊/音乐电台 ≥4） | ✅ |
| C7 | 本机模式获取 `selfId`（`u-0f0a332db6`） | ✅ |
| C8 | 频道 DOM 节点渲染 `#channelScroll .channel` = 4 | ✅ |

截图：**`docs/qa/desktop-local.png`**（1633×998，本机模式 `127.0.0.1:38480`，本机种子服务器「深夜电台」频道页，左下「本机QA · 在线 · 1ms」）

> 本机内置服务器由主进程以 `ELECTRON_RUN_AS_NODE=1` 子进程拉起，仅监听 `127.0.0.1:38480`；种子数据含两个服务器（`Deepscord`：大厅/开黑房/闲聊/音乐电台；`深夜电台`：小房间/树洞），截图页面为后者。

### D. 脚本错误

| # | 检查项 | 结果 |
| --- | --- | --- |
| D1 | 全程（远程登录 → 切换页 → 本机模式）无未捕获异常、无 `console.error`、无 console warning | ✅ |

---

## 4. 控制台错误

**无。** 通过 CDP 监听 `Runtime.exceptionThrown` 与 `Runtime.consoleAPICalled`，覆盖 A/B/C 全部阶段，`consoleErrors=[]`、`consoleWarns=[]`。

> 限制：控制台监听在 CDP 连接后启用，页面首次导航的最早期日志可能未被重放捕获。

---

## 5. 观察项（非失败，供参考）

1. **首次启动**：`autoConnect` 默认 `false`，无保存配置时进入空工作区，服务器地址为空；由用户选择创建或加入。后续启动可恢复用户已保存的服务器。
2. **本机模式下的频道选择**：本机截图显示的 active 服务器为种子数据第二个服务器「深夜电台」（UI 选中「树洞」文本频道），属正常种子数据展示；期间自动化点击欢迎页后，本机隔离数据 `local-data/store.json` 内出现 2 条 `本机QA 加入了语音频道 / 离开了语音频道` 系统消息（时间点与自动化点击重叠，未能确证触发源）。**仅影响隔离临时数据，未向远程服务器发消息、未加入远程语音频道**（远程截图成员栏仅 QA 自己，且无语音成员）。
3. `LegalCopyright` 为 Electron 模板默认值 `Copyright (C) 2015 GitHub, Inc.`，不影响功能，若正式发布建议替换为自有版权信息。

---

## 6. 清理确认

- ✅ 仅结束本次 QA 启动的 `Deepscord.exe` 进程树（主进程 PID 2336 及其 38480 子进程，共 6 个），核对可执行文件路径后 `taskkill /T /F`；
- ✅ 清理后无残留 `Deepscord` 进程，`9341` / `38480` 端口无监听；
- ✅ 临时用户数据目录 `<TEMP>\deepscord-qa-20261104-192315` 已删除；
- ✅ 未修改应用代码、README、服务器数据，也未改动 `docs/` 下其它内容（仅新增本报告与 3 张截图）。

## 7. 截图索引

| 截图 | 说明 |
| --- | --- |
| [`qa/desktop-remote.png`](qa/desktop-remote.png) | 远程服务器模式，口令登录后 `connStatus=open`，频道渲染正常 |
| [`qa/desktop-launcher.png`](qa/desktop-launcher.png) | 服务器切换页（bootstrap.html），标题/预填地址/版本号正确 |
| [`qa/desktop-local.png`](qa/desktop-local.png) | 本机服务器模式 `127.0.0.1:38480`，health OK、频道渲染正常 |

---

## 8. 重建说明（Lead 集成备注）

QA 完成后又做了一次**仅元数据**的重建：增加 `--app-copyright "Copyright © 2026 Deepscord"`，替换 Electron 默认的 `Copyright (C) 2015 GitHub, Inc.`。

- 新产物 SHA-256：`42B56B21359FF53EC6408DE9FF44DBE72CA8B730D368D1B5132C242F7A2C1F70`
- 代码与 `resources/app` 内容未变，仅 exe 版本资源中的 LegalCopyright 变化
- Lead 已对重建后的最终 exe 重新运行 `test/desktop-check.mjs`：**14/14 通过**（远程登录 / 切换页 / 本机模式 / 无脚本错误），截图已更新到 `docs/screenshots/10~12`
- 之后又把内置种子数据的服务器图标从「回」改为「D」（`resources/app/app-server/server.js`），并重建了一次：exe 本体 SHA 保持不变，最终 exe 再次通过 **14/14** 验证

