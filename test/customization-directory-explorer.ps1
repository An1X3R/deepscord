param(
  [Parameter(Mandatory=$true)][string]$ProfileDirectory,
  [Parameter(Mandatory=$true)][ValidateSet('inspect','capture','close')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
$targets=@('interfaces','interactions') | ForEach-Object { [System.IO.Path]::GetFullPath((Join-Path $ProfileDirectory ('customization/'+$_))) }
if($Mode -eq 'capture'){
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ExplorerCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr handle, IntPtr dc, uint flags);
}
'@
}
$results=@()
$shell=New-Object -ComObject Shell.Application
foreach($window in @($shell.Windows())){
  if([System.IO.Path]::GetFileName([string]$window.FullName) -ine 'explorer.exe'){continue}
  $folder=[string]$window.Document.Folder.Self.Path
  if($targets -inotcontains $folder){continue}
  $handle=[long]$window.HWND
  $row=[ordered]@{path=$folder;handle=$handle;locationUrl=[string]$window.LocationURL}
  if($Mode -eq 'close'){$window.Quit()}
  if($Mode -eq 'capture'){
    $rect=New-Object ExplorerCapture+Rect
    if(-not [ExplorerCapture]::GetWindowRect([IntPtr]$handle,[ref]$rect)){throw "Cannot locate owned Explorer window: $folder"}
    $bitmap=New-Object System.Drawing.Bitmap ($rect.Right-$rect.Left),($rect.Bottom-$rect.Top)
    $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
    $dc=$graphics.GetHdc()
    try{if(-not [ExplorerCapture]::PrintWindow([IntPtr]$handle,$dc,2)){throw "Cannot capture owned Explorer window: $folder"}}
    finally{$graphics.ReleaseHdc($dc);$graphics.Dispose()}
    $image=Join-Path $OutputDirectory ('explorer-'+[System.IO.Path]::GetFileName($folder)+'.png')
    try{$bitmap.Save($image,[System.Drawing.Imaging.ImageFormat]::Png)}finally{$bitmap.Dispose()}
    $row.screenshot=$image
  }
  $results+=[pscustomobject]$row
}
ConvertTo-Json -InputObject @($results) -Depth 4 -Compress
