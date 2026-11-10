$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type 'using System; using System.Threading.Tasks; using System.Runtime.InteropServices; public static class PokeTestInput { public static Task<string> Read() { return Task.Run(() => Console.ReadLine()); } [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command); }'
$form = New-Object Windows.Forms.Form
$form.Text = 'Poke external capture target'
$form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point(100,100)
$form.Size = New-Object Drawing.Size(720,480)
$form.BackColor = [Drawing.Color]::FromArgb(23,87,163)
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 50
$script:read = [PokeTestInput]::Read()
$timer.Add_Tick({
    if (-not $script:read.IsCompleted) { return }
    $line = $script:read.Result
    if ($null -eq $line -or $line -eq 'close') { $form.Close(); return }
    switch ($line) {
        'move' { $form.SetBounds(260,180,900,560) }
        'minimize' { $form.WindowState = 'Minimized' }
        'restore' { $form.WindowState = 'Normal' }
        default { throw 'Unexpected native window test command' }
    }
    $script:read = [PokeTestInput]::Read()
})
$form.Add_Shown({ [void][PokeTestInput]::ShowWindow($form.Handle,4); [Console]::WriteLine($form.Handle.ToInt64()); [Console]::Out.Flush(); $timer.Start() })
try { [Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose(); $form.Dispose() }
