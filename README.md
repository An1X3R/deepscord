# Deepscord · 语音频道

> 交接 / 维护请看 **[HANDOVER.md](HANDOVER.md)**（架构、服务器运维、测试、安全事项）；使用者看本 README。

一个**开箱即用**的 Discord 风格语音软件：服务器 / 语音频道 / 文字频道 / 实时多人语音 / 成员列表。
同一套界面，两种用法：

- **Windows 桌面软件（推荐）**：`dist\Deepscord-win32-x64\Deepscord.exe`，绿色免安装，双击即用；
  自行创建或加入服务器，不预置公共服务器地址
- **网页版**：本机运行零依赖 Node 服务，浏览器打开即用；也可以部署到公网给朋友用

技术取向：

- 后端：Node.js（HTTP 静态服务、自实现 WebSocket 信令，独立 SFU 接口使用 LiveKit SDK）
- 前端：原生 ES Module + Web Audio + **WebRTC mesh**（浏览器之间点对点传音频，不经服务器中转）
- 桌面端：Electron 45 封装（整个目录约 356MB），托盘常驻、菜单切换服务器、内置离线本机服务器
- 中文界面，暗色主题，桌面端优先

![桌面端：连接官方服务器后的语音频道](docs/screenshots/10-desktop-remote.png)

## 功能

**语音**
- 语音频道 **双击进入**（单击只选中、不加入，避免误触），多人实时语音（WebRTC mesh，同一频道建议 ≤ 8 人）
- **频道栏直接展开成员列表**：语音频道下方显示当前频道里的所有人（头像、昵称、静音/闭音状态、说话高亮）
- **人数上限**：右键语音频道 →「编辑频道」可设 0–100（0 = 不限），频道栏显示 `当前人数/上限`（如 `04/50`）
- 说话高亮：谁在说话，头像自动亮起绿色光环
- 麦克风处理链：高通滤波（去低频轰鸣）→ 压缩器（稳定音量）→ 噪声门（语音感应/按键说话）
- 回声消除 / 噪声抑制 / 自动增益（浏览器原生）
- 麦克风静音、闭音（不接收他人声音），状态实时同步给所有人
- 输入模式：**语音感应**（可调灵敏度 + 实时电平条）或**按键说话**（支持键盘任意键、鼠标侧键）
- **麦克风监听（自听）**：设置里可把麦克风和效果回放到本机扬声器/耳机，用于测试设备（建议戴耳机，外放可能啸叫）
- 设备选择：麦克风 / 扬声器分别可选，切换即时生效
- 断线自动重连，重连后自动回到原来的语音频道

**文字**
- 文字频道实时聊天、消息历史（服务端持久化，滚动不丢）
- 语音频道内置文字聊天（和 Discord 一致）
- 轻量 Markdown：`**粗体**`、`*斜体*`、`~~删除线~~`、`` `代码` ``、代码块、自动链接
- 系统消息：谁加入了 / 离开了语音频道

**频道与服务器**
- 多服务器（左侧竖栏切换）、每台服务器多语音/文字频道
- 创建 / 删除频道、创建 / 删除服务器
- **右键语音频道**：加入语音 / 编辑频道（名称 + 人数上限）/ 删除频道
- 成员列表按「语音中 / 在线」分组，显示所在频道

**桌面端（Windows）**
- 绿色免安装：复制 `dist\Deepscord-win32-x64` 整个目录即可运行，不需要安装 Node.js
- 启动页二选一：「连接服务器」连远程（官方 / 自建），「启动本机服务器」离线用本机
- 菜单 **文件 → 切换服务器…**（`Ctrl+Shift+S`）随时换服务器，`Ctrl+R` 重新连接
- 关闭窗口不退出，隐藏到系统托盘；托盘单击显示 / 隐藏，右键菜单可切换服务器或退出
- 单实例运行：重复双击 exe 只会聚焦已经打开的窗口

**其他**
- 昵称 + 头像颜色，本地记住
- **访问口令**：设置 `ECHO_PASSWORD` 后进入需要口令，连续输错 5 次自动限流 1 分钟
- 快捷键：`Ctrl+Shift+M` 静音、`Ctrl+Shift+D` 闭音
- 提示音（加入 / 离开 / 新消息），可在设置里关闭
- 延迟显示、连接状态提示
- 设置全部本地保存

