param(
  [Parameter(Mandatory=$true)][string]$Version,
  [string]$GitHubUser = "Fabz2004"
)

# === stealth-chat release helper ===
# Usage: .\publish.ps1 0.1.1
# Then create a GitHub Release manually using the printed instructions at the end.

$ErrorActionPreference = "Stop"

Write-Host "==> Bumping versions to $Version" -ForegroundColor Cyan

# Helper: write text as UTF-8 without BOM (PowerShell 5.1 default adds BOM, which breaks JSON parsers).
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Save-Utf8NoBom([string]$Path, [string]$Content) {
  $abs = (Resolve-Path -LiteralPath $Path).Path
  [System.IO.File]::WriteAllText($abs, $Content, $utf8NoBom)
}

# package.json
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$pkg.version = $Version
Save-Utf8NoBom 'package.json' (($pkg | ConvertTo-Json -Depth 10) + "`n")

# tauri.conf.json
$conf = Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json
$conf.version = $Version
Save-Utf8NoBom 'src-tauri/tauri.conf.json' (($conf | ConvertTo-Json -Depth 10) + "`n")

# Cargo.toml
$cargo = (Get-Content src-tauri/Cargo.toml -Raw) -replace '(?m)^version = ".*"', "version = `"$Version`""
Save-Utf8NoBom 'src-tauri/Cargo.toml' $cargo

Write-Host "==> Loading signing key" -ForegroundColor Cyan
$keyPath = "$env:USERPROFILE\.tauri\stealth-chat.key"
if (-not (Test-Path $keyPath)) {
  Write-Host "Signing key not found at $keyPath. Generate with:" -ForegroundColor Red
  Write-Host "  npx @tauri-apps/cli signer generate --ci --password '' -w `"$keyPath`" --force"
  exit 1
}
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "fabz-stealthchat"

Write-Host "==> Building (this takes a few minutes)" -ForegroundColor Cyan
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run tauri build
if ($LASTEXITCODE -ne 0) {
  Write-Host "Build failed." -ForegroundColor Red
  exit 1
}

$exe = "src-tauri/target/release/bundle/nsis/stealth-chat_${Version}_x64-setup.exe"
$sig = "$exe.sig"
$json = "src-tauri/target/release/bundle/nsis/latest.json"

if (-not (Test-Path $exe)) {
  Write-Host "Expected output not found: $exe" -ForegroundColor Red
  Write-Host "Check src-tauri/target/release/bundle/nsis/ for the actual filenames."
  exit 1
}

Write-Host "==> Patching latest.json with GitHub release URL" -ForegroundColor Cyan
# Build latest.json from the .exe.sig produced by tauri (createUpdaterArtifacts only writes the .sig).
$sigContent = (Get-Content $sig -Raw).Trim()
$manifest = [ordered]@{
  version  = $Version
  notes    = "Auto-generated release v$Version"
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = $sigContent
      url       = "https://github.com/$GitHubUser/stealth-chat/releases/download/v$Version/stealth-chat_${Version}_x64-setup.exe"
    }
  }
}
Save-Utf8NoBom $json ($manifest | ConvertTo-Json -Depth 10)

Write-Host ""
Write-Host "==> Done. Artifacts:" -ForegroundColor Green
Write-Host "  $exe"
Write-Host "  $sig"
Write-Host "  $json"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. git commit -am 'release v$Version' && git tag v$Version && git push --tags"
Write-Host "  2. Go to https://github.com/$GitHubUser/stealth-chat/releases/new"
Write-Host "  3. Choose existing tag v$Version, set title, attach the 3 files above, Publish."
Write-Host "  4. Your friends will receive the update on next app launch."
