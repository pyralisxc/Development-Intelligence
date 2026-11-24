param(
  [string]$RepoPath,
  [string]$Project,
  [string]$InstallDir,
  [string]$DataDir,
  [string]$ScratchDir,
  [string]$DesktopDir,
  [int]$Retain = 0,
  [int]$CacheSize = -1,
  [int]$GraphWorkerHeapMB = 0,
  [int]$ScipHeapMB = 0,
  [int]$Port = 0,
  [switch]$SkipInitialBuild,
  [switch]$NonInteractive
)
$ErrorActionPreference = 'Stop'
$bundle = if (Test-Path (Join-Path $PSScriptRoot 'scripts\install-local.mjs')) { $PSScriptRoot } else { Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$node = Join-Path $bundle 'runtime\node.exe'
$installer = Join-Path $bundle 'scripts\install-local.mjs'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git for Windows is required. Install Git and open a new terminal before setup.' }
if (-not $RepoPath -and -not $NonInteractive) { $RepoPath = Read-Host 'Repository checkout path' }
if (-not $RepoPath) { throw 'Specify -RepoPath for the local checkout.' }
if (-not $NonInteractive) {
  if (-not $Project) { $Project = Read-Host 'Project name (Enter uses the checkout folder name)' }
  if (-not $InstallDir) { $InstallDir = Read-Host 'Install directory (Enter uses Local AppData)' }
  if (-not $DataDir) { $DataDir = Read-Host 'Graph data directory (Enter uses Local AppData)' }
  if (-not $ScratchDir) { $ScratchDir = Read-Host 'Scratch directory (Enter uses the graph data directory)' }
  if (-not $Retain) { $value = Read-Host 'Graph generations to retain (Enter keeps the default)'; if ($value) { $Retain = [int]$value } }
  if ($CacheSize -lt 0) { $value = Read-Host 'Graphs to cache in memory, 0 disables cache (Enter keeps the default)'; if ($value) { $CacheSize = [int]$value } }
  if (-not $Port) { $value = Read-Host 'Workbench port (Enter keeps the default)'; if ($value) { $Port = [int]$value } }
}
$arguments = @($installer, '--repo-path', $RepoPath)
if ($Retain) { $arguments += @('--retain', "$Retain") }
if ($GraphWorkerHeapMB) { $arguments += @('--graph-worker-heap-mb', "$GraphWorkerHeapMB") }
if ($ScipHeapMB) { $arguments += @('--scip-heap-mb', "$ScipHeapMB") }
if ($CacheSize -ge 0) { $arguments += @('--cache-size', "$CacheSize") }
if ($Port) { $arguments += @('--port', "$Port") }
if ($Project) { $arguments += @('--project', $Project) }
if ($InstallDir) { $arguments += @('--install-dir', $InstallDir) }
if ($DataDir) { $arguments += @('--data-dir', $DataDir) }
if ($ScratchDir) { $arguments += @('--scratch-dir', $ScratchDir) }
if ($DesktopDir) { $arguments += @('--desktop-dir', $DesktopDir) }
$result = & $node @arguments
if ($LASTEXITCODE -ne 0) { throw "Local installation failed (exit $LASTEXITCODE)." }
$result | ForEach-Object { Write-Host $_ }
$installed = ($result -join "`n") | ConvertFrom-Json
if (-not $SkipInitialBuild) {
  Write-Host 'Building the current local files. This may take time for a large repository.'
  & $installed.launcher build
  if ($LASTEXITCODE -ne 0) { throw "Initial graph build failed (exit $LASTEXITCODE). The installation remains available; run the reported launcher with build to retry." }
}
Write-Host 'Open Development Intelligence Local from the Start menu, or run the reported di-local.cmd launcher.'