## 快速开始

### 方式一：Windows 桌面软件（推荐）

1. 双击 **`dist\Deepscord-win32-x64\Deepscord.exe`**
   （整个目录约 **356MB**，内含 **Electron 45** 运行时；绿色免安装，**不需要装 Node.js**）
2. 首次启动进入工作区，通过添加入口选择创建或加入，再选择 Steam、独立直连或自建服务器。
3. 自建服务器地址及访问口令由服主单独提供；客户端不预置地址或口令。遇到自签证书提示时，请先核对服主提供的证书指纹。
4. 欢迎页填写**昵称**，进入后点左侧语音频道加入通话。

> Windows 对未签名 exe 可能弹「Windows 已保护你的电脑」：点「更多信息 → 仍要运行」即可。
> 菜单 **文件 → 切换服务器…** 可管理保存的服务器；以后启动恢复上次使用的服务器。

### 方式二：网页版 / 本机运行（需要 Node.js）

要求：**Node.js 18+**（推荐 20/22/24），现代浏览器（Chrome / Edge / Firefox）。

1. 双击 **`start.bat`**（或在命令行运行 `node server.js` / `npm start`）
2. 浏览器会自动打开 <http://localhost:3000>
3. 输入昵称进入，点左侧语音频道即可开麦说话
4. 同一台电脑再开一个浏览器标签页（用隐身窗口区分昵称）就能自己和自己测试

> 端口被占用时：`set PORT=3100 && node server.js`

网页版界面（本机运行）：

![网页版语音频道](docs/screenshots/02-voice-channel.png)

## Windows 桌面软件

桌面端没有另写一套界面：Electron 加载的就是同一个网页应用（`desktop/` 只是外壳），
频道、语音、聊天逻辑与网页版完全一致，额外提供服务器选择、系统托盘和内置的离线服务器。

### 位置与产物

| 项目 | 说明 |
| --- | --- |
| 可执行文件 | `dist\Deepscord-win32-x64\Deepscord.exe` |
| 目录大小 | 约 **356MB**（Electron 45 运行时 + 应用资源；exe 本体约 238MB） |
| 安装方式 | **绿色免安装**，复制整个 `Deepscord-win32-x64` 目录到任意位置双击即可 |
| 依赖 | 不需要安装 Node.js，不需要管理员权限 |
| 版本 | `1.0.0`（启动页右下角显示 `v1.0.0 · Electron 45.2.2`） |

`dist/` 和 `desktop/app-server/` 都是构建产物，已在 `.gitignore` 里忽略。

### 两种运行模式

| 模式 | 适合场景 | 连接地址 |
| --- | --- | --- |
| 连接自建服务器 | 和朋友一起用，或连接自己的公网部署 | 填写服主提供的域名 / IP，无预置地址 |
| 启动本机服务器 | 没网、单机测试、演示 | `http://127.0.0.1:38480/`（只监听本机） |

![桌面端启动页：连接服务器 / 启动本机服务器](docs/screenshots/11-desktop-launcher.png)

![桌面端本机服务器模式](docs/screenshots/12-desktop-local.png)

### 连接自建服务器

在加入界面选择自建服务器，输入服主提供的地址；如服务器要求访问口令，再按提示填写。应用不预置公共服务器，也不预置信任任何公共主机。自签证书需核对指纹后确认；已经保存的证书发生变化时，连接会被阻止。

### 切换服务器

- 菜单 **文件 → 切换服务器…**（`Ctrl+Shift+S`）回到启动页；也可以从托盘右键菜单进入
- 在启动页输入服务器地址后点「连接服务器」；地址不写协议时自动补 `https://`
- 连 **自签证书的 HTTPS 服务器**时，会弹「是否信任此服务器的 HTTPS 证书？」：选「信任并连接」，
  该主机会记到 `%APPDATA%\Deepscord\config.json` 的 `trustedHosts`，以后不再询问
- 菜单 **文件 → 重新连接**（`Ctrl+R`）或 `F5` 重新加载当前页面
- 地址填错 / 服务器没开时，会自动回到启动页并显示错误信息（例如 `无法连接到服务器`）

### 启动本机服务器（离线）

在启动页点 **「启动本机服务器」**，主进程会用 Electron 自带的 Node 运行时拉起一份完整服务端：

