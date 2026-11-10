param([Parameter(Mandatory=$true)][long]$WindowHandle, [Parameter(Mandatory=$true)][ValidateSet('frame','client')][string]$CaptureArea, [Parameter(Mandatory=$true)][int]$ParentProcessId)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class PokeWindowBounds {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint process);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out Rect rect, int size);
    [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] static extern int GetCloaked(IntPtr h, int attribute, out int cloaked, int size);
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetClientRect(IntPtr h, out Rect rect);
    [DllImport("user32.dll", SetLastError=true)] static extern bool ClientToScreen(IntPtr h, ref Point point);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    public static void Watch(long handle, string captureArea, int parentProcessId) {
        if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        using (System.Diagnostics.Process parent = System.Diagnostics.Process.GetProcessById(parentProcessId)) {
            IntPtr h = new IntPtr(handle);
            uint owner;
            uint thread = GetWindowThreadProcessId(h, out owner);
            if (thread == 0) throw new InvalidOperationException("Shared window handle is no longer valid: " + handle);
            string previous = "";
            while (!parent.HasExited) {
                uint process;
                if (!IsWindow(h) || GetWindowThreadProcessId(h, out process) != thread || process != owner)
                    throw new InvalidOperationException("Shared window closed or its handle was replaced: " + handle);
                int cloaked;
                int cloakResult = GetCloaked(h, 14, out cloaked, sizeof(int));
                if (cloakResult != 0) Marshal.ThrowExceptionForHR(cloakResult);
                string next;
                if (!IsWindowVisible(h) || IsIconic(h) || cloaked != 0) next = "null";
                else {
                    Rect rect;
                    int result = DwmGetWindowAttribute(h, 9, out rect, Marshal.SizeOf(typeof(Rect)));
                    if (result != 0) Marshal.ThrowExceptionForHR(result);
                    // Same-process Electron sources capture the native client area.
                    if (captureArea == "client") {
                        if (!GetClientRect(h, out rect)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                        Point origin = new Point();
                        if (!ClientToScreen(h, ref origin)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                        rect.Right += origin.X; rect.Bottom += origin.Y; rect.Left += origin.X; rect.Top += origin.Y;
                    }
                    int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
                    if (width <= 0 || height <= 0) throw new InvalidOperationException("Shared window has empty visible bounds: " + handle);
                    next = String.Format(System.Globalization.CultureInfo.InvariantCulture,
                        "{{\"x\":{0},\"y\":{1},\"width\":{2},\"height\":{3}}}", rect.Left, rect.Top, width, height);
                }
                if (next != previous) { Console.WriteLine(next); Console.Out.Flush(); previous = next; }
                Thread.Sleep(100);
            }
        }
    }
}
'@
try { [PokeWindowBounds]::Watch($WindowHandle, $CaptureArea, $ParentProcessId) }
catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
