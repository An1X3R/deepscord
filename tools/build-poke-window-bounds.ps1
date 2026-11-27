[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'Visual Studio C++ build tools were not found.' }
$toolchain = Get-ChildItem -LiteralPath (Join-Path $installation 'VC\Tools\MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdk = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$compiler = Join-Path $toolchain.FullName 'bin\Hostx64\x64\cl.exe'
$env:INCLUDE = ((Join-Path $toolchain.FullName 'include'), (Join-Path $sdk.FullName 'ucrt'), (Join-Path $sdk.FullName 'shared'), (Join-Path $sdk.FullName 'um'), (Join-Path $sdk.FullName 'winrt')) -join ';'
$env:LIB = ((Join-Path $toolchain.FullName 'lib\x64'), (Join-Path $sdkRoot ('Lib\'+$sdk.Name+'\ucrt\x64')), (Join-Path $sdkRoot ('Lib\'+$sdk.Name+'\um\x64'))) -join ';'
$output = Join-Path $projectRoot 'desktop\native\bin'
[void][IO.Directory]::CreateDirectory($output)
& $compiler /nologo /std:c++20 /W4 /WX /EHsc /O2 /MT /DUNICODE /D_UNICODE (Join-Path $projectRoot 'desktop\native\poke-window-bounds.cpp') "/Fo:$output\poke-window-bounds.obj" "/Fe:$output\poke-window-bounds.exe" /link user32.lib dwmapi.lib
if ($LASTEXITCODE -ne 0) { throw 'poke-window-bounds helper compilation failed.' }
Write-Output (Join-Path $output 'poke-window-bounds.exe')