- 地址固定 **`http://127.0.0.1:38480/`**，`HTTP_HOST=127.0.0.1`、关闭 HTTPS，**只有本机能连**
- 服务端就是仓库里的 `server.js`（打包时由 `tools/sync-appserver.cjs` 同步到 `desktop/app-server/`）
- 频道、聊天记录、系统消息与正式服务器一致；本机模式不需要访问口令
- 数据单独保存在 `%APPDATA%\Deepscord\local-data`，和远程服务器互不影响
- 如果 38480 上已经有一份健康的本机服务，会直接复用；桌面端退出时内置服务器一并结束

### 托盘 / 关闭窗口 / 单实例

- 点窗口右上角关闭：**不退出程序**，窗口隐藏到系统托盘（首次会弹气泡提示「仍在运行」）
- 托盘图标单击 = 显示 / 隐藏窗口；托盘右键 = 显示、切换服务器…、退出
- 真正退出：菜单 **文件 → 退出 Deepscord**（`Alt+F4`）或托盘右键「退出」
- 桌面端只允许开一个实例：再次双击 `Deepscord.exe` 会把已有窗口显示出来并聚焦

### 数据目录

```
%APPDATA%\Deepscord\
├─ config.json     # 上次的服务器地址、是否自动连接、已信任的证书主机
└─ local-data\     # 「启动本机服务器」的频道与聊天记录（data/store.json）
```

删掉整个 `%APPDATA%\Deepscord` 即可重置桌面端（下次启动重新走首次连接流程）。
测试或便携使用可以用环境变量 `DEEPSCORD_USER_DATA` 指定别的数据目录。

### 桌面端快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+Shift+M` | 静音 / 取消静音（和网页版一致） |
| `Ctrl+Shift+D` | 闭音（不接收他人声音） |
| `Ctrl+Shift+S` | 切换服务器… |
| `Ctrl+R` | 重新连接（重新加载页面） |
| `F5` | 刷新 |
| `Ctrl+W` | 隐藏到托盘 |
| `Alt+F4` | 退出 Deepscord |

### 重新打包

```powershell
npm install            # 安装 electron + @electron/packager（devDependencies）
npm run desktop:build  # 同步服务端文件 + electron-packager 打包
```

- `desktop:build` 等于 `npm run desktop:sync && electron-packager ...`：
  `tools/sync-appserver.cjs` 把 `server.js`、`lib/`、`public/` 复制到 `desktop/app-server/`，
  再用 `@electron/packager` 输出到 `dist\Deepscord-win32-x64\`
- 产物：`dist\Deepscord-win32-x64\Deepscord.exe`（整个目录约 356MB）；
  打包参数为 `--platform=win32 --arch=x64 --asar=false`（不打包 asar，便于排查），
  应用图标取 `desktop/assets/icon.ico`
- 开发调试：`npm run desktop:dev`（同步后用本地 electron 启动，不打包）
- 图标：`tools/make_icon.py`（Pillow 生成紫色渐变 + 声波图标，输出 `desktop/assets/icon.png` 和 `icon.ico`）

> 只改网页端代码时，要重新 `npm run desktop:build` 才会进 exe；
> 开发阶段建议用 `npm run desktop:dev`，改完刷新窗口即可。

### 两个版本：完整版（主力）与轻量版（搁置）

| | 完整版（当前主力） | 轻量版（原型，已搁置） |
| --- | --- | --- |
| 内核 | 内置 Chromium + Node（Electron） | 调用系统自带 WebView2（Edge 内核） |
| 体积 | exe 237.9 MB，目录约 357 MB | 预计 exe < 100 KB，目录约 2 MB |
| 离线本机服务器 | ✅ 内置 | ❌ 需另带 Node |
| 托盘常驻 / 单实例 / 离线 | ✅ | ❌ |
| 依赖 | 无（绿色免安装） | 需系统 WebView2 运行时（Win10/11 通常自带） |
| 状态 | **继续开发，随版本发布** | 仅保留原型代码：`desktop-lite/`、`tools/build-lite.ps1` |

Electron 版体积大是 Chromium 内核本身造成的（Discord 桌面端同理），不是安装包里的垃圾文件。
轻量版方案见 [`desktop-lite/README.md`](desktop-lite/README.md)，当前先搁置、暂不构建发布。

## 局域网 / 多设备使用

浏览器只在 **HTTPS 或 localhost** 下允许麦克风，所以别的电脑 / 手机访问时需要用 HTTPS：

1. 双击 **`enable-lan.bat`**：自动用 Git 自带的 openssl 生成自签名证书（含本机局域网 IP），启动 HTTPS 服务
2. 首次运行会问是否把证书加入「当前用户受信任根证书」，选 `Y` 可免去浏览器警告
3. 其他设备访问脚本里提示的 `https://<你的局域网IP>:3443`，在浏览器弹窗允许麦克风即可

