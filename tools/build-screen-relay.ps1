[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$GoExecutable,
    [Parameter(Mandatory = $true)][string]$ModuleCache,
    [Parameter(Mandatory = $true)][string]$BuildCache
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceDirectory = Join-Path $projectRoot 'desktop\native\screen-relay'
$outputDirectory = Join-Path $projectRoot 'desktop\native\bin'
if (-not (Test-Path -LiteralPath $GoExecutable -PathType Leaf)) { throw 'The explicit Go executable was not found.' }
if (-not (Test-Path -LiteralPath $ModuleCache -PathType Container)) { throw 'The explicit pinned Go module cache was not found.' }
if (-not (Test-Path -LiteralPath $BuildCache -PathType Container)) { throw 'The explicit Go build cache was not found.' }
$environmentNames = @('GOTOOLCHAIN', 'GOPROXY', 'GOSUMDB', 'GOMODCACHE', 'GOCACHE', 'CGO_ENABLED')
$savedEnvironment = @{}
foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:GOTOOLCHAIN = 'local'
    $env:GOPROXY = 'off'
    $env:GOSUMDB = 'off'
    $env:GOMODCACHE = [IO.Path]::GetFullPath($ModuleCache)
    $env:GOCACHE = [IO.Path]::GetFullPath($BuildCache)
    $env:CGO_ENABLED = '0'
    [void][IO.Directory]::CreateDirectory($outputDirectory)
    Push-Location -LiteralPath $sourceDirectory
    try {
        & $GoExecutable test -mod=readonly -count=1 -timeout=90s -v ./...
        if ($LASTEXITCODE -ne 0) { throw 'Screen relay integration tests failed.' }
        & $GoExecutable vet -mod=readonly ./...
        if ($LASTEXITCODE -ne 0) { throw 'Screen relay Go vet failed.' }
        & $GoExecutable build -mod=readonly -trimpath -ldflags '-s -w' -o (Join-Path $outputDirectory 'screen-relay.exe') .
        if ($LASTEXITCODE -ne 0) { throw 'Screen relay compilation failed.' }
    } finally { Pop-Location }
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
$binaryStream = [IO.File]::OpenRead((Join-Path $outputDirectory 'screen-relay.exe'))
try {
    $hash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($binaryStream)).Replace('-', '').ToLowerInvariant()
    [Console]::WriteLine('screen_relay_build_sha256 ' + $hash)
} finally { $binaryStream.Dispose(); $hashAlgorithm.Dispose() }
