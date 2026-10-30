$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:COMPUTERNAME -eq 'OAKLEY') { throw 'Operator tests require disposable hosted Windows' }
. (Join-Path $PSScriptRoot 'Operator-State.ps1')
function Require($Value,[string]$Message) { if(!$Value){throw $Message} }
$root=Join-Path $env:RUNNER_TEMP ('di-operator-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
foreach($sid in 'S-1-5-18','S-1-5-32-544') {$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]$sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
Set-Acl -LiteralPath $root -AclObject $acl
Assert-OperatorDirectory $root
$path=Join-Path $root 'receipt.json'
$record=[pscustomobject]@{formatVersion=1;operationId=('a'*32);state='intent';sha256=('b'*64);toolsSha256=('c'*64);verb='/i';productCode='{00000000-0000-0000-0000-000000000001}';workerPid=$null;workerStartTicks=$null;msiPid=$null;msiStartTicks=$null;exitCode=$null}
Write-MsiReceipt $path $record
$blocked=$false
try { Assert-NoPendingMsi $path } catch {$blocked=$_.Exception.Message -match 'DI_MSI_UNCERTAIN'}
Require $blocked 'Create-before-launch intent did not fence mutation'
$lock=Enter-OperatorLock (Join-Path $root 'operator.lock')
try {
    $locked=$false
    try {$other=Enter-OperatorLock (Join-Path $root 'operator.lock');$other.Dispose()} catch {$locked=$true}
    Require $locked 'Concurrent mutation lock was not exclusive'
} finally {$lock.Dispose()}
# An actual separate inbox-PowerShell process writes terminal evidence only after
# the caller's short wait has expired. No MSI or service is touched in this unit.
$fake=Join-Path $root 'fake-waiter.ps1'
$stateSource=(Join-Path $PSScriptRoot 'Operator-State.ps1').Replace("'","''")
$receiptLiteral=$path.Replace("'","''")
[IO.File]::WriteAllText($fake,"`$ErrorActionPreference='Stop'`nSet-StrictMode -Version Latest`n. '$stateSource'`nStart-Sleep -Milliseconds 900`n`$r=Read-MsiReceipt '$receiptLiteral'`n`$r.state='terminal';`$r.msiPid=123;`$r.msiStartTicks='123';`$r.exitCode=0`nWrite-MsiReceipt '$receiptLiteral' `$r")
$fakeError=Join-Path $root 'fake-waiter-error.txt'
$worker=Start-Process (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoProfile','-NonInteractive','-File',('"'+$fake+'"')) -WindowStyle Hidden -PassThru -RedirectStandardError $fakeError
try {
    $uncertain=$false
    try {Wait-MsiReceipt $path $worker 30 | Out-Null} catch {$uncertain=$_.Exception.Message -match 'DI_MSI_UNCERTAIN'}
    Require ($uncertain -and !$worker.HasExited) 'Deadline killed waiter or claimed failure/success'
    Require ($worker.WaitForExit(15000)) 'Fake waiter did not retain completion'
    if($worker.ExitCode -ne 0) {
        # This isolated fixture exists before credentials/MSIs and contains only
        # synthetic IDs. Bound its native error transport instead of hiding it.
        if((Get-Item -LiteralPath $fakeError).Length -gt 32768){throw 'Fake waiter error output bound exceeded'}
        throw ('Native fake-waiter exit '+$worker.ExitCode+': '+[IO.File]::ReadAllText($fakeError))
    }
    $terminal=Read-MsiReceipt $path
    Require ($terminal.state -eq 'terminal' -and $terminal.exitCode -eq 0) 'Late terminal receipt missing'
    Require (!(Get-MsiObservation $path).mutationAllowed) 'Terminal result silently cleared fence'
    Assert-TerminalMsi $terminal
    foreach($code in 1604,1618,1641,3010) {
        $terminal.exitCode=$code
        $refused=$false
        try {Assert-TerminalMsi $terminal} catch {$refused=$_.Exception.Message -match 'DI_MSI_DEFERRED'}
        Require $refused 'Deferred outcome incorrectly allowed automatic rollback'
    }
    $terminal.state='running';$terminal.workerPid=2147483647;$terminal.workerStartTicks='123';$terminal.exitCode=$null
    Write-MsiReceipt $path $terminal
    Require (!(Get-MsiObservation $path).mutationAllowed) 'Missing PID was treated as terminal completion'
    # Execute the real Update recovery catch with a sentinel Stop implementation:
    # uncertain state must throw before reaching the first recovery mutation.
    $parseErrors=$null
    $managerAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Manage-Trial.ps1'),[ref]$null,[ref]$parseErrors)
    $recoveryCatch=@($managerAst.FindAll({param($node) $node -is [Management.Automation.Language.CatchClauseAst] -and $node.Extent.Text -match 'known-good package restored'},$false))
    Require ($recoveryCatch.Count -eq 1 -and !$parseErrors) 'Recovery owner unavailable'
    $recoveryBody=[scriptblock]::Create(($recoveryCatch[0].Body.Statements | ForEach-Object {$_.Extent.Text}) -join "`n")
    $receiptPath=$path
    function Stop-OwnedService {throw 'SENTINEL_RECOVERY_MUTATION'}
    $recoveryBlocked=$false
    try {throw 'simulated candidate error'} catch {
        try {& $recoveryBody} catch {$recoveryBlocked=$_.Exception.Message -match 'DI_MSI_UNCERTAIN'}
    }
    Require $recoveryBlocked 'Update attempted recovery after uncertain MSI outcome'
    $terminal.state='resolved';$terminal.exitCode=1603
    Write-MsiReceipt $path $terminal
    $knownFailureRecovered=$false
    try {throw 'simulated terminal failure'} catch {
        try {& $recoveryBody} catch {$knownFailureRecovered=$_.Exception.Message -match 'SENTINEL_RECOVERY_MUTATION'}
    }
    Require $knownFailureRecovered 'Known terminal failure did not retain ordinary recovery path'
    [IO.File]::WriteAllText($path,'{corrupt')
    $refused=$false
    try {Assert-NoPendingMsi $path} catch {$refused=$true}
    Require $refused 'Corrupt uncertainty receipt failed open'
    Write-Host 'DI_OPERATOR_STATE_TESTS passed: lock, intent, late completion, no kill/replay, deferred outcomes, missing PID, corruption'
} finally {$worker.Dispose()}