> 也可以在 Chrome 打开 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`，
> 把 `http://<IP>:3000` 加进白名单，作为不想装证书的临时方案。

## 部署到服务器（公网 / 异地多人）

有台公网服务器的话，部署后任何地方的人打开网页就能用。**语音本身是 P2P 直连的**，服务器只承担
「页面 + 信令 + 聊天记录」，所以 1 核 1G 的小机器即可；只有双方都在严格 NAT 后面时才需要 TURN 中继
（此时音频会经过服务器，消耗带宽）。

部署完成后，桌面端在启动页填上这个地址即可连接（自签证书会弹信任确认，选「信任并连接」）。

**方式一：Docker Compose + Caddy（推荐，自动 HTTPS）**

```bash
# 1. 域名 A 记录解析到服务器 IP（有域名才需要；没有域名看方式三）
# 2. 上传项目目录到服务器后：
export ECHO_DOMAIN=voice.example.com
docker compose up -d --build
```

- Caddy 会自动申请 Let's Encrypt 证书并反代（自动处理 WebSocket 升级）
- 数据持久化在 `./data`（频道与聊天记录）
- 打开 `https://voice.example.com` 即可

**方式二：不装 Docker（Node + Nginx + systemd）**

```bash
# 上传项目目录到服务器，例如 /opt/deepscord
sudo cp -r . /opt/deepscord
# 参考 deploy/deepscord.service：按需修改用户 / 路径后安装，
# 部署前先按实际目录统一改好，再安装
sudo cp deploy/deepscord.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now <服务名>
# 再按 deploy/nginx.conf 配 HTTPS 反向代理
```

**方式三：没有域名**

- 直接用公网 IP + 自签证书：`enable-lan.bat`（Linux 可用 `openssl req -x509 ...` 生成到 `certs/`），
  浏览器访问会提示不安全，点「继续前往」后麦克风权限可用（仍是安全上下文）；桌面端则弹「信任并连接」
- 或用 Cloudflare Tunnel / frp 之类的内网穿透，把 `http://localhost:3000` 映射成 HTTPS 域名

**方式四：Windows 云服务器（WinRM 远程部署，已实测）**

适用于腾讯云 / 阿里云的 Windows Server（无 Docker、无 SSH 时）：

```powershell
# 1. 服务器上开启 WinRM（管理员 PowerShell）：
Enable-PSRemoting -Force
# 2. 本机信任该服务器：
Set-Item WSMan:\localhost\Client\TrustedHosts -Value '<服务器IP>' -Force
# 3. 打包：server.js + lib + public + package.json + certs（用公网 IP 生成 SAN）
#    run-deepscord.bat 里配置 PORT / HTTP_HOST=127.0.0.1 / HTTPS_PORTS=443,3443 / ECHO_PASSWORD / STUN_URLS
# 4. 通过 WinRM 上传、解压到 C:\Deepscord，注册开机自启计划任务（SYSTEM）：
#    schtasks /Create /TN Deepscord /TR "C:\Deepscord\run-deepscord.bat" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
# 5. Node 用官方 zip 解压到 C:\node，run-deepscord.bat 用 ping 循环守护进程
```

后续改完代码，本地执行 `deploy\windows\update.ps1 -ComputerName <IP>` 即可增量更新并重启。

**NAT 严格时加 TURN（跨运营商、手机热点常见）**

```bash
# 服务器上：改 deploy/coturn.conf 里的 external-ip 和密码
sudo apt install coturn && sudo cp deploy/coturn.conf /etc/turnserver.conf
sudo systemctl enable --now coturn   # 放行 3478/tcp+udp、49160-49200/udp

# Deepscord 服务端环境变量：
TURN_URL=turn:你的公网IP:3478
TURN_USERNAME=deepscord
TURN_CREDENTIAL=换成强密码
```

