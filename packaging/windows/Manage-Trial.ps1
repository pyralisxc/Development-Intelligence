param(
    [Parameter(Mandatory)][ValidateSet('Status','Start','Stop','Restart','Update','Uninstall','Backup','Restore')][string]$Action,
    [string]$Msi,
    [string]$ExpectedSha256,
    [string]$PreviousMsi,
    [string]$PreviousSha256,
    [string]$BackupDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$serviceName = 'DevelopmentIntelligenceTrial'
$data = Join-Path $env:ProgramData $serviceName
$uri = 'http://127.0.0.1:8788/managed-health'
function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'An elevated operator is required' }
}
function Assert-Package([string]$Root) {
    $manifest = Get-Content -LiteralPath (Join-Path $Root 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.formatVersion -ne 1 -or $manifest.engineSha -notmatch '^[a-f0-9]{40}$' -or $manifest.engineSha -ne $manifest.packagingSha) { throw 'Invalid installed identity' }
    foreach ($file in $manifest.files) {
        if ([IO.Path]::IsPathRooted($file.path) -or $file.path -match '(^|[\\/])\.\.([\\/]|$)') { throw 'Invalid manifest path' }
        $target = Join-Path $Root $file.path
        $item = Get-Item -LiteralPath $target
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse payload refused' }
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256) { throw "Installed integrity failure: $($file.path)" }
    }
    $manifest
}
function Wait-Health($manifest) {
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        try {
            $health = Invoke-RestMethod $uri -TimeoutSec 2
            if ($health.ready -and $health.engineSha -eq $manifest.engineSha -and $health.packagingSha -eq $manifest.packagingSha -and $health.msiVersion -eq $manifest.msiVersion) { return $health }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw 'Exact candidate managed health did not become ready'
}
function Stop-OwnedService {
    $service = Get-Service $serviceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') {
        Stop-Service $serviceName
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
    }
    if (Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue) { throw 'Listener remains after service stop; refusing further mutation' }
}
function Clear-OwnedScratch {
    $scratch = [IO.Path]::GetFullPath((Join-Path $data 'scratch'))
    if ($scratch -ne [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'DevelopmentIntelligenceTrial\scratch'))) { throw 'Unexpected cleanup target' }
    if (!(Test-Path -LiteralPath $scratch)) { return }
    function Inspect-Tree([string]$target) {
        $item = Get-Item -LiteralPath $target -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Scratch reparse point requires operator inspection' }
        if ($item.PSIsContainer) { foreach ($child in Get-ChildItem -LiteralPath $target -Force) { Inspect-Tree $child.FullName } }
    }
    Inspect-Tree $scratch
    foreach ($item in Get-ChildItem -LiteralPath $scratch -Force) { Remove-Item -LiteralPath $item.FullName -Recurse -Force }
}
function Assert-Msi([string]$target, [string]$hash) {
    if ($hash -notmatch '^[a-fA-F0-9]{64}$' -or ![IO.Path]::IsPathRooted($target) -or [IO.Path]::GetExtension($target) -ne '.msi') { throw 'Absolute MSI path and independently verified SHA256 required' }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $hash) { throw 'MSI checksum mismatch' }
}
function Invoke-Msi([string]$verb, [string]$target) {
    $process = Start-Process msiexec.exe -ArgumentList @($verb, ('"' + $target + '"'), '/qn', '/norestart') -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Windows Installer returned $($process.ExitCode)" }
}
function Installed-Root {
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    if (!$service -or $service.PathName -notmatch '^"?(.+DevelopmentIntelligenceTrial\.exe)"?$') { throw 'Owned MSI service path unavailable' }
    Split-Path $Matches[1]
}
if ($Action -eq 'Status') {
    $service = Get-Service $serviceName -ErrorAction SilentlyContinue
    $health = $null
    try { $health = Invoke-RestMethod $uri -TimeoutSec 2 } catch { }
    [PSCustomObject]@{ serviceStatus=if ($service) { [string]$service.Status } else { 'NotInstalled' }; configured=(Test-Path (Join-Path $data 'config\service.json')); health=$health }
    return
}
Assert-Administrator
switch ($Action) {
    'Start' {
        $manifest = Assert-Package (Installed-Root)
        if (!(Test-Path (Join-Path $data 'config\service.json'))) { throw 'Explicit protected configuration required before activation' }
        if ((Get-Service $serviceName).Status -eq 'Stopped' -and (Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)) { throw 'Port is occupied; refusing activation' }
        Start-Service $serviceName
        Wait-Health $manifest
    }
    'Stop' { Stop-OwnedService; Clear-OwnedScratch }
    'Restart' { Stop-OwnedService; Clear-OwnedScratch; & $PSCommandPath -Action Start }
    'Uninstall' { Assert-Msi $Msi $ExpectedSha256; Stop-OwnedService; Clear-OwnedScratch; Invoke-Msi '/x' $Msi }
    'Update' {
        Assert-Msi $Msi $ExpectedSha256
        Assert-Msi $PreviousMsi $PreviousSha256
        $old = Assert-Package (Installed-Root)
        if ((Get-Service $serviceName).Status -ne 'Running') { throw 'Validated update requires the configured known-good service running' }
        Wait-Health $old | Out-Null
        Stop-OwnedService
        Clear-OwnedScratch
        try {
            Invoke-Msi '/i' $Msi
            $candidate = Assert-Package (Installed-Root)
            Start-Service $serviceName
            Wait-Health $candidate
        } catch {
            $failure = $_
            Stop-OwnedService
            # Explicit uninstall/reinstall permits a numerically older known-good MSI.
            # MSI owns all registration; no second package database or atomicity claim.
            if ((Installed-Root) -ne $PSScriptRoot) { Invoke-Msi '/x' $Msi }
            Invoke-Msi '/i' $PreviousMsi
            Start-Service $serviceName
            Wait-Health $old | Out-Null
            throw "Candidate update failed; known-good package restored: $($failure.Exception.Message)"
        }
    }
    'Backup' {
        if (!$BackupDirectory -or (Test-Path -LiteralPath $BackupDirectory)) { throw 'A new backup directory is required' }
        New-Item -ItemType Directory -Path $BackupDirectory | Out-Null
        # This compute package owns no local canonical state. Only nonsecret lab
        # fixtures are portable; configuration/tokens/logs are deliberately excluded.
        $source = Join-Path $data 'test-data'
        if (Get-ChildItem -LiteralPath $source -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Reparse backup refused' }
        Copy-Item -LiteralPath $source -Destination $BackupDirectory -Recurse
    }
    'Restore' {
        Stop-OwnedService
        $source = Join-Path $BackupDirectory 'test-data'
        if (!(Test-Path -LiteralPath $source) -or (Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Regular fixture backup required' }
        if (Get-ChildItem -LiteralPath $source -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Reparse restore refused' }
        Copy-Item -Path (Join-Path $source '*') -Destination (Join-Path $data 'test-data') -Recurse -Force
    }
}
