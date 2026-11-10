# Deepscord · Windows 服务器增量更新脚本
#
# 用途：服务器上已经用「计划任务 + C:\Deepscord」部署过之后，本地改完代码，
#       运行本脚本把 server.js / lib / public 传上去并重启服务。
#
# 前置：服务器已启用 WinRM（5985），本机已把服务器加入 TrustedHosts：
#   Set-Item WSMan:\localhost\Client\TrustedHosts -Value '<服务器IP>' -Force
#
# 用法：
#   .\deploy\windows\update.ps1 -ComputerName 1.2.3.4
#   （会提示输入 Administrator 密码；也可传 -Credential）
#
# 注意：访问口令与端口等配置在服务器的 C:\Deepscord\run-deepscord.bat 里，本脚本不会覆盖它。

param(
    [Parameter(Mandatory = $true)][string]$ComputerName,
    [pscredential]$Credential,
    [string]$SourceDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$RemoteDir = 'C:\Deepscord',
    [string]$TaskName = 'Deepscord'
)

$ErrorActionPreference = 'Stop'

if (-not $Credential) {
    $Credential = Get-Credential -UserName 'Administrator' -Message "输入 $ComputerName 的管理员密码"
}

$session = New-PSSession -ComputerName $ComputerName -Credential $Credential -Authentication Negotiate
try {
    Write-Host "== 停止服务 =="
    Invoke-Command -Session $session -ScriptBlock {
        param($task)
        schtasks /End /TN $task 2>&1 | Out-Null
        Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 2
    } -ArgumentList $TaskName

    Write-Host "== 上传文件 =="
    Copy-Item -Path (Join-Path $SourceDir 'server.js'), (Join-Path $SourceDir 'package.json') -Destination $RemoteDir -ToSession $session -Force
    Copy-Item -Path (Join-Path $SourceDir 'lib'), (Join-Path $SourceDir 'public') -Destination $RemoteDir -ToSession $session -Recurse -Force

    Write-Host "== 启动服务 =="
    Invoke-Command -Session $session -ScriptBlock {
        param($task)
        schtasks /Run /TN $task 2>&1 | Out-Null
        Start-Sleep -Seconds 6
        Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -in 443, 3443 } |
            Select-Object LocalAddress, LocalPort | Format-Table -AutoSize
        Get-Content 'C:\Deepscord\logs\server.log' -Tail 6 -Encoding UTF8
    } -ArgumentList $TaskName
} finally {
    Remove-PSSession $session
}
