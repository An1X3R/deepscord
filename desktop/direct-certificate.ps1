$ErrorActionPreference = 'Stop'
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Deepscord temporary room', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(7))
    try {
        [IO.File]::WriteAllBytes($env:DEEPSCORD_PFX_PATH, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $env:DEEPSCORD_PFX_PASSWORD))
        [IO.File]::WriteAllBytes(($env:DEEPSCORD_PFX_PATH + '.cer'), $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    } finally { $certificate.Dispose() }
} finally { $rsa.Dispose() }
