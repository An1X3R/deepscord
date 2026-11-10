[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Deepscord capture acceptance window'
$form.ClientSize = New-Object System.Drawing.Size(640,360)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [Drawing.Color]::FromArgb(216,36,49)
$form.TopMost = $true
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Controlled Deepscord capture test'
$label.ForeColor = [Drawing.Color]::White
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(30,30)
$label.Font = New-Object System.Drawing.Font('Segoe UI',18)
$form.Controls.Add($label)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 120
$timer.Add_Tick({
    if ($form.BackColor.R -gt 100) { $form.BackColor = [Drawing.Color]::FromArgb(36,89,216) }
    else { $form.BackColor = [Drawing.Color]::FromArgb(216,36,49) }
})
$form.Add_Shown({ $timer.Start(); [Console]::WriteLine('ready'); [Console]::Out.Flush() })
[void]$form.ShowDialog()
$timer.Dispose()
$form.Dispose()
