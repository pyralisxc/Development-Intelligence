# Shared by the operator and its transient inbox-PowerShell MSI waiter. This is
# an uncertainty fence, not installation authority or a second package database.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    # A Windows PowerShell child of pwsh may inherit PS7's PSModulePath. Resolve
    # only inbox PS5 modules, never an incompatible ambient Security provider.
    $PSModuleAutoLoadingPreference='None'
    foreach ($module in 'Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management','Microsoft.PowerShell.Security','CimCmdlets') { Import-Module ($PSHOME+'\Modules\'+$module+'\'+$module+'.psd1') -ErrorAction Stop }
}
function Assert-OperatorDirectory([string]$Directory) {
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
    if ($record.formatVersion -ne 1 -or $record.operationId -notmatch '^[a-f0-9]{32}$' -or $record.state -notin @('intent','starting','running','terminal','resolved') -or $record.sha256 -notmatch '^[a-f0-9]{64}$' -or $record.verb -notin @('/i','/x') -or $record.productCode -notmatch '^\{[A-Fa-f0-9-]{36}\}$') { throw 'Invalid MSI uncertainty receipt; mutation refused' }
    if ($record.state -in @('terminal','resolved') -and ($null -eq $record.exitCode -or [int]$record.exitCode -lt 0 -or [int]$record.exitCode -gt 65535 -or !$record.msiPid -or $record.msiStartTicks -notmatch '^\d+$')) { throw 'Invalid terminal MSI evidence' }
    $record
}
function Write-MsiReceipt([string]$Path,$Record) {
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
function Assert-NoPendingMsi([string]$Path) {
    $record=Read-MsiReceipt $Path
    if ($record -and $record.state -ne 'resolved') { throw 'DI_MSI_UNCERTAIN: unresolved MSI intent; use Reconcile, never kill or replay' }
}
function Get-MsiObservation([string]$Path) {
    $record=Read-MsiReceipt $Path
    if (!$record) { return [pscustomobject]@{state='none';mutationAllowed=$true} }
    $workerObservation='not-established'
    if ($record.workerPid -and $record.workerStartTicks) {
        $worker=Get-Process -Id $record.workerPid -ErrorAction SilentlyContinue
        if (!$worker) { $workerObservation='not-observed' }
        elseif ($worker.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.workerStartTicks) { $workerObservation='running' }
        else { $workerObservation='pid-reused' }
    }
    [pscustomobject]@{state=$record.state;operationId=$record.operationId;verb=$record.verb;packageSha256=$record.sha256;productCode=$record.productCode;worker=$workerObservation;exitCode=$record.exitCode;mutationAllowed=($record.state -eq 'resolved');replayPerformed=$false}
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