**容量建议**

- 1 核 1G + 2~3 Mbps 上行：纯信令/聊天，几十人同时在线没问题
- 语音 P2P：每个语音频道 ≤ 8 人（mesh）；人更多需要 SFU（未内置）
- 开 TURN 后按中转带宽算：1 路音频约 40~60 kbps，双向各一份

## 使用说明

| 操作 | 说明 |
| --- | --- |
| 单击频道 | 选中 / 查看该频道（**不会**加入语音） |
| **双击语音频道** | 加入该语音频道（同时打开它的文字聊天） |
| 双击文字频道 | 打开并聚焦输入框 |
| 语音舞台「断开」 | 离开语音频道，释放麦克风 |
| 左下角麦克风图标 | 静音 / 取消静音（对方会看到「已静音」） |
| 左下角耳机图标 | 闭音（不接收他人声音，同时静音自己） |
| 齿轮 / 设置 | 昵称、头像颜色、设备、音量、输入模式、灵敏度、按键、**监听麦克风** |
| 设置 → 监听麦克风 | 开启后能听到自己的麦克风（自听测试）；建议戴耳机，外放可能啸叫 |
| **右键语音频道** | 加入语音 / 编辑频道（名称 + 人数上限）/ 删除频道 |
| 右键文字频道 | 编辑频道（名称）/ 删除频道 |
| 频道栏成员列表 | 语音频道下方列出当前频道所有人；说话时头像亮绿环 |
| `Enter` / `Shift+Enter` | 发送 / 换行 |
| 桌面端菜单 **文件** | 切换服务器 / 重新连接 / 隐藏到托盘 / 退出 |
| 桌面端托盘图标 | 单击显示 / 隐藏窗口，右键切换服务器或退出 |

**人数上限**：右键语音频道 →「编辑频道（名称 / 人数上限）…」，设为 `0` 表示不限；达到上限后其他人双击进入会提示「人数已满」，频道栏显示 `当前/上限`（如 `04/50`）。

**按键说话**：设置 → 输入模式选「按键说话」→ 点「说话按键」后按下你想用的键（如 `V`、`Caps`、鼠标侧键），按住说话、松开静音。

### 语音频道成员列表 / 人数上限

![频道栏语音成员与人数上限](docs/screenshots/13-channel-members.png)

双击语音频道进入后，成员直接列在频道下方。频道右侧操作按钮或右键菜单可复制邀请；具有管理权限的成员可修改名称和人数上限（0 = 不限，最大 100）。域管理员只管理授权域，服主和服务器管理员可跨域管理。频道栏显示实际「当前人数/上限」，降低上限不会踢出现有成员。

### 开发检查

使用 Node.js 24，执行 `npm ci --ignore-scripts`、`npm --prefix desktop ci --omit=dev --ignore-scripts`、`npm run test:ci`、`npm run typecheck`。CI 会先同步桌面内置服务，再在 Windows/Linux 运行本地回归；不启动 Steam 原生客户端或访问真实电台。浏览器界面、桌面确认窗口和跨设备音视频验收另行执行，CI 通过不能代替这些验证。桌面实际运行/打包仍需要 Electron 与相应原生组件，不能使用仅用于 CI 的安装目录直接发包。

## 技术架构

```
┌──────────── 浏览器 A ────────────┐          ┌──────────── 浏览器 B ────────────┐
│  UI (原生 ES Module)             │          │                                  │
│   ├─ 频道/聊天/成员渲染           │          │                                  │
│   ├─ Web Audio 麦克风处理链       │          │                                  │
│   └─ RTCPeerConnection ──────────┼──┐       │                                  │
└──────────────┬───────────────────┘  │ P2P   │                                  │
               │ WebSocket JSON       │ 音频  │                                  │
               ▼                      ▼       ▼                                  │
        ┌──────────────────────────────────────────────┐                          │
        │  Node 服务端（零依赖）                        │                          │
        │  ├─ HTTP 静态资源 + /api/health、/api/config  │                          │
        │  ├─ 自实现 RFC6455 WebSocket（帧/分片/心跳）  │                          │
        │  ├─ 用户/频道/语音状态 + 信令中继             │                          │
        │  └─ 聊天历史持久化 data/store.json            │                          │
        └──────────────────────────────────────────────┘                          │
                           ▲                                                       │
                           └───────────────────────────────────────────────────────┘
```

