param([Parameter(Mandatory=$true)][long]$WindowHandle)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DraftFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle,int command);
}
'@
[void][DraftFocus]::ShowWindow([IntPtr]$WindowHandle,9)
if([DraftFocus]::GetForegroundWindow().ToInt64() -eq $WindowHandle){exit 0}
if(-not [DraftFocus]::SetForegroundWindow([IntPtr]$WindowHandle)){throw 'Cannot activate owned acceptance window'}
$deadline=[DateTime]::UtcNow.AddSeconds(2)
while([DraftFocus]::GetForegroundWindow().ToInt64() -ne $WindowHandle -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 20}
if([DraftFocus]::GetForegroundWindow().ToInt64() -ne $WindowHandle){throw 'Owned acceptance window did not receive foreground focus'}
