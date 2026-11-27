[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$NodeRuntime,
    [Parameter(Mandatory = $true)][string]$NodeLicense
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

[string]$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
[string]$distRoot = [IO.Path]::GetFullPath((Join-Path $sourceRoot 'dist')) + [IO.Path]::DirectorySeparatorChar
[string]$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $outputPath.StartsWith($distRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDirectory must be a new directory beneath this project dist/ directory.'
}
if (Test-Path -LiteralPath $outputPath) { throw 'OutputDirectory already exists; choose a new destination.' }
[string]$runtimePath = (Resolve-Path -LiteralPath $NodeRuntime -ErrorAction Stop).Path
[string]$licensePath = (Resolve-Path -LiteralPath $NodeLicense -ErrorAction Stop).Path
[string]$nodeVersion = & $runtimePath -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.13.0') {
    throw 'NodeRuntime must be a working Node.js 22.13 or newer Windows executable.'
}
if ((Get-Item -LiteralPath $licensePath).Length -lt 1000) { throw 'NodeLicense must contain the full Node.js distribution license.' }

[void][IO.Directory]::CreateDirectory($outputPath)
foreach ($name in @('server.js', 'lib', 'public', 'Dockerfile', 'docker-compose.yml', 'NETWORKING.md', 'LICENSE')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination $outputPath -Recurse -ErrorAction Stop
}
[string]$deployDirectory = Join-Path $outputPath 'deploy'
[void][IO.Directory]::CreateDirectory($deployDirectory)
foreach ($name in @('Caddyfile', 'coturn.conf', 'livekit-pin.json', 'livekit-download.ps1', 'livekit-config.cjs', 'livekit-compose.yml')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot ('deploy\' + $name)) -Destination $deployDirectory -ErrorAction Stop
}
foreach ($name in @('package.json', 'package-lock.json', 'README.md', 'start-server.cmd', 'start-server.ps1', 'start-screen-sfu.cmd', 'start-screen-sfu.ps1', 'server.env.example')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot ('standalone\' + $name)) -Destination $outputPath -ErrorAction Stop
}
[string]$runtimeDirectory = Join-Path $outputPath 'runtime'
[void][IO.Directory]::CreateDirectory($runtimeDirectory)
Copy-Item -LiteralPath $runtimePath -Destination (Join-Path $runtimeDirectory 'node.exe') -ErrorAction Stop
Copy-Item -LiteralPath $licensePath -Destination (Join-Path $runtimeDirectory 'LICENSE') -ErrorAction Stop
[string]$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
[string]$npmCli = Join-Path (Split-Path -Parent $npmCommand) 'node_modules\npm\bin\npm-cli.js'
& $runtimePath $npmCli ci --prefix $outputPath --omit=dev --ignore-scripts --no-audit --no-fund --offline
if ($LASTEXITCODE -ne 0) { throw 'Pinned standalone dependencies are unavailable locally. Run npm ci in standalone/ before packaging.' }
[string]$liveKitCache = Join-Path $sourceRoot '.qa-tools\livekit-1.13.11'
& (Join-Path $sourceRoot 'deploy\livekit-download.ps1') -OutputDirectory $liveKitCache | Out-Null
Copy-Item -LiteralPath $liveKitCache -Destination (Join-Path $deployDirectory 'livekit-runtime') -Recurse -ErrorAction Stop
[object[]]$files = @(Get-ChildItem -LiteralPath $outputPath -Recurse -File | ForEach-Object {
    [ordered]@{
        path = $_.FullName.Substring($outputPath.Length + 1).Replace('\', '/')
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
})
[string]$manifest = [ordered]@{ package = 'deepscord-standalone-server'; nodeVersion = $nodeVersion; files = $files } | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $outputPath 'package-manifest.json'), $manifest, [Text.UTF8Encoding]::new($false))
Write-Output $outputPath