- **信令**：加入频道后，服务端把已有成员列表发给新加入者，由新加入者逐个发起 `RTCPeerConnection` offer，服务端只中继 SDP/ICE（不接触音频）
- **音频**：mesh 直连（host candidates），局域网内低延迟；跨公网/复杂网络可配置 TURN（见下）
- **音频处理**：`麦克风 → 高通 85Hz → 动态压缩 → 增益 → 噪声门 → MediaStreamDestination → WebRTC`
- **说话检测**：每 80ms 计算一次波形 RMS，分贝阈值 + 迟滞，控制噪声门开合，同时驱动 UI 高亮
- **桌面端外壳**：`desktop/main.js` 主进程负责窗口、菜单、托盘、证书信任和本机服务器生命周期；渲染进程就是同一套网页；`preload.js` 只用 `contextBridge` 暴露 `getConfig / connect / startLocal / back / openExternal / quit` 几个方法（`contextIsolation: true`、`nodeIntegration: false`）
- **桌面端离线模式**：主进程用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动 `desktop/app-server/server.js`，固定 `127.0.0.1:38480`，`/api/health` 通过后再加载页面；应用退出时一并结束子进程
- **证书策略**：没有默认信任的公共主机；自签证书需经指纹核对后确认，确认后的证书发生变化会阻止连接。

## 项目结构

```
deepscord/
├─ server.js                  # HTTP + WebSocket 服务端（状态、信令、历史）
├─ lib/ws.js                  # 零依赖 RFC6455 WebSocket 实现
├─ public/
│  ├─ index.html
│  ├─ app.css
│  └─ js/
│     ├─ app.js               # 应用主逻辑、渲染、交互
│     ├─ voice.js             # 语音引擎（麦克风链 / mesh / 说话检测）
│     ├─ settings.js          # 设置面板
│     ├─ ws.js                # WebSocket 客户端（重连 / 延迟）
│     ├─ ui.js                # 模态框、Toast、菜单
│     ├─ icons.js             # 内联 SVG 图标
│     └─ util.js              # 工具函数
├─ desktop/                   # Electron 桌面端（Windows）
│  ├─ main.js                 # 主进程：窗口 / 菜单 / 托盘 / 证书信任 / 本机服务器
│  ├─ preload.js              # contextBridge：最小 preload API
│  ├─ bootstrap.html          # 启动页：连接服务器 / 启动本机服务器
│  ├─ package.json            # 桌面端包信息（productName: Deepscord）
│  ├─ assets/                 # icon.png / icon.ico
│  └─ app-server/             # 打包时生成：server.js + lib + public 的副本（git 忽略）
├─ desktop-lite/              # 轻量版原型（WebView2，已搁置）：Program.cs / version.rc / app.manifest
├─ tools/
│  ├─ sync-appserver.cjs      # 把网页端复制到 desktop/app-server
│  ├─ make_icon.py            # 生成应用图标（Pillow）
│  ├─ migrate-store.cjs       # 迁移旧数据的服务器 / 频道名称
│  ├─ cleanup-brand.cjs       # 一次性旧品牌清理（历史工具）
│  ├─ rename-brand.cjs        # 一次性品牌重命名脚本（历史工具）
│  └─ build-lite.ps1          # 轻量版构建脚本（WebView2 SDK + csc，搁置）
├─ test/
│  ├─ smoke.mjs               # 后端协议冒烟测试（Node WS 客户端）
│  ├─ auth.mjs                # 访问口令 / 暴力尝试限流测试
│  ├─ ui.mjs                  # 界面交互测试（欢迎页/设置/频道管理/HTTPS 互通）
│  ├─ e2e.mjs                 # 浏览器端到端测试（两个 Chrome + 假麦克风 + 截图）
│  ├─ desktop-check.mjs       # 桌面端验证（CDP 驱动，14 项）
│  ├─ deploy-check.mjs        # 公网部署验证（HTTPS + 口令 + wss + 麦克风）
│  └─ cdp.mjs                 # 极简 Chrome DevTools Protocol 客户端
├─ deploy/                    # 部署模板：Caddy / Nginx / systemd / TURN / WinRM 更新脚本
├─ Dockerfile / docker-compose.yml
├─ docs/screenshots/          # 界面与桌面端截图
├─ dist/                      # 打包产物：Deepscord-win32-x64\Deepscord.exe（约 356MB，git 忽略）
├─ data/store.json            # 运行时生成：频道与聊天记录
├─ certs/                     # enable-lan.bat 生成：HTTPS 证书
├─ start.bat                  # 双击启动（HTTP，本机）
├─ enable-lan.bat             # 双击启动（HTTPS，局域网/手机）
└─ package.json               # 脚本：start / test:* / desktop:sync / desktop:dev / desktop:build
```

