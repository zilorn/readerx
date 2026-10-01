param([Parameter(Mandatory = $true)][string]$Target)
$ErrorActionPreference = 'Stop'
$release = Join-Path $PSScriptRoot "../src-tauri/target/$Target/release"
$application = Join-Path $release 'readerx.exe'
$installers = @(Get-ChildItem (Join-Path $release 'bundle/nsis') -Filter '*.exe' -File)
if (-not (Test-Path $application) -or $installers.Count -eq 0) {
    throw 'Missing Windows application or NSIS installer.'
}
foreach ($file in @($application) + @($installers.FullName)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or
        $signature.SignerCertificate.Thumbprint -ne $env:READERX_SIGNING_THUMBPRINT -or
        $null -eq $signature.TimeStamperCertificate) {
        throw "Invalid, unexpected or untimestamped signature: $(Split-Path $file -Leaf)"
    }
}
