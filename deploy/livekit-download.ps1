[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'
[string]$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
[string]$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
[string]$cacheRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.qa-tools')) + [IO.Path]::DirectorySeparatorChar
[string]$distRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist')) + [IO.Path]::DirectorySeparatorChar
if (-not ($outputPath.StartsWith($cacheRoot, [StringComparison]::OrdinalIgnoreCase) -or $outputPath.StartsWith($distRoot, [StringComparison]::OrdinalIgnoreCase))) { throw 'LiveKit destination must be beneath this project .qa-tools/ or dist/ directory.' }
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'livekit-pin.json') -Raw | ConvertFrom-Json
[string]$executable = Join-Path $outputPath 'livekit-server.exe'
if (Test-Path -LiteralPath $outputPath) {
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf) -or -not $pin.executableSha256 -or (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.executableSha256) { throw 'Existing LiveKit directory is incomplete or has a different executable hash; choose a new destination.' }
    Write-Output $outputPath
    exit 0
}
[string]$archivePath = $outputPath + '.zip'
if (Test-Path -LiteralPath $archivePath) { throw 'LiveKit download staging archive already exists; inspect it before retrying.' }
[void][IO.Directory]::CreateDirectory((Split-Path -Parent $outputPath))
for ([int]$attempt = 1; $attempt -le 3; $attempt++) {
    try { Invoke-WebRequest -Uri $pin.url -OutFile $archivePath -UseBasicParsing; break }
    catch {
        if ($attempt -eq 3) { throw }
        Write-Warning (@{ event = 'livekit-download-retry'; attempt = $attempt; url = $pin.url; error = $_.Exception.GetType().Name } | ConvertTo-Json -Compress)
        Start-Sleep -Milliseconds (250 * $attempt)
    }
}
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) { throw 'LiveKit archive SHA256 differs from the pinned official release checksum. Archive retained for inspection.' }
Expand-Archive -LiteralPath $archivePath -DestinationPath $outputPath -ErrorAction Stop
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Verified LiveKit release has no livekit-server.exe.' }
[string]$executableHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($pin.executableSha256 -and $executableHash -ne $pin.executableSha256) { throw 'Extracted LiveKit executable differs from the pinned executable hash.' }
[string]$manifest = [ordered]@{ version = $pin.version; url = $pin.url; archiveSha256 = $pin.sha256; executableSha256 = $executableHash } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $outputPath 'verified-release.json'), $manifest, [Text.UTF8Encoding]::new($false))
Remove-Item -LiteralPath $archivePath -ErrorAction Stop
Write-Output $outputPath
