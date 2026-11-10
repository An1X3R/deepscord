[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.IO.Compression

function Assert-RealDirectory {
    param([Parameter(Mandatory = $true)][string]$Directory)
    $current = [IO.DirectoryInfo]::new($Directory)
    while ($null -ne $current) {
        if (-not $current.Exists -or ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Resource extraction requires real directories: $($current.FullName)"
        }
        $current = $current.Parent
    }
}

function Resolve-EntryPath {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$BaseDirectory
    )
    if ($Name.Length -gt 512 -or $Name.StartsWith('/') -or [IO.Path]::IsPathRooted($Name)) {
        throw "ZIP entry requires a canonical relative path: $Name"
    }
    $normalized = $Name.Replace('\', '/')
    if ($normalized.Contains('//')) { throw "ZIP entry contains empty path components: $Name" }
    $relative = $normalized.TrimEnd('/')
    $parts = $relative.Split('/')
    foreach ($part in $parts) {
        if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part.Trim() -ne $part -or $part.EndsWith('.') -or $part -match '[<>:"|?*\x00-\x1f\x7f]' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') {
            throw "ZIP entry contains an invalid path component: $Name"
        }
    }
    if ($parts.Count -gt 33) { throw "ZIP entry exceeds 32 directory levels: $Name" }
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($BaseDirectory, ($parts -join [IO.Path]::DirectorySeparatorChar)))
    $prefix = $BaseDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "ZIP entry escapes extraction directory: $Name" }
    return $target
}

$archivePath = [IO.Path]::GetFullPath($Archive)
$destinationPath = [IO.Path]::GetFullPath($Destination)
Assert-RealDirectory -Directory ([IO.Path]::GetDirectoryName($archivePath))
Assert-RealDirectory -Directory $destinationPath
$archiveInfo = [IO.FileInfo]::new($archivePath)
if (-not $archiveInfo.Exists -or ($archiveInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $archiveInfo.Length -gt 67108864) {
    throw "Resource ZIP must be a regular file within 64 MiB: $archivePath"
}
if ([IO.DirectoryInfo]::new($destinationPath).Parent.Name -ne '.imports' -or [IO.Directory]::EnumerateFileSystemEntries($destinationPath).GetEnumerator().MoveNext()) {
    throw "Extraction destination must be empty and directly under .imports: $destinationPath"
}

$archiveStream = [IO.File]::Open($archivePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $zip = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $false)
    try {
        if ($zip.Entries.Count -lt 1 -or $zip.Entries.Count -gt 1024) { throw 'Resource ZIP requires 1..1024 entries' }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $targets = [Collections.Generic.List[string]]::new()
        [long]$declaredBytes = 0
        $hasManifest = $false
        foreach ($entry in $zip.Entries) {
            $target = Resolve-EntryPath -Name $entry.FullName -BaseDirectory $destinationPath
            if (-not $seen.Add($target)) { throw "Resource ZIP contains duplicate paths: $($entry.FullName)" }
            [long]$attributes = [long]$entry.ExternalAttributes -band 4294967295L
            $unixType = ($attributes -shr 16) -band 61440
            if (($attributes -band 1024) -ne 0 -or ($unixType -ne 0 -and $unixType -ne 32768 -and $unixType -ne 16384)) { throw "Resource ZIP entry must not be a link or special file: $($entry.FullName)" }
            if ($entry.Length -lt 0 -or $entry.Length -gt 67108864 -or $declaredBytes + $entry.Length -gt 67108864) { throw 'Resource ZIP uncompressed content exceeds 64 MiB' }
            if (($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')) -and $entry.Length -ne 0) { throw "ZIP directory entry must be empty: $($entry.FullName)" }
            $declaredBytes += $entry.Length
            if ($entry.FullName -ceq 'pack.json') { $hasManifest = $true }
            $targets.Add($target)
        }
        if (-not $hasManifest) { throw 'Resource ZIP requires pack.json at its root' }
        $buffer = New-Object byte[] 65536
        [long]$totalBytes = 0
        for ($index = 0; $index -lt $zip.Entries.Count; $index++) {
            $entry = $zip.Entries[$index]
            $target = $targets[$index]
            if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')) {
                [IO.Directory]::CreateDirectory($target) | Out-Null
                Assert-RealDirectory -Directory $target
                continue
            }
            $parent = [IO.Path]::GetDirectoryName($target)
            [IO.Directory]::CreateDirectory($parent) | Out-Null
            Assert-RealDirectory -Directory $parent
            $inputStream = $entry.Open()
            try {
                $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try {
                    [long]$entryBytes = 0
                    while (($readCount = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $entryBytes += $readCount
                        $totalBytes += $readCount
                        if ($entryBytes -gt $entry.Length -or $totalBytes -gt 67108864) { throw "ZIP extraction exceeded declared byte bounds: $($entry.FullName)" }
                        $outputStream.Write($buffer, 0, $readCount)
                    }
                    if ($entryBytes -ne $entry.Length) { throw "ZIP extracted length differs from declared length: $($entry.FullName)" }
                    $outputStream.Flush($true)
                } finally { $outputStream.Dispose() }
            } finally { $inputStream.Dispose() }
        }
    } finally { $zip.Dispose() }
} finally { $archiveStream.Dispose() }
