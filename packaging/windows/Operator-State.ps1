# Shared by the operator and its transient inbox-PowerShell MSI waiter. This is
# an uncertainty fence, not installation authority or a second package database.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    # A Windows PowerShell child of pwsh may inherit PS7's PSModulePath. Resolve
    # only inbox PS5 modules, never an incompatible ambient Security provider.
    $PSModuleAutoLoadingPreference='None'
    foreach ($module in 'Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management','Microsoft.PowerShell.Security','CimCmdlets') { Import-Module ($PSHOME+'\Modules\'+$module+'\'+$module+'.psd1') -ErrorAction Stop }
}
function Assert-OperatorDirectory([string]$Directory) {
    if (!(Get-Item -LiteralPath $Directory -Force).PSIsContainer) { throw 'Operator directory required' }
    for ($ancestor=[IO.Path]::GetFullPath($Directory);$ancestor;$ancestor=Split-Path $ancestor) {
        if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Operator reparse boundary refused' }
    }
    $acl=Get-Acl -LiteralPath $Directory
    $trusted=@('S-1-5-18','S-1-5-32-544')
    if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Protected operator directory required' }
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        # Read-only grants (including the service SID) cannot replace receipts.
        $rights=[long]$rule.FileSystemRights -band 0xffffffffL
        $writeMask=0x500d0156L # generic write/all, write/delete/DACL/owner rights
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted -and ($rights -band $writeMask)) { throw 'Operator directory permits untrusted writes' }
    }
}
function Assert-OperatorFile([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        $item=Get-Item -LiteralPath $Path -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType -eq 'HardLink' -or $item.Length -gt 32768) { throw 'Invalid operator state file' }
        $acl=Get-Acl -LiteralPath $Path
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'Untrusted operator state owner' }
        foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544') -and (([long]$rule.FileSystemRights -band 0xffffffffL) -band 0x500d0156L)) { throw 'Operator state permits untrusted writes' }
        }
    }
}
function Read-MsiReceipt([string]$Path) {
    Assert-OperatorFile $Path
    if (!(Test-Path -LiteralPath $Path)) { return $null }
    $record=[IO.File]::ReadAllText($Path) | ConvertFrom-Json
    if ($record.formatVersion -ne 1 -or $record.operationId -notmatch '^[a-f0-9]{32}$' -or $record.state -notin @('intent','starting','running','terminal','resolved') -or $record.sha256 -notmatch '^[a-f0-9]{64}$' -or $record.toolsSha256 -notmatch '^[a-f0-9]{64}$' -or $record.verb -notin @('/i','/x') -or $record.productCode -notmatch '^\{[A-Fa-f0-9-]{36}\}$') { throw 'Invalid MSI uncertainty receipt; mutation refused' }
    if ($record.state -in @('terminal','resolved') -and ($null -eq $record.exitCode -or [int]$record.exitCode -lt 0 -or [int]$record.exitCode -gt 65535 -or !$record.msiPid -or $record.msiStartTicks -notmatch '^\d+$')) { throw 'Invalid terminal MSI evidence' }
    $record
}
function Write-OperatorJson([string]$Path,$Record) {
    Assert-OperatorFile $Path
    $temporary=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Record | ConvertTo-Json -Depth 8 -Compress))
    if ($bytes.Length -gt 32768) { throw 'MSI receipt bound exceeded' }
    $stream=[IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    $acl=Get-Acl -LiteralPath $temporary
    $acl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
    Set-Acl -LiteralPath $temporary -AclObject $acl
    # Windows PowerShell 5.1 otherwise coerces $null to an empty backup filename;
    # .NET Framework rejects that path. Preserve a true native null string.
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,[NullString]::Value) } else { [IO.File]::Move($temporary,$Path) }
}
function Write-MsiReceipt([string]$Path,$Record) { Write-OperatorJson $Path $Record }
function Test-MsiTools([string]$Root,[string]$ExpectedMetadataSha='',[switch]$InputBundle) {
    for($ancestor=[IO.Path]::GetFullPath($Root);$ancestor;$ancestor=Split-Path $ancestor){if((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Recovery tool reparse boundary refused'}}
    if(!$InputBundle){Assert-OperatorDirectory $Root}
    if(Get-ChildItem -LiteralPath $Root -Force | Where-Object {$_.Name -notin @('Manage-Trial.ps1','Operator-State.ps1','Run-Msi.ps1','operator.json')}){throw 'Unexpected recovery tool inventory'}
    $metadataPath=Join-Path $Root 'operator.json'
    if($InputBundle){
        $item=Get-Item -LiteralPath $metadataPath -Force
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType -eq 'HardLink' -or $item.Length -gt 32768){throw 'Invalid recovery metadata input'}
    } else {Assert-OperatorFile $metadataPath}
    if ($ExpectedMetadataSha -and (Get-FileHash -LiteralPath $metadataPath).Hash.ToLowerInvariant() -ne $ExpectedMetadataSha) { throw 'Recovery tool metadata identity mismatch' }
    $metadata=Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ($metadata.formatVersion -ne 1 -or $metadata.engineSha -notmatch '^[a-f0-9]{40}$') { throw 'Invalid recovery tool identity' }
    $expected=@('Manage-Trial.ps1','Operator-State.ps1','Run-Msi.ps1')
    if (@($metadata.files).Count -ne 3 -or (@($metadata.files.name | Sort-Object) -join ',') -ne (($expected | Sort-Object) -join ',')) { throw 'Recovery tool inventory mismatch' }
    foreach($entry in $metadata.files) {
        $target=Join-Path $Root $entry.name
        if(!$InputBundle){Assert-OperatorFile $target}
        $item=Get-Item -LiteralPath $target -Force
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType -eq 'HardLink' -or $item.Length -gt 32768 -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $target).Hash.ToLowerInvariant() -ne $entry.sha256){throw 'Recovery tool integrity failure'}
    }
    $metadata
}
function Preserve-MsiTools([string]$Source,[string]$ConfigDirectory) {
    Assert-NoPendingMsi (Join-Path $ConfigDirectory 'operator-msi.json')
    $names=@('Manage-Trial.ps1','Operator-State.ps1','Run-Msi.ps1')
    $sourceManifest=Join-Path $Source 'manifest.json'
    if(Test-Path -LiteralPath $sourceManifest) {
        $manifest=Get-Content -LiteralPath $sourceManifest -Raw | ConvertFrom-Json
        $metadata=@{formatVersion=1;engineSha=$manifest.engineSha;files=@(foreach($name in $names){
            $entry=@($manifest.files | Where-Object path -eq $name)
            if($entry.Count -ne 1){throw 'Owned recovery tool hash missing'}
            @{name=$name;sha256=$entry[0].sha256}
        })}
    } else { $metadata=Test-MsiTools $Source -InputBundle }
    $destination=Join-Path $ConfigDirectory 'operator-tools'
    if(!(Test-Path -LiteralPath $destination)) {
        New-Item -ItemType Directory -Path $destination | Out-Null
        $acl=[Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true,$false)
        $acl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
        foreach($sid in 'S-1-5-18','S-1-5-32-544'){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]$sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
        Set-Acl -LiteralPath $destination -AclObject $acl
    }
    Assert-OperatorDirectory $destination
    if([IO.Path]::GetFullPath($Source) -eq [IO.Path]::GetFullPath($destination)){Test-MsiTools $destination | Out-Null; return $destination}
    if(Get-ChildItem -LiteralPath $destination -Force | Where-Object {$_.Name -notin ($names+@('operator.json'))}){throw 'Unexpected recovery tool inventory; inspection required'}
    foreach($entry in $metadata.files) {
        $sourcePath=Join-Path $Source $entry.name
        $sourceItem=Get-Item -LiteralPath $sourcePath -Force
        if($sourceItem.PSIsContainer -or ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $sourceItem.LinkType -eq 'HardLink' -or $sourceItem.Length -gt 32768 -or (Get-FileHash -LiteralPath $sourcePath).Hash.ToLowerInvariant() -ne $entry.sha256){throw 'Owned recovery tool integrity failure'}
        $target=Join-Path $destination $entry.name
        Assert-OperatorFile $target
        [IO.File]::Copy($sourcePath,$target,$true)
        $acl=Get-Acl -LiteralPath $target
        $acl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
        Set-Acl -LiteralPath $target -AclObject $acl
    }
    Write-OperatorJson (Join-Path $destination 'operator.json') $metadata
    Test-MsiTools $destination | Out-Null
    $destination
}
function Assert-NoPendingMsi([string]$Path) {
    $record=Read-MsiReceipt $Path
    if ($record -and $record.state -ne 'resolved') { throw 'DI_MSI_UNCERTAIN: unresolved MSI intent; use Reconcile, never kill or replay' }
}
function Get-InstallerState {
    $controller=$null
    try {
        Add-Type -AssemblyName System.ServiceProcess
        $controller=[ServiceProcess.ServiceController]::new('msiserver')
        $controller.Refresh()
        if($controller.Status -ne 'Stopped' -and $controller.CanShutdown){return 'busy'}
        'idle'
    } catch {'unavailable'} finally {if($controller){$controller.Dispose()}}
}
function Get-MsiObservation([string]$Path) {
    $record=Read-MsiReceipt $Path
    $installerState=Get-InstallerState
    if (!$record) { return [pscustomobject]@{state='none';installerState=$installerState;mutationAllowed=$true} }
    $workerObservation='not-established'
    if ($record.workerPid -and $record.workerStartTicks) {
        $worker=$null
        try {
            $worker=Get-Process -Id $record.workerPid -ErrorAction SilentlyContinue
            if (!$worker) { $workerObservation='not-observed' }
            elseif ($worker.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.workerStartTicks) { $workerObservation='running' }
            else { $workerObservation='pid-reused' }
        } catch {$workerObservation='unavailable-or-exited'} finally {if($worker){$worker.Dispose()}}
    }
    [pscustomobject]@{state=$record.state;operationId=$record.operationId;verb=$record.verb;packageSha256=$record.sha256;toolsSha256=$record.toolsSha256;productCode=$record.productCode;worker=$workerObservation;installerState=$installerState;exitCode=$record.exitCode;mutationAllowed=($record.state -eq 'resolved');replayPerformed=$false}
}
function Wait-MsiReceipt([string]$Path,[Diagnostics.Process]$Worker,[int]$TimeoutMs=300000) {
    $clock=[Diagnostics.Stopwatch]::StartNew()
    while ($clock.ElapsedMilliseconds -lt $TimeoutMs) {
        $record=Read-MsiReceipt $Path
        if ($record.state -eq 'terminal') { return $record }
        if ($Worker.HasExited) { throw 'DI_MSI_UNCERTAIN: waiter exited without terminal evidence; mutation refused' }
        [void]$Worker.WaitForExit([Math]::Min(100,[Math]::Max(1,$TimeoutMs-$clock.ElapsedMilliseconds)))
    }
    # Dispose closes only our handle. Neither waiter nor installer is killed.
    throw 'DI_MSI_UNCERTAIN: MSI deadline exceeded; waiter may still be running; use Reconcile'
}
function Assert-TerminalMsi($Record) {
    if ($Record.state -ne 'terminal' -or $null -eq $Record.exitCode -or !$Record.msiPid -or !$Record.msiStartTicks) { throw 'DI_MSI_UNCERTAIN: retained terminal MSI evidence required' }
    if ([int]$Record.exitCode -in @(1604,1618,1641,3010)) { throw ('DI_MSI_DEFERRED: suspended/busy/reboot-required outcome '+$Record.exitCode+'; no automatic rollback') }
}
function Enter-OperatorLock([string]$Path) {
    if (!(Test-Path -LiteralPath $Path)) {
        try {
            $file=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            $file.Dispose()
            $acl=Get-Acl -LiteralPath $Path
            $acl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
            Set-Acl -LiteralPath $Path -AclObject $acl
        } catch [IO.IOException] { if (!(Test-Path -LiteralPath $Path)) { throw } }
    }
    Assert-OperatorFile $Path
    try { [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
    catch { throw 'Another operator command owns the mutation lock; no action submitted' }
}
