$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

[string]$runtimePath = Join-Path $PSScriptRoot 'runtime\node.exe'
[string]$configPath = Join-Path $PSScriptRoot 'server.env'
[string]$certificatePath = Join-Path $PSScriptRoot 'certs\server.pfx'
if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
    throw 'Missing runtime/node.exe. Extract the complete standalone Windows server package.'
}

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    if (Test-Path -LiteralPath $certificatePath) {
        throw 'server.env is missing but certs/server.pfx exists. Restore the matching configuration before starting.'
    }
    [byte[]]$randomBytes = New-Object byte[] 48
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($randomBytes) } finally { $random.Dispose() }
    [string]$accessPassword = ([BitConverter]::ToString($randomBytes, 0, 24)).Replace('-', '').ToLowerInvariant()
    [string]$certificatePassword = ([BitConverter]::ToString($randomBytes, 24, 24)).Replace('-', '').ToLowerInvariant()
    $rsa = [System.Security.Cryptography.RSA]::Create(2048)
    try {
        $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
            'CN=Deepscord standalone server', $rsa,
            [System.Security.Cryptography.HashAlgorithmName]::SHA256,
            [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $names = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        $names.AddDnsName('localhost')
        $names.AddIpAddress([System.Net.IPAddress]::Loopback)
        $names.AddIpAddress([System.Net.IPAddress]::IPv6Loopback)
        $request.CertificateExtensions.Add($names.Build())
        $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(365))
        try {
            [void][IO.Directory]::CreateDirectory((Split-Path -Parent $certificatePath))
            [IO.File]::WriteAllBytes($certificatePath, $certificate.Export(
                [System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $certificatePassword))
            [IO.File]::WriteAllBytes(($certificatePath + '.cer'), $certificate.Export(
                [System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
        } finally { $certificate.Dispose() }
    } finally { $rsa.Dispose() }
    [string]$settings = @"
# Edit this file while the server is stopped. Never share this file or certs/.
ECHO_NETWORK_MODE=server
ECHO_MEDIA_POLICY=direct
ECHO_SCREEN_MODE=peer-relay
ECHO_SCREEN_SFU_URL=wss://rooms.example.com/screen-sfu
ECHO_SCREEN_TOKEN_TTL_SECONDS=60
LIVEKIT_INTERNAL_URL=http://127.0.0.1:7880
LIVEKIT_NODE_IP=
LIVEKIT_UDP_PORT=7882
LIVEKIT_TCP_PORT=7881
ECHO_PASSWORD=$accessPassword
HTTP_HOST=127.0.0.1
PORT=3000
HTTPS_HOST=::
HTTPS_PORTS=3443
ECHO_TLS_PFX_PATH=./certs/server.pfx
ECHO_TLS_PFX_PASSWORD=$certificatePassword
STUN_URLS=
TURN_URL=
TURN_SECRET=
TURN_TTL_SECONDS=
"@
    [IO.File]::WriteAllText($configPath, $settings, [Text.UTF8Encoding]::new($false))
    Write-Host 'Created server.env with a unique access password (ECHO_PASSWORD) and a private HTTPS certificate.'
}

Write-Host 'Standalone server: edit server.env to configure direct or TURN relay mode.'
Write-Host 'Clients connect to https://<this-server-address>:3443 (or the HTTPS_PORTS value).'
Write-Host 'Read ECHO_PASSWORD in server.env for the room password. Ctrl+C stops the server.'
& $runtimePath '--env-file=server.env' 'server.js'
exit $LASTEXITCODE