## 测试

```powershell
node server.js                 # 先启动服务
node test/smoke.mjs            # 后端协议：24 项（含频道人数上限 / 编辑频道 / 限流）
node test/e2e.mjs              # 浏览器端到端：23 项（自动开两个 Chrome、假麦克风、WebRTC 连通、聊天、静音同步、侧栏成员列表、截图）
node test/ui.mjs               # 界面交互：31 项（欢迎页、设置、改名、PTT、双击进入语音、麦克风监听、右键编辑/删除频道、HTTPS 互通）
node test/auth.mjs             # 访问口令：10 项（自动拉起带口令的独立实例）
node test/deploy-check.mjs     # 公网部署验证：12 项（部署后用浏览器实测 HTTPS/wss/口令/麦克风）
```

桌面端是单独一套（CDP 驱动，共 **14 项**），需要先把 `Deepscord.exe` 打包出来：

```powershell
# 1. 关掉已在运行的桌面端（单实例会复用旧窗口，导致新参数不生效）
Get-Process Deepscord -ErrorAction SilentlyContinue | Stop-Process -Force

# 2. 清掉这个环境变量：有它时 Electron 会被当成 Node 运行，不开窗口
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# 3. 带远程调试端口启动桌面端，并保持窗口开着
& ".\dist\Deepscord-win32-x64\Deepscord.exe" --remote-debugging-port=9331

# 4. 另开一个终端运行验证（会依次走一遍「远程服务器」和「内置本机服务器」）
node test/desktop-check.mjs
```

> 桌面端会把昵称和上次连接的服务器记在本机数据目录里：在同一份数据上重复跑，欢迎页不会出现，
> 「首次进入显示欢迎页」相关的 2 项会失败。想完整复现，先删掉 `%APPDATA%\Deepscord`，
> 或启动前把 `DEEPSCORD_USER_DATA` 指向一个空目录。

覆盖内容：欢迎页 / 远程页面加载 / wss 连接 / preload API 注入 / 默认服务器配置 / 频道列表渲染 /
启动页品牌与预填地址 / 本机服务器启动、健康检查、默认频道 / 无脚本错误。

- 远程口令从 `%TEMP%\echo-deploy\access-password.txt`、项目根目录的 `access-password.txt`
  或环境变量 `ECHO_PASSWORD` 读取（都没有就留空，官方服务器要求口令时测试会失败）
- 调试端口默认 `9331`，可用 `DESKTOP_CDP_PORT` 覆盖
- 测试会刷新 `docs/screenshots/10-desktop-remote.png`、`11-desktop-launcher.png`、`12-desktop-local.png`

端到端测试会把截图写到 `docs/screenshots/`，并检查页面无脚本错误。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | HTTP 端口 |
| `HTTP_HOST` | 0.0.0.0 | HTTP 监听地址（公网部署建议 127.0.0.1） |
| `HTTPS_PORTS` | 3443 | HTTPS 端口，可逗号分隔多端口（如 `443,3443`） |
| `ECHO_PASSWORD` | 空 | 访问口令；设置后进入需输入，输错 5 次限流 1 分钟 |
| `ECHO_DATA_DIR` | ./data | 数据目录 |
| `ECHO_DOMAIN` | localhost | Docker Compose + Caddy 部署时使用的域名 |
| `HISTORY_LIMIT` | 300 | 每个频道保留的历史消息条数 |
| `STUN_URL` | 无 | 例如 `stun:stun.l.google.com:19302` |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | 无 | 跨公网使用时配置 TURN 中继 |

示例：

```powershell
$env:PORT=3100
$env:STUN_URL="stun:stun.l.google.com:19302"
node server.js
```

