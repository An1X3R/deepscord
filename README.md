# Deepscord

Deepscord 是面向小群组的语音与文字聊天软件。朋友可以通过 Steam 邀请临时开房，也可以在局域网直接连接，或加入一台长期在线的自建服务器。Windows 客户端提供完整功能，浏览器可以连接房间服务使用网页界面。

## 下载与加入

[下载 Windows 客户端、独立服务端和 Lanart 主题包](https://github.com/An1X3R/deepscord/releases/tag/snapshot-20261127)

| 想做什么 | 下载哪个附件 | 如何使用 |
| --- | --- | --- |
| 加入朋友的房间或自己开房 | `Deepscord-Performance-20261113.zip` | 完整解压到可写目录，双击 `Deepscord.exe`。包内已有运行时。 |
| 在 Windows x64 上长期托管 | `Deepscord-Standalone-Server-Performance-20261113.zip` | 解压到固定目录，运行 `start-server.cmd`，按包内 README 配置对外地址、端口和访问口令。 |
| 使用 Lanart 主题 | `Deepscord-Lanart-Theme-20261116.zip` | 在客户端设置中打开“资源管理（主题与表情）”，选择“安装 ZIP 包”，然后在本机界面方案中选用。 |

首次打开客户端，在工作区选择**创建服务器**或**加入服务器**。收到邀请的成员选择对应的连接方式并粘贴邀请；连接自建服务器时填写服主给出的 HTTPS 地址和口令。服务器中可以切换域，每个域有自己的频道。进入语音后，还可以切到文字频道发消息。

## 怎么选连接方式

| 方式 | 适用场景 | 连接条件 |
| --- | --- | --- |
| 独立直连 | 局域网，或成员之间网络可达 | 一位成员用 Windows 客户端开房。其他人需要能访问房主的房间 TCP 端口，成员间还需要可用的 UDP 通路。 |
| Steam 牵线 | 两位或多位 Steam 好友临时开房 | 各自登录 Steam、运行同版客户端，通过邀请加入。Steam 负责房间发现与信令，语音走 WebRTC 直连。当前测试版使用示例 AppID `480`。 |
| 自建服务器 | 固定社群、长期保存频道，或需要中继 | 独立服务端维护房间和历史。管理员可配置 TURN 中继语音，也可单独启用 LiveKit SFU 转发屏幕。 |

如果 Steam 邀请能进房、语音却连不上，请分别检查房间连接和成员间的媒体通路。部署参数、证书指纹、TURN 和屏幕转发配置见[网络说明](NETWORKING.md)。Windows 服务端的启动、升级与数据迁移见[独立服务端指南](standalone/README.md)。

## 在频道里能做什么

- **语音与伴奏**。使用语音感应或按键说话，单独调节某位成员的音量。Windows 客户端可以捕获指定进程或系统声音，作为独立伴奏发送。
- **屏幕分享**。分享一个窗口或整块屏幕，设置分辨率、帧率与码率。其他成员从分享者的名片进入观看；收到对方同意后，可以在画面上指点。
- **文字与电台**。文字频道支持消息、回复、图片和表情回应。电台频道可以边听直播流边通话，并保存常用电台。
- **服务器与自定义**。服主、服务器管理员、域主和域管理员按范围管理频道与成员，也可以分配自定义权限组。界面主题只影响本机，服务器表情在各域共享。可安装的[示例资源包](mods/examples/)与[资源包开发指南](public/customization/RESOURCE_PACKS.md)均随源码提供。

服主可以用 Windows 客户端为房间启用内容加密并迁移历史。新成员获得带密钥的邀请后可以读取已迁移的历史；普通网页端无法解密这部分内容。邀请中含有密钥，请通过私下渠道发送。详见[桌面信任与隐私边界](NETWORKING.md#桌面信任与隐私边界)。

## 从源码运行

需要 **Node.js 22.13 或更高版本**。项目在 Node.js 24 上运行持续集成。进入仓库根目录，安装锁定依赖并启动房间服务。

```sh
npm ci --ignore-scripts
npm start
```

在本机浏览器打开 `http://localhost:3000`。默认数据目录是 `data/`，可用 `ECHO_DATA_DIR` 指定其他位置。异地成员通过浏览器使用麦克风时，应使用受信任的 HTTPS 地址。

开发检查与持续集成使用相同的桌面依赖。

```sh
npm --prefix desktop ci --omit=dev --ignore-scripts
npm run test:ci
npm run typecheck
```

要构建 Windows 客户端，还需准备原生辅助程序和匹配版本的 Electron 运行时。构建参数、产物清单和成品验证步骤见 [Windows 客户端打包](NETWORKING.md#windows-客户端打包)。

## 源码与文档

| 位置 | 用途 |
| --- | --- |
| [server.js](server.js)、[lib/](lib/) | HTTP、WebSocket、房间状态、权限、持久化与媒体策略 |
| [public/](public/) | 网页与桌面共用的频道界面、聊天和 WebRTC 逻辑 |
| [desktop/](desktop/) | Electron 主进程、Steam 接入、Windows 采集与覆盖层 |
| [desktop-lite/](desktop-lite/) | 已暂停开发的 WebView2 轻量原型，保留实现与试验记录 |
| [standalone/](standalone/)、[deploy/](deploy/) | 独立服务端发行模板、反向代理、TURN 与 SFU 配置 |
| [test/](test/)、[tools/](tools/) | 回归测试、资源同步、原生组件与发行包构建 |
| [设计说明](DESIGN_BRIEF.md)、[网络说明](NETWORKING.md) | 产品交互、模块边界、网络协议与部署 |
| [性能实测](docs/benchmarks/)、[历史交接与 QA](docs/archive/) | 各报告记录的版本、测试条件与结果 |
