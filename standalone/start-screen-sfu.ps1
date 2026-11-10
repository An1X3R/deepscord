$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot
[string]$runtime = Join-Path $PSScriptRoot 'runtime\node.exe'
[string]$executable = Join-Path $PSScriptRoot 'deploy\livekit-runtime\livekit-server.exe'
[string]$environment = Join-Path $PSScriptRoot 'server.env'
[string]$config = Join-Path $PSScriptRoot 'data\livekit-private.yaml'
[string]$logDirectory = Join-Path $PSScriptRoot 'logs'
foreach ($required in @($runtime, $executable, $environment)) { if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing standalone SFU prerequisite: $required" } }
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'deploy\livekit-pin.json') -Raw | ConvertFrom-Json
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
$executableStream = [IO.File]::OpenRead($executable)
try { [string]$executableHash = ([BitConverter]::ToString($hashAlgorithm.ComputeHash($executableStream))).Replace('-', '').ToLowerInvariant() }
finally { $executableStream.Dispose(); $hashAlgorithm.Dispose() }
if ($executableHash -ne $pin.executableSha256) { throw 'LiveKit executable does not match the pinned verified release.' }
& $runtime '--env-file=server.env' 'deploy/livekit-config.cjs' 'config' $config
if ($LASTEXITCODE -ne 0) { throw 'Invalid screen SFU configuration; LiveKit was not started.' }
[void][IO.Directory]::CreateDirectory($logDirectory)
[string]$log = Join-Path $logDirectory ('screen-sfu-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.jsonl')
Write-Host 'Starting the independent screen SFU. Keep this window open; Ctrl+C stops it.'
Write-Host 'Only expose configured RTC UDP/TCP ports. Never publish the loopback signaling/admin port.'
# Native stderr contains JSON logs, not PowerShell failures.
$ErrorActionPreference = 'Continue'
try {
    & $executable '--config' $config 2>&1 | ForEach-Object -ErrorAction Stop { $_.ToString() } | Tee-Object -FilePath $log -ErrorAction Stop
    [int]$serviceExitCode = $LASTEXITCODE
} finally { $ErrorActionPreference = 'Stop' }
if ($serviceExitCode -ne 0) { throw "Screen SFU exited with code $serviceExitCode. Inspect $log" }
exit $serviceExitCode
