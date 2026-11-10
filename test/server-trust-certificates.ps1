$ErrorActionPreference = 'Stop'
$directory = $env:DEEPSCORD_TEST_CERTIFICATES
if (-not [IO.Directory]::Exists($directory)) { throw 'Certificate fixture directory is missing' }

function Export-Fixture {
    param([string]$Name, [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
    [IO.File]::WriteAllBytes([IO.Path]::Combine($directory, "$Name.pfx"), $Certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, 'fixture-password'))
    [IO.File]::WriteAllBytes([IO.Path]::Combine($directory, "$Name.cer"), $Certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
}

function New-Fixture {
    param([string]$Name, [string]$HostName, [DateTimeOffset]$Start, [DateTimeOffset]$End, [System.Security.Cryptography.X509Certificates.X509Certificate2]$Issuer)
    $rsa = [System.Security.Cryptography.RSA]::Create(2048)
    try {
        $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=$HostName", $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        $san.AddDnsName($HostName)
        if ($HostName -eq 'localhost') { $san.AddIpAddress([Net.IPAddress]::Parse('127.0.0.1')) }
        $request.CertificateExtensions.Add($san.Build())
        $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
        if ($null -eq $Issuer) {
            $certificate = $request.CreateSelfSigned($Start, $End)
        } else {
            $serial = New-Object byte[] 16
            $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($serial) } finally { $rng.Dispose() }
            $public = $request.Create($Issuer, $Start, $End, $serial)
            try { $certificate = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($public, $rsa) } finally { $public.Dispose() }
        }
        try { Export-Fixture $Name $certificate } finally { $certificate.Dispose() }
    } finally { $rsa.Dispose() }
}

$now = [DateTimeOffset]::UtcNow
New-Fixture 'self-a' 'localhost' ($now.AddMinutes(-5)) ($now.AddDays(7)) $null
New-Fixture 'self-b' 'localhost' ($now.AddMinutes(-5)) ($now.AddDays(7)) $null
New-Fixture 'expired' 'localhost' ($now.AddDays(-7)) ($now.AddDays(-1)) $null
New-Fixture 'future' 'localhost' ($now.AddDays(1)) ($now.AddDays(7)) $null
$rootKey = [System.Security.Cryptography.RSA]::Create(2048)
try {
    $rootRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Deepscord test CA', $rootKey, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $rootRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
    $rootRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign, $true))
    $root = $rootRequest.CreateSelfSigned($now.AddDays(-10), $now.AddDays(30))
    try {
        $pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($root.RawData, [Base64FormattingOptions]::InsertLineBreaks) + "`n-----END CERTIFICATE-----`n"
        [IO.File]::WriteAllText([IO.Path]::Combine($directory, 'root.pem'), $pem)
        New-Fixture 'valid-ca' 'localhost' ($now.AddMinutes(-5)) ($now.AddDays(7)) $root
        New-Fixture 'wrong-host' 'wrong.example' ($now.AddMinutes(-5)) ($now.AddDays(7)) $root
    } finally { $root.Dispose() }
} finally { $rootKey.Dispose() }
