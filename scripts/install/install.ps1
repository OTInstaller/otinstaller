# Installs ot, the OTInstaller Registry CLI, on Windows:
#
#   irm https://get.otinstaller.com/ot.ps1 | iex
#
# Downloads the latest release for this machine, checks its SHA-256 against checksums.txt, checks checksums.txt
# against the ot release key when openssl is available (Git for Windows ships it), and installs to
# $env:OT_INSTALL_DIR (default %LOCALAPPDATA%\Programs\ot), adding it to your user PATH.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = if ($env:OT_RELEASE_REPO) { $env:OT_RELEASE_REPO } else { 'otinstaller/ot' }
# Base64 Ed25519 public key; the release workflow fills it in.
$publicKey = '__OT_RELEASE_PUBLIC_KEY__'

$arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'amd64' } 'ARM64' { 'arm64' } default { throw "unsupported CPU $($env:PROCESSOR_ARCHITECTURE)" } }
$tag = if ($env:OT_VERSION) { $env:OT_VERSION } else { (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name }
$version = $tag.TrimStart('v')
$archive = "ot_${version}_windows_$arch.zip"
$base = "https://github.com/$repo/releases/download/$tag"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("ot-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    Write-Host "Downloading ot $tag for windows/$arch..."
    foreach ($f in @($archive, 'checksums.txt', 'checksums.txt.sig')) {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$f" -OutFile (Join-Path $tmp $f)
    }

    $openssl = Get-Command openssl -ErrorAction SilentlyContinue
    if ($publicKey.StartsWith('__')) {
        Write-Warning 'this copy of the script has no release key; only the checksum is checked'
    } elseif ($openssl) {
        $der = [byte[]](0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00) + [Convert]::FromBase64String($publicKey)
        [IO.File]::WriteAllBytes((Join-Path $tmp 'key.der'), $der)
        & $openssl.Source pkey -pubin -inform DER -in (Join-Path $tmp 'key.der') -out (Join-Path $tmp 'key.pem') 2>$null
        & $openssl.Source pkeyutl -verify -pubin -inkey (Join-Path $tmp 'key.pem') -rawin -in (Join-Path $tmp 'checksums.txt') -sigfile (Join-Path $tmp 'checksums.txt.sig') *> $null
        if ($LASTEXITCODE -ne 0) { throw 'checksums.txt is not signed by the ot release key' }
        Write-Host 'Signature verified.'
    } else {
        Write-Warning 'openssl not found; only the checksum is checked'
    }

    $line = Get-Content (Join-Path $tmp 'checksums.txt') | Where-Object { $_ -match "  $([regex]::Escape($archive))$" } | Select-Object -First 1
    if (-not $line) { throw "checksums.txt has no entry for $archive" }
    $want = ($line -split '\s+')[0]
    $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $archive)).Hash.ToLower()
    if ($want -ne $got) { throw "$archive does not match its checksum" }

    $dir = if ($env:OT_INSTALL_DIR) { $env:OT_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\ot' }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Expand-Archive -Path (Join-Path $tmp $archive) -DestinationPath (Join-Path $tmp 'x') -Force
    Copy-Item (Join-Path $tmp 'x\ot.exe') (Join-Path $dir 'ot.exe') -Force

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') -contains $dir)) {
        [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $dir), 'User')
        Write-Host "Added $dir to your PATH (open a new terminal to use it)."
    }
    Write-Host "Installed ot $tag to $dir\ot.exe. Next: ot doctor"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
