param([Parameter(Mandatory=$true)][int]$RootPid)
$ErrorActionPreference='Stop'
$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name)
$selected=[System.Collections.Generic.HashSet[int]]::new()
[void]$selected.Add($RootPid)
do {
    $added=0
    foreach($row in $all) {
        if($selected.Contains([int]$row.ParentProcessId) -and $selected.Add([int]$row.ProcessId)) {$added++}
    }
} while($added -gt 0)
$rows=@(foreach($row in $all) {
    if($selected.Contains([int]$row.ProcessId)) {
        $process=Get-Process -Id $row.ProcessId -ErrorAction Stop
        [pscustomobject]@{pid=[int]$row.ProcessId;parentPid=[int]$row.ParentProcessId;name=$row.Name;privateCommittedBytes=[long]$process.PrivateMemorySize64;workingSetBytes=[long]$process.WorkingSet64}
    }
})
ConvertTo-Json -InputObject $rows -Depth 4 -Compress
