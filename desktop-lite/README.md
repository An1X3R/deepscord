# 轻量版（WebView2）— 实验性，暂停中

**状态：先搁置。** 主力版本是 Electron（Chromium 内置）版：`dist\Deepscord-win32-x64\Deepscord.exe`。
这里保留轻量版原型代码，方便以后需要时继续。

## 为什么会有这个目录

Electron 版把 Chromium + Node 全塞进安装目录，约 **357 MB**（exe 本身 237.9 MB），这是 Electron 的固有体积。
轻量版不内置浏览器内核，调用 Windows 自带的 **Microsoft Edge WebView2**（Win10/11 通常已预装），
预计整个目录 **~2 MB**（exe 约 30–50 KB + WebView2 托管 DLL）。

## 当前实现

- `Program.cs`：C# WinForms + WebView2 宿主
  - 首次启动手动输入服主提供的地址，无预置公共服务器
  - 自动允许麦克风权限
  - 自签证书：首次弹窗信任，之后按主机记住
  - 菜单「文件 → 切换服务器…」，配置在 `%APPDATA%\DeepscordLite\server.txt`
- `version.rc`：图标 + 版本信息
- `app.manifest`：PerMonitorV2 DPI
- `..\tools\build-lite.ps1`：下载 WebView2 SDK → rc 编译资源 → csc 编译 → 复制运行时 DLL

## 与 Electron 版的差距（搁置的原因）

- 没有内置本机服务器（离线模式），必须连远程服务器
- 没有系统托盘常驻
- 依赖系统 WebView2 运行时（极老/精简系统可能需要额外安装）
- 目标框架为 .NET Framework 4.8（Windows 自带），但 WebView2 SDK 的托管程序集需要一起分发

## 如果以后要继续

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-lite.ps1
```

产物输出到 `dist\Deepscord-Lite\`。若编译报错，优先检查 WebView2 SDK 版本对应的 net462 程序集与
`WebView2Loader.dll` 是否齐全（脚本会自动从 nuget.org 下载缓存到 `tools\cache\webview2-sdk`）。
