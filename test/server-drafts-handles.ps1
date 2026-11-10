param([Parameter(Mandatory=$true)][int]$OwnerProcessId)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DraftWindows {
  public delegate bool Visitor(IntPtr handle,IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor visitor,IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle,out uint processId);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle,StringBuilder text,int count);
  public static long[] Find(int processId) {
    var result=new List<long>();
    EnumWindows((handle,parameter)=>{uint owner;GetWindowThreadProcessId(handle,out owner);var title=new StringBuilder(512);GetWindowText(handle,title,512);if(owner==processId&&title.ToString().Contains("Deepscord"))result.Add(handle.ToInt64());return true;},IntPtr.Zero);
    return result.ToArray();
  }
}
'@
ConvertTo-Json -InputObject @([DraftWindows]::Find($OwnerProcessId)) -Compress
