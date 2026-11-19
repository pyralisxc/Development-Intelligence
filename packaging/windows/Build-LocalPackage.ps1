param([string]$OutputDir = '.package-build/local-windows')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$out = [IO.Path]::GetFullPath((Join-Path $root $OutputDir))
$bundle = Join-Path $out 'Development-Intelligence-Local'
if (Test-Path $bundle) { Remove-Item -Recurse -Force $bundle }
New-Item -ItemType Directory -Force $bundle, (Join-Path $bundle 'scripts'), (Join-Path $bundle 'runtime'), (Join-Path $bundle 'packaging\windows') | Out-Null
Push-Location $root
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'DI build failed.' }
  Copy-Item -Recurse (Join-Path $root 'dist') $bundle
  Copy-Item -Recurse (Join-Path $root 'node_modules') $bundle
  Copy-Item (Join-Path $root 'package.json') $bundle
  Copy-Item (Join-Path $root 'scripts\install-local.mjs'), (Join-Path $root 'scripts\local-launcher.mjs'), (Join-Path $root 'scripts\run-oss-understanding.mjs'), (Join-Path $root 'scripts\node-test-events-reporter.mjs') (Join-Path $bundle 'scripts')
  Copy-Item (Get-Command node).Source (Join-Path $bundle 'runtime\node.exe')
  Copy-Item (Join-Path $PSScriptRoot 'Install-Local.ps1'), (Join-Path $PSScriptRoot 'Install-Local.cmd') $bundle
  $zip = Join-Path $out 'Development-Intelligence-Local-win-x64.zip'
  if (Test-Path $zip) { Remove-Item $zip }
  Compress-Archive -Path $bundle -DestinationPath $zip -CompressionLevel Optimal
  Write-Host "Local Windows package: $zip"
} finally { Pop-Location }
