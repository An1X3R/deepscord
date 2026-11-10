param([Parameter(Mandatory=$true)][ValidateSet('protect','unprotect')][string]$Operation)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
try {
    Add-Type -AssemblyName System.Security
    $inputText=[Console]::In.ReadToEnd()
    if($inputText.Length -gt 8388608){throw [ArgumentException]::new('Protection input exceeds its budget')}
    $inputBytes=[Convert]::FromBase64String($inputText)
    $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser
    if($Operation -eq 'protect'){
        $outputBytes=[Security.Cryptography.ProtectedData]::Protect($inputBytes,$null,$scope)
    }else{
        $outputBytes=[Security.Cryptography.ProtectedData]::Unprotect($inputBytes,$null,$scope)
    }
    [Console]::Out.Write([Convert]::ToBase64String($outputBytes))
    [Array]::Clear($inputBytes,0,$inputBytes.Length)
    [Array]::Clear($outputBytes,0,$outputBytes.Length)
    exit 0
}catch{
    [Console]::Error.WriteLine('Windows DPAPI operation failed: '+$_.Exception.GetType().FullName)
    exit 1
}
