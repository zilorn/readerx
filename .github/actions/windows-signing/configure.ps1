$ErrorActionPreference = 'Stop'
if ($env:RUNNER_OS -ne 'Windows') { throw 'Windows signing requires a Windows runner.' }
if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_BASE64) -or
    [string]::IsNullOrEmpty($env:WINDOWS_CERTIFICATE_PASSWORD)) {
    throw 'Configure WINDOWS_CERTIFICATE_BASE64 and WINDOWS_CERTIFICATE_PASSWORD in Actions secrets.'
}
$timestamp = [uri]$env:WINDOWS_TIMESTAMP_URL
if (-not $timestamp.IsAbsoluteUri -or $timestamp.Scheme -notin @('http', 'https')) {
    throw 'The timestamp URL must be an absolute HTTP(S) URL.'
}
$pfxPath = Join-Path $env:RUNNER_TEMP 'readerx-signing.pfx'
$configPath = Join-Path $env:RUNNER_TEMP 'readerx-signing.json'
try {
    [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_BASE64))
    $password = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
    $certificates = @(Import-PfxCertificate -FilePath $pfxPath -CertStoreLocation Cert:\CurrentUser\My -Password $password)
    $signers = @($certificates | Where-Object {
        $_.HasPrivateKey -and
        $_.NotBefore -le (Get-Date) -and $_.NotAfter -gt (Get-Date) -and
        ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3')
    })
    if ($signers.Count -ne 1) { throw 'PFX must contain exactly one valid code-signing certificate with a private key.' }
    $thumbprint = $signers[0].Thumbprint
    # 保存清理所需的指纹，不输出证书或私钥内容。
    "READERX_SIGNING_THUMBPRINT=$thumbprint" | Out-File $env:GITHUB_ENV -Append -Encoding utf8
    @{
        bundle = @{
            windows = @{
                certificateThumbprint = $thumbprint
                digestAlgorithm = 'sha256'
                timestampUrl = $timestamp.AbsoluteUri
                tsp = $true
            }
        }
    } | ConvertTo-Json -Depth 4 | Set-Content $configPath -Encoding utf8
    "config=$configPath" | Out-File $env:GITHUB_OUTPUT -Append -Encoding utf8
} catch {
    foreach ($certificate in $certificates) {
        if ($certificate.HasPrivateKey) {
            Remove-Item "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
        }
    }
    # 避免底层异常将 secret 值写入 Actions 日志。
    throw 'Windows signing setup failed. Check the PFX, password, certificate validity and code-signing usage.'
} finally {
    if (Test-Path $pfxPath) { Remove-Item $pfxPath -Force }
}