> `ECHO_` 前缀是历史命名（保证旧部署和旧数据能继续用），不是笔误；改名会破坏现有部署。
> 桌面端另有 `DEEPSCORD_USER_DATA`：指定桌面端数据目录（默认 `%APPDATA%\Deepscord`，用于测试 / 便携）。

## 常见问题

**打开页面没有声音 / 麦克风没权限？**
- 检查浏览器地址栏左侧的相机/麦克风权限，允许后刷新
- 必须用 `http://localhost` 或 `https://` 访问；用 `http://192.168.x.x` 访问时浏览器会禁用麦克风
- 桌面端遇到同样问题：Windows 设置 → 隐私和安全性 → 麦克风 → 允许「桌面应用」访问

**同一台电脑测试多人？**
- 用「隐身窗口」或另开一个浏览器（否则共用同一份昵称设置）；也可以访问 `http://localhost:3000/?name=小明` 直接指定昵称
- 桌面端和浏览器可以同时在线，互相当作不同成员

**别人听不到我？**
- 看设置里的「当前输入」电平条是否有跳动
- 语音感应模式下声音太小可能不触发，把「感应灵敏度」往左拖，或改用按键说话

**最多多少人？**
- mesh 拓扑下每人都与其他所有人建立连接，建议一个语音频道 ≤ 8 人；更大规模需要 SFU（如 mediasoup / LiveKit），本项目未包含

**Windows 防火墙弹窗？**
- 允许 Node.js 通过专用网络，否则局域网其他设备连不上

**桌面端双击没反应 / 找不到窗口？**
- 桌面端是单实例的：可能已经在托盘里，点任务栏右下角托盘的 Deepscord 图标即可显示
- 如果被「Windows 已保护你的电脑」拦住：点「更多信息 → 仍要运行」

**关闭窗口后任务管理器里还有 Deepscord.exe？**
- 这是正常的：关闭窗口只是隐藏到托盘，语音和连接仍在保持；要彻底退出请用菜单 **文件 → 退出 Deepscord** 或托盘右键「退出」

**「启动本机服务器」失败？**
- 多半是 `38480` 端口被占用（常见于上一次的进程没退干净）：任务管理器里结束所有 `Deepscord.exe` 后重试
- 本机数据在 `%APPDATA%\Deepscord\local-data`，删掉会重置本机频道和聊天记录

**桌面端能连别人部署的服务器吗？**
- 能：菜单 **文件 → 切换服务器…**，填 `https://你的域名/IP/` 后连接；自签证书会弹一次「是否信任」，选「信任并连接」

## 已知限制 / 路线图

- [ ] 屏幕共享（需要重新协商：`replaceTrack` + renegotiation）
- [ ] SFU 模式，支持 20+ 人频道
- [ ] 服务器密码 / 邀请码 / 权限角色
- [ ] 消息 @提醒、表情回应、文件粘贴
- [ ] 端到端加密（当前局域网内 WebRTC 本身已加密 DTLS-SRTP，服务器不接触音频）
- [ ] 桌面端自动更新与安装包（NSIS / MSI，目前是绿色免安装）
- [ ] 桌面端代码签名（解决 SmartScreen 拦截；目前未签名）
- [ ] macOS / Linux 打包（Electron 配置本身跨平台，目前只提供 Windows x64）

## 设计说明

为什么零依赖？因为「下载就能跑」对语音软件很重要：不需要 `npm install`、不担心依赖供应链、单文件服务端几百行，方便改。WebSocket 服务端只是标准帧解析，用了约 300 行实现，协议测试覆盖了握手、分片、ping/pong、关闭。

界面刻意保留 Discord 的信息结构（服务器竖栏 / 频道列表 / 主区 / 成员栏），但视觉上做了更暗、更克制的处理：低饱和底色、单一紫色强调色、说话时用绿色光环而不是彩色头像堆叠。

桌面端没有再写一套 UI：Electron 直接加载同一份网页，主进程只做浏览器给不了的几件事——窗口 / 托盘 / 菜单、自签证书的信任策略，以及离线模式下拉起一份本机 Node 服务器（`ELECTRON_RUN_AS_NODE=1` 复用 Electron 自带的 Node，不额外打包运行时）。打包用 `@electron/packager` 加一个同步脚本，不引入构建工具链，和「零依赖、下载就能跑」的取舍一致。

## License

MIT

