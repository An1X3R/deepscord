# Deepscord 轻量版构建脚本（C# WinForms + WebView2，不内置 Chromium）
# 用法: powershell -ExecutionPolicy Bypass -File tools\build-lite.ps1
param(
    [switch]$SkipDownload
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cache = Join-Path $root 'tools\cache\webview2-sdk'
$outDir = Join-Path $root 'dist\Deepscord-Lite'
$buildDir = Join-Path $root 'desktop-lite\build'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'

if (-not (Test-Path $csc)) { throw "找不到 .NET Framework 编译器: $csc" }

# ---------- 1. WebView2 SDK ----------
if (-not (Test-Path (Join-Path $cache 'lib\net462\Microsoft.Web.WebView2.Core.dll'))) {
    if ($SkipDownload) { throw "WebView2 SDK 未缓存，且指定了 -SkipDownload" }
    Write-Host '== 下载 WebView2 SDK =='
    $index = Invoke-RestMethod 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/index.json' -TimeoutSec 30
    $version = ($index.versions | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -Last 1)
    Write-Host "版本: $version"
    $nupkg = Join-Path $env:TEMP 'microsoft.web.webview2.nupkg'
    $zip = Join-Path $env:TEMP 'microsoft.web.webview2.zip'
    Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg" -OutFile $nupkg -UseBasicParsing -TimeoutSec 180
    Copy-Item $nupkg $zip -Force
    Remove-Item $cache -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    Expand-Archive -Path $zip -DestinationPath $cache -Force
}

$coreDll = Join-Path $cache 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$winformsDll = Join-Path $cache 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
$loaderDll = Join-Path $cache 'runtimes\win-x64\native\WebView2Loader.dll'
foreach ($f in @($coreDll, $winformsDll, $loaderDll)) {
    if (-not (Test-Path $f)) { throw "缺少 WebView2 SDK 文件: $f" }
}

# ---------- 2. 版本资源（图标 + 版本信息） ----------
$rc = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter 'rc.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\rc\.exe$' } | Select-Object -First 1
if (-not $rc) { throw '找不到 rc.exe（Windows SDK）' }

Remove-Item $buildDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
Push-Location (Join-Path $root 'desktop-lite')
try {
    & $rc.FullName /nologo /fo (Join-Path $buildDir 'version.res') version.rc
    if ($LASTEXITCODE -ne 0) { throw 'rc.exe 编译版本资源失败' }
} finally {
    Pop-Location
}

# ---------- 3. 编译 ----------
Remove-Item $outDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$args = @(
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    '/codepage:65001',
    "/out:$outDir\Deepscord.exe",
    "/win32res:$(Join-Path $buildDir 'version.res')",
    "/win32manifest:$(Join-Path $root 'desktop-lite\app.manifest')",
    "/r:$fw\System.dll",
    "/r:$fw\System.Core.dll",
    "/r:$fw\System.Drawing.dll",
    "/r:$fw\System.Windows.Forms.dll",
    "/r:$coreDll",
    "/r:$winformsDll",
    (Join-Path $root 'desktop-lite\Program.cs')
)
& $csc @args
if ($LASTEXITCODE -ne 0) { throw 'C# 编译失败' }

# ---------- 4. 运行时依赖 ----------
Copy-Item $coreDll, $winformsDll, $loaderDll -Destination $outDir -Force

$readme = @'
Deepscord 轻量版 — 说明

1. 双击 Deepscord.exe 启动。轻量版不内置浏览器，使用 Windows 自带的
   Microsoft Edge WebView2 内核（Win10/11 通常已预装）。若提示缺少 WebView2，
   请安装：https://go.microsoft.com/fwlink/?LinkId=2124703
2. 首次启动手动填写服主提供的服务器地址，不预置公共服务器。
   遇到证书提示时，请先与服主核对服务器证书。
3. 输入昵称 + 访问口令（由管理员提供）。
4. 菜单「文件 → 切换服务器…」可切换服务器地址。
5. 轻量版没有「内置本机服务器 / 托盘常驻 / 离线模式」；这些功能在完整版
   （Electron 版）中提供。

数据目录：%APPDATA%\DeepscordLite（服务器地址、已信任主机）
卸载：删除整个文件夹即可。
'@
[System.IO.File]::WriteAllText((Join-Path $outDir '使用说明.txt'), $readme, [System.Text.Encoding]::UTF8)

$sizeMb = [math]::Round(((Get-ChildItem $outDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 2)
Write-Host ''
Write-Host "== 构建完成: $outDir =="
Get-ChildItem $outDir -File | Select-Object Name, @{n = 'KB'; e = { [math]::Round($_.Length / 1KB, 1) } } | Format-Table -AutoSize
Write-Host "总大小: $sizeMb MB"
