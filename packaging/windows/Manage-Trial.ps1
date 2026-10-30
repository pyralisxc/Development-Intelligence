param(
    [Parameter(Mandatory)][ValidateSet('Status','Reconcile','Resolve','Preflight','Start','Stop','Restart','Update','Uninstall','Backup','Restore')][string]$Action,
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
. ($PSScriptRoot+'/Operator-State.ps1')
$operatorDirectory=Join-Path $data 'config'
$receiptPath=Join-Path $operatorDirectory 'operator-msi.json'
$operatorScripts=$PSScriptRoot
function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'An elevated operator is required' }
}
function Assert-Package([string]$Root) {
    $manifest = Get-Content -LiteralPath (Join-Path $Root 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.formatVersion -ne 1 -or $manifest.engineSha -notmatch '^[a-f0-9]{40}$' -or $manifest.engineSha -ne $manifest.packagingSha) { throw 'Invalid installed identity' }
    $inventory = @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
    if ((Get-Item -LiteralPath $Root).Attributes -band [IO.FileAttributes]::ReparsePoint -or ($inventory | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) { throw 'Reparse package tree refused' }
    $actual = @($inventory | Where-Object { !$_.PSIsContainer -and $_.FullName -ne (Join-Path $Root 'manifest.json') })
    if ($actual.Count -ne $manifest.files.Count) { throw 'Installed inventory mismatch' }
    $declared = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $manifest.files) {
        if ([IO.Path]::IsPathRooted($file.path) -or $file.path -match '[\\:]|(^|/)\.\.?(/|$)|//' -or !$declared.Add($file.path)) { throw 'Invalid manifest path' }
        $target = Join-Path $Root $file.path
        $item = Get-Item -LiteralPath $target
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse payload refused' }
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256) { throw "Installed integrity failure: $($file.path)" }
    }
    $manifest
}
function Wait-Health($manifest) {
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    function Budget([int]$Maximum) {
        $remaining=[Math]::Ceiling(($deadline-[DateTime]::UtcNow).TotalSeconds)
        if ($remaining -le 0) { throw 'Readiness deadline expired' }
        [int][Math]::Min($Maximum,$remaining)
    }
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $health = Invoke-RestMethod $uri -TimeoutSec (Budget 2)
            if ($health.ready -and $health.engineSha -eq $manifest.engineSha -and $health.packagingSha -eq $manifest.packagingSha -and $health.msiVersion -eq $manifest.msiVersion) {
                $canonical = Invoke-RestMethod 'http://127.0.0.1:8788/health' -TimeoutSec (Budget 2)
                if ($canonical.deployment.revision -ne $manifest.engineSha) { throw 'Canonical runtime identity mismatch' }
                $svc = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -OperationTimeoutSec (Budget 5)
                $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($health.pid)" -OperationTimeoutSec (Budget 5)
                if (!$process -or $process.ParentProcessId -ne $svc.ProcessId) { throw 'Health process does not belong to owned service' }
                $config = Get-Content (Join-Path $data 'config\service.json') -Raw | ConvertFrom-Json
                $body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
                $rpc = Invoke-RestMethod 'http://127.0.0.1:8788/mcp' -Method Post -ContentType 'application/json' -Headers @{Authorization="Bearer $($config.agentToken)"} -Body $body -TimeoutSec (Budget 5)
                if ($rpc.PSObject.Properties['error'] -or !($rpc.result.tools | Where-Object name -eq 'scan_graph')) { throw 'Authenticated MCP contract unavailable' }
                return $health
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw 'Exact candidate managed health did not become ready'
}
function Stop-OwnedService {
    $service = Get-Service $serviceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') {
        Stop-Service $serviceName -NoWait
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
    }
    if ([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq 8788) { throw 'Listener remains after service stop; refusing further mutation' }
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
function Invoke-Msi([string]$verb, [string]$target, [string]$ApprovedSha, [string]$PreflightHash='', [int]$WaitMs=300000) {
    Assert-NoPendingMsi $receiptPath
    $packageGuard=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
    Assert-Msi $target $ApprovedSha
    $identity=Msi-Identity $target
    $before=$null
    # Advisory context only. Registered candidate removal must still work when
    # the installed candidate's manifest is malformed or its payload is corrupt.
    try {
        if (Get-Service $serviceName -ErrorAction SilentlyContinue) {
            $beforePath=Join-Path (Installed-Root) 'manifest.json'
            if ((Get-Item -LiteralPath $beforePath).Length -le 1MB) {
                $observed=Get-Content -LiteralPath $beforePath -Raw | ConvertFrom-Json
                if ($observed.PSObject.Properties['engineSha'] -and $observed.PSObject.Properties['msiVersion'] -and $observed.engineSha -match '^[a-f0-9]{40}$' -and $observed.msiVersion -match '^\d+\.\d+\.\d+$') { $before=$observed }
            }
        }
    } catch { $before=$null }
    $boot=(Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 10).LastBootUpTime.ToUniversalTime().Ticks.ToString()
    $record=[pscustomobject]@{formatVersion=1;operationId=[Guid]::NewGuid().ToString('N');state='intent';verb=$verb;packagePath=[IO.Path]::GetFullPath($target);sha256=$ApprovedSha.ToLowerInvariant();productCode=$identity.ProductCode;engineSha=$identity.DI_ENGINE_SHA;msiVersion=$identity.ProductVersion;descriptorHash=$PreflightHash;beforeEngineSha=if($before){$before.engineSha}else{$null};beforeVersion=if($before){$before.msiVersion}else{$null};bootTicks=$boot;workerPid=$null;workerStartTicks=$null;msiPid=$null;msiStartTicks=$null;exitCode=$null}
    Write-MsiReceipt $receiptPath $record
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $start.Arguments='-NoProfile -NonInteractive -File "'+(Join-Path $operatorScripts 'Run-Msi.ps1')+'" -ReceiptPath "'+$receiptPath+'" -OperationId '+$record.operationId
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.EnvironmentVariables.Clear()
    foreach ($key in 'SystemRoot','WINDIR','COMSPEC','ProgramData','SystemDrive') { $value=[Environment]::GetEnvironmentVariable($key); if($value){$start.EnvironmentVariables[$key]=$value} }
    $worker=[Diagnostics.Process]::Start($start)
    try { $terminal=Wait-MsiReceipt $receiptPath $worker $WaitMs } finally { $worker.Dispose() }
    Assert-TerminalMsi $terminal
    $terminal.state='resolved'
    Write-MsiReceipt $receiptPath $terminal
    if ($terminal.exitCode -ne 0) { throw "DI_MSI_FAILED: terminal Windows Installer exit $($terminal.exitCode)" }
    } finally { $packageGuard.Dispose() }
}
function Msi-Identity([string]$target) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.OpenDatabase($target, 0)
    $result = @{}
    foreach ($property in 'ProductCode','UpgradeCode','ProductVersion','DI_ENGINE_SHA','DI_PACKAGING_SHA') {
        $view = $database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property``='$property'")
        [void]$view.Execute()
        $record = $view.Fetch()
        if (!$record) { throw 'MSI identity property missing' }
        $result[$property] = $record.StringData(1)
        [void]$view.Close()
    }
    foreach ($property in 'DI_DESCRIPTOR_JSON','DI_DESCRIPTOR_SHA256') {
        $view = $database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property``='$property'")
        [void]$view.Execute()
        $record = $view.Fetch()
        $result[$property] = if ($record) { $record.StringData(1) } else { $null }
        [void]$view.Close()
    }
    if ($result.UpgradeCode -ne '{B09658F5-C884-4ACD-85D2-46AC3D82DA13}' -or $result.DI_ENGINE_SHA -notmatch '^[a-f0-9]{40}$' -or $result.DI_ENGINE_SHA -ne $result.DI_PACKAGING_SHA) { throw 'MSI is not a managed DI trial package' }
    $result
}
function Invoke-Preflight([string]$root, [string]$DescriptorJson='', [switch]$AllowBlocked) {
    $temporary = $null
    try {
        $arguments = @((Join-Path $root 'managed-preflight.mjs'), '--root', $root, '--config', (Join-Path $data 'config\service.json'))
        if ($DescriptorJson) {
            $temporary = [IO.Path]::GetTempFileName()
            [IO.File]::WriteAllText($temporary, $DescriptorJson)
            $arguments += @('--descriptor',$temporary)
        }
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = Join-Path $root 'node\node.exe'
        # Arguments contain only controlled paths; Windows paths cannot contain quotes.
        $start.Arguments = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.EnvironmentVariables.Clear()
        foreach ($name in 'SystemRoot','WINDIR','COMSPEC','ProgramData','SystemDrive') {
            $value = [Environment]::GetEnvironmentVariable($name)
            if ($value) { $start.EnvironmentVariables[$name] = $value }
        }
        $start.EnvironmentVariables['NODE_OPTIONS'] = ''
        $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
        $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
        $process = [Diagnostics.Process]::Start($start)
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(45000)) { $process.Kill(); throw 'Compatibility preflight timed out before activation' }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        [void]$stderrTask.GetAwaiter().GetResult()
        if (!$stdout) { throw 'Compatibility preflight failed before activation' }
        $report = $stdout | ConvertFrom-Json
        if ((!$report.canActivate -or $process.ExitCode -ne 0) -and !$AllowBlocked) { throw ('Compatibility preflight refused before activation: ' + ($report.blocked -join ', ')) }
        $report
    } finally {
        if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
    }
}
function Assert-CandidateDescriptor($identity) {
    if (!$identity.DI_DESCRIPTOR_JSON -or $identity.DI_DESCRIPTOR_SHA256 -notmatch '^[a-f0-9]{64}$') { throw 'Candidate has no supported compatibility descriptor' }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity.DI_DESCRIPTOR_JSON)))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
    if ($actual -ne $identity.DI_DESCRIPTOR_SHA256) { throw 'Candidate compatibility descriptor integrity failure' }
    $descriptor = $identity.DI_DESCRIPTOR_JSON | ConvertFrom-Json
    if ($descriptor.engineSha -ne $identity.DI_ENGINE_SHA -or $descriptor.packagingSha -ne $identity.DI_PACKAGING_SHA) { throw 'Candidate compatibility descriptor identity failure' }
}
function Installed-Root {
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -OperationTimeoutSec 10
    if (!$service -or $service.PathName -notmatch '^"?(.+DevelopmentIntelligenceTrial\.exe)"?$') { throw 'Owned MSI service path unavailable' }
    Split-Path $Matches[1]
}
function Fixture-Inventory([string]$root) {
    $root = [IO.Path]::GetFullPath($root)
    if (!(Get-Item -LiteralPath $root -Force).PSIsContainer) { throw 'Regular fixture directory required' }
    for ($ancestor = $root; $ancestor; $ancestor = Split-Path $ancestor) {
        if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse fixture ancestor refused' }
    }
    $entries = @(Get-ChildItem -LiteralPath $root -Recurse -Force)
    if ($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Reparse fixture tree refused' }
    foreach ($item in $entries | Where-Object { !$_.PSIsContainer } | Sort-Object FullName) {
        [PSCustomObject]@{ path=$item.FullName.Substring($root.Length).TrimStart([IO.Path]::DirectorySeparatorChar).Replace('\','/'); sha256=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
}
function Start-OwnedService {
    $manifest = Assert-Package (Installed-Root)
    if (!(Test-Path (Join-Path $data 'config\service.json'))) { throw 'Explicit protected configuration required before activation' }
    Invoke-Preflight (Installed-Root) | Out-Null
    if ((Get-Service $serviceName).Status -eq 'Stopped' -and ([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq 8788)) { throw 'Port is occupied; refusing activation' }
    # Submit the native start request without Start-Service's implicit readiness
    # wait. Exact authenticated readiness has its own finite HTTP/CIM window.
    (Get-Service $serviceName).Start()
    Wait-Health $manifest
}
function Resolve-MsiReceipt {
    $record=Read-MsiReceipt $receiptPath
    if (!$record -or $record.state -eq 'resolved') { Get-MsiObservation $receiptPath; return }
    if ($record.state -ne 'terminal') { throw 'DI_MSI_UNCERTAIN: no retained terminal evidence; resolution refused' }
    # Windows documents CanShutdown/SERVICE_ACCEPT_SHUTDOWN as the installer
    # service busy indication. It is an additional refusal, not completion proof.
    Add-Type -AssemblyName System.ServiceProcess
    $installerService=[ServiceProcess.ServiceController]::new('msiserver')
    try { if ($installerService.Status -ne 'Stopped' -and $installerService.CanShutdown) { throw 'Windows Installer is busy; resolution refused' } } finally { $installerService.Dispose() }
    if ($record.exitCode -eq 1604) { throw 'Suspended installation requires native installer recovery; resolution refused' }
    if ($record.exitCode -in @(1641,3010)) {
        $boot=(Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 10).LastBootUpTime.ToUniversalTime().Ticks.ToString()
        if ($boot -eq $record.bootTicks) { throw 'MSI completed but reboot is required; no activation or rollback submitted' }
    }
    $registered=Test-Path -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\'+$record.productCode)
    $service=Get-Service $serviceName -ErrorAction SilentlyContinue
    if ($record.exitCode -in @(0,1641,3010) -and $record.verb -eq '/x') {
        if ($registered -or $service) { throw 'Uninstall terminal result does not match installed state' }
    } else {
        if (!$service) { throw 'No verifiable installed package; native recovery required' }
        $installed=Assert-Package (Installed-Root)
        $targetMatches=$registered -and $installed.engineSha -eq $record.engineSha -and $installed.msiVersion -eq $record.msiVersion
        $priorMatches=$installed.engineSha -eq $record.beforeEngineSha -and $installed.msiVersion -eq $record.beforeVersion
        if ($record.exitCode -in @(0,1641,3010)) { if (!$targetMatches) { throw 'Terminal success does not match exact installed package' } }
        elseif (!$targetMatches -and !$priorMatches) { throw 'Terminal failure left an unexpected installed identity; resolution refused' }
    }
    $record.state='resolved'
    Write-MsiReceipt $receiptPath $record
    Get-MsiObservation $receiptPath
}
if ($Action -eq 'Status') {
    $service = Get-Service $serviceName -ErrorAction SilentlyContinue
    $health = $null
    try { $health = Invoke-RestMethod $uri -TimeoutSec 2 } catch { }
    if (Test-Path -LiteralPath $operatorDirectory) { Assert-OperatorDirectory $operatorDirectory }
    [PSCustomObject]@{ serviceStatus=if ($service) { [string]$service.Status } else { 'NotInstalled' }; configured=(Test-Path (Join-Path $data 'config\service.json')); health=$health; msi=(Get-MsiObservation $receiptPath) }
    return
}
if ($Action -eq 'Reconcile') { Assert-OperatorDirectory $operatorDirectory; Get-MsiObservation $receiptPath; return }
if ($Action -eq 'Preflight') { Invoke-Preflight (Installed-Root) -AllowBlocked; return }
Assert-Administrator
Assert-OperatorDirectory $operatorDirectory
$operatorLock=Enter-OperatorLock (Join-Path $operatorDirectory 'operator.lock')
try {
if ($Action -ne 'Resolve') { Assert-NoPendingMsi $receiptPath }
switch ($Action) {
    'Start' { Start-OwnedService }
    'Resolve' { Resolve-MsiReceipt }
    'Stop' { Stop-OwnedService; Clear-OwnedScratch }
    'Restart' { Stop-OwnedService; Clear-OwnedScratch; Start-OwnedService }
    'Uninstall' {
        Assert-Msi $Msi $ExpectedSha256
        $identity = Msi-Identity $Msi
        $installed = Get-Content -LiteralPath (Join-Path (Installed-Root) 'manifest.json') -Raw | ConvertFrom-Json
        if ($identity.ProductVersion -ne $installed.msiVersion -or $identity.DI_ENGINE_SHA -ne $installed.engineSha) { throw 'Uninstall MSI does not match the installed DI package' }
        Stop-OwnedService
        Clear-OwnedScratch
        Invoke-Msi '/x' $Msi $ExpectedSha256
    }
    'Update' {
        Assert-Msi $Msi $ExpectedSha256
        Assert-Msi $PreviousMsi $PreviousSha256
        $old = Assert-Package (Installed-Root)
        $priorIdentity = Msi-Identity $PreviousMsi
        $candidateIdentity = Msi-Identity $Msi
        if ($priorIdentity.ProductVersion -ne $old.msiVersion -or $priorIdentity.DI_ENGINE_SHA -ne $old.engineSha) { throw 'Known-good MSI does not match the currently installed package' }
        if ([version]$candidateIdentity.ProductVersion -le [version]$old.msiVersion) { throw 'Update requires a newer MSI version' }
        Assert-CandidateDescriptor $candidateIdentity
        Invoke-Preflight (Installed-Root) $candidateIdentity.DI_DESCRIPTOR_JSON | Out-Null
        if ((Get-Service $serviceName).Status -ne 'Running') { throw 'Validated update requires the configured known-good service running' }
        Wait-Health $old | Out-Null
        Stop-OwnedService
        Clear-OwnedScratch
        try {
            Invoke-Msi '/i' $Msi $ExpectedSha256 $candidateIdentity.DI_DESCRIPTOR_SHA256
            $candidate = Assert-Package (Installed-Root)
            (Get-Service $serviceName).Start()
            Wait-Health $candidate
        } catch {
            $failure = $_
            # Any unresolved intent (including waiter/receipt failure, busy,
            # suspension or reboot-required success) forbids *all* recovery
            # mutations. Registration is not evidence that an MSI has exited.
            Assert-NoPendingMsi $receiptPath
            Stop-OwnedService
            # Explicit uninstall/reinstall permits a numerically older known-good MSI.
            # MSI owns all registration; no second package database or atomicity claim.
            # Registration identifies the installed MSI even if candidate files or
            # its manifest are corrupt. Recovery must not depend on failed bytes.
            $candidateRegistered = Test-Path -LiteralPath ("HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\" + $candidateIdentity.ProductCode)
            $priorRegistered = Test-Path -LiteralPath ("HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\" + $priorIdentity.ProductCode)
            if ($candidateRegistered) { Invoke-Msi '/x' $Msi $ExpectedSha256 }
            elseif (!$priorRegistered -and (Get-Service $serviceName -ErrorAction SilentlyContinue)) { throw 'Update outcome is uncertain; automatic rollback refused for an unexpected installed identity' }
            Invoke-Msi '/i' $PreviousMsi $PreviousSha256
            (Get-Service $serviceName).Start()
            Wait-Health $old | Out-Null
            throw "Candidate update failed; known-good package restored: $($failure.Exception.Message)"
        }
    }
    'Backup' {
        if (!$BackupDirectory -or (Test-Path -LiteralPath $BackupDirectory)) { throw 'A new backup directory is required' }
        Stop-OwnedService
        New-Item -ItemType Directory -Path $BackupDirectory | Out-Null
        # This compute package owns no local canonical state. Only nonsecret lab
        # fixtures are portable; configuration/tokens/logs are deliberately excluded.
        $source = Join-Path $data 'test-data'
        $files = @(Fixture-Inventory $source)
        $target = Join-Path $BackupDirectory 'test-data'
        New-Item -ItemType Directory -Path $target | Out-Null
        foreach ($file in $files) {
            $destination = Join-Path $target $file.path
            New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
            [IO.File]::Copy((Join-Path $source $file.path), $destination, $false)
            if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $file.sha256) { throw 'Backup integrity changed during copy' }
        }
        @{formatVersion=1; scope='nonsecret-lab-fixtures'; files=$files} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $BackupDirectory 'backup.json')
    }
    'Restore' {
        Stop-OwnedService
        $source = Join-Path $BackupDirectory 'test-data'
        $manifestPath = Join-Path $BackupDirectory 'backup.json'
        $manifestItem = Get-Item -LiteralPath $manifestPath -Force
        if ($manifestItem.PSIsContainer -or $manifestItem.Length -gt 16MB -or ($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Backup integrity manifest file is invalid' }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($manifest.formatVersion -ne 1 -or $manifest.scope -ne 'nonsecret-lab-fixtures') { throw 'Backup integrity manifest is invalid' }
        $actual = @(Fixture-Inventory $source)
        $expected = @{}
        foreach ($file in $manifest.files) {
            if ($expected.ContainsKey($file.path) -or [IO.Path]::IsPathRooted($file.path) -or $file.path -match '[\\:]|(^|/)\.\.?(/|$)|//') { throw 'Backup integrity path is invalid' }
            $expected[$file.path] = $file.sha256
        }
        if ($actual.Count -ne $expected.Count) { throw 'Backup integrity inventory mismatch' }
        foreach ($file in $actual) { if (!$expected.ContainsKey($file.path) -or $expected[$file.path] -ne $file.sha256) { throw 'Backup integrity hash mismatch' } }
        $target = Join-Path $data 'test-data'
        @(Fixture-Inventory $target) | Out-Null
        foreach ($file in $actual) {
            $destination = Join-Path $target $file.path
            New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
            if ([IO.File]::Exists($destination)) {
                $attributes = [IO.File]::GetAttributes($destination)
                if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse restore target refused' }
                [IO.File]::SetAttributes($destination, ($attributes -band (-bnot [IO.FileAttributes]::ReadOnly)))
            }
            [IO.File]::Copy((Join-Path $source $file.path), $destination, $true)
            if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $file.sha256) { throw 'Restored fixture integrity mismatch' }
        }
    }
}
} finally { $operatorLock.Dispose() }
