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
Require ((Convert-InstallerState 4 4) -eq 'busy') 'Documented active installer value lost'
Require ((Convert-InstallerState 4 5) -eq 'idle') 'Observed terminal cached/stoppable state misclassified'
Require ((Convert-InstallerState 1 0) -eq 'idle') 'Stopped installer not idle'
foreach($mask in 0,1,2,3,6,7,68,69,255) {
    Require ((Convert-InstallerState 4 $mask) -eq 'unavailable') 'Unobserved running control mask incorrectly became idle'
}
foreach($status in 2,3,5,6,7,99) {
    Require ((Convert-InstallerState $status 5) -eq 'unavailable') 'Transitional installer state incorrectly became idle'
}
$path=Join-Path $root 'receipt.json'
$record=[pscustomobject]@{formatVersion=1;operationId=('a'*32);state='intent';sha256=('b'*64);toolsSha256=('c'*64);verb='/i';productCode='{00000000-0000-0000-0000-000000000001}';workerPid=$null;workerStartTicks=$null;msiPid=$null;msiStartTicks=$null;exitCode=$null}
Write-MsiReceipt $path $record
# A consistently absent receipt retains the established no-intent behavior.
Require ($null -eq (Read-MsiReceipt (Join-Path $root 'never-present.json'))) 'Consistently absent receipt did not remain absent'
# A transient missing name during replacement is retried, but the successful
# snapshot still passes the real ACL, size and schema checks.
$originalPresence=${function:Test-ReceiptPathPresence}
$script:presenceAttempts=0
try {
    function Test-ReceiptPathPresence { param([string]$Path) $script:presenceAttempts++; $script:presenceAttempts -gt 1 }
    $recoveredReceipt=Read-MsiReceipt $path
    Require ($script:presenceAttempts -eq 2 -and $recoveredReceipt.operationId -eq $record.operationId) 'Transient missing receipt did not recover through a validated snapshot'
} finally {Set-Item -Path Function:\Test-ReceiptPathPresence -Value $originalPresence}
$originalOpen=${function:Open-OperatorReadStream}
try {
    # Once presence or a transient open was observed, later absence cannot be
    # downgraded to the mutation-allowed no-receipt state.
    $script:presenceAttempts=0
    function Test-ReceiptPathPresence { param([string]$Path) $script:presenceAttempts++; $script:presenceAttempts -eq 1 }
    function Open-OperatorReadStream { param([string]$Path) throw [IO.FileNotFoundException]::new('Synthetic replacement gap') }
    $disappearedRefused=$false
    try {Read-MsiReceipt $path | Out-Null} catch {$disappearedRefused=$_.Exception.GetBaseException().HResult -eq -2147024894}
    Require $disappearedRefused 'Observed receipt disappearance became no receipt'
    # Persistent sharing failures keep the original native error and bound.
    function Test-ReceiptPathPresence { param([string]$Path) $true }
    $script:openAttempts=0
    function Open-OperatorReadStream { param([string]$Path) $script:openAttempts++; throw [IO.IOException]::new('Synthetic sharing exhaustion',-2147024864) }
    $sharingRefused=$false
    try {Read-MsiReceipt $path | Out-Null} catch {$sharingRefused=$_.Exception.Message -eq 'Synthetic sharing exhaustion' -and $_.Exception.HResult -eq -2147024864}
    Require ($sharingRefused -and $script:openAttempts -eq 5) 'Sharing exhaustion lost native refusal or retry bound'
    # Permission/ACL failures are never classified as replacement races.
    $script:openAttempts=0
    function Open-OperatorReadStream { param([string]$Path) $script:openAttempts++; throw [UnauthorizedAccessException]::new('Synthetic ACL refusal') }
    $aclRefused=$false
    try {Read-MsiReceipt $path | Out-Null} catch {$aclRefused=$_.Exception.Message -eq 'Synthetic ACL refusal'}
    Require ($aclRefused -and $script:openAttempts -eq 1) 'ACL refusal was swallowed or retried as replacement'
} finally {
    Set-Item -Path Function:\Test-ReceiptPathPresence -Value $originalPresence
    Set-Item -Path Function:\Open-OperatorReadStream -Value $originalOpen
}
$malformedPath=Join-Path $root 'malformed-receipt.json'
Copy-Item -LiteralPath $path -Destination $malformedPath
[IO.File]::WriteAllText($malformedPath,'{"formatVersion":1}')
$malformedAcl=Get-Acl -LiteralPath $malformedPath
$malformedAcl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
Set-Acl -LiteralPath $malformedPath -AclObject $malformedAcl
$schemaRefused=$false
try {Read-MsiReceipt $malformedPath | Out-Null} catch {$schemaRefused=$_.Exception.Message -match 'Invalid MSI uncertainty receipt'}
Require $schemaRefused 'Malformed receipt was swallowed as a transient read'
# Unavailable ACL evidence must be rejected even after the bounded retry.
$missingAclRejected=$false
try { Get-OperatorAclChecked (Join-Path $root 'missing-receipt.json') | Out-Null } catch {
    $missingAclRejected=$_.Exception.Message -match 'Operator ACL target unavailable'
}
Require $missingAclRejected 'Missing operator receipt ACL was treated as trusted'
# Simulate a single transient native ACL read failure, then verify that the
# actual protected receipt ACL is still inspected on the successful attempt.
$script:aclFixtureAttempts=0
function Get-Acl {
    param([string]$LiteralPath,[string]$ErrorAction)
    $script:aclFixtureAttempts++
    if($script:aclFixtureAttempts -eq 1){throw [IO.IOException]::new('Synthetic transient ACL read',-2147024864)}
    Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath -ErrorAction Stop
}
try {
    $recovered=Get-OperatorAclChecked $path
    Require ($script:aclFixtureAttempts -eq 2 -and $null -ne $recovered) 'Transient ACL failure did not recover using actual ACL'
} finally { Remove-Item Function:\Get-Acl -ErrorAction SilentlyContinue }
# Persistent native failures must keep the original exception and HRESULT.
$script:aclFixtureAttempts=0
function Get-Acl {
    param([string]$LiteralPath,[string]$ErrorAction)
    $script:aclFixtureAttempts++
    throw [IO.IOException]::new('Synthetic persistent ACL read',-2147024864)
}
try {
    $persistentRefused=$false
    try { Get-OperatorAclChecked $path | Out-Null } catch {
        $persistentRefused=$_.Exception.Message -eq 'Synthetic persistent ACL read' -and $_.Exception.HResult -eq -2147024864
    }
    Require ($persistentRefused -and $script:aclFixtureAttempts -eq 5) 'Persistent ACL refusal lost native exception, HResult, or retry bound'
} finally { Remove-Item Function:\Get-Acl -ErrorAction SilentlyContinue }
$oldReader=Open-OperatorReadStream $path
try {
    $replacement=$record.PSObject.Copy()
    $replacement.state='starting'
    Write-MsiReceipt $path $replacement
    $reader=[IO.StreamReader]::new($oldReader,[Text.Encoding]::UTF8,$true,1024,$true)
    try{$oldJson=$reader.ReadToEnd() | ConvertFrom-Json}finally{$reader.Dispose()}
    Require ($oldJson.state -eq 'intent' -and (Read-MsiReceipt $path).state -eq 'starting') 'Atomic receipt replacement conflicted with active read snapshot'
} finally {$oldReader.Dispose()}
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
# Protected recovery tools must remain non-replaceable, not merely hash-match at
# one instant. External input has a separate integrity-only path before copying.
$tools=Join-Path $root 'operator-tools'
New-Item -ItemType Directory -Path $tools | Out-Null
$toolsAcl=Get-Acl -LiteralPath $tools
$toolsAcl.SetAccessRuleProtection($true,$true)
$toolsAcl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
Set-Acl -LiteralPath $tools -AclObject $toolsAcl
$toolEntries=@(foreach($name in 'Manage-Trial.ps1','Operator-State.ps1','Run-Msi.ps1'){
    $file=Join-Path $tools $name
    [IO.File]::WriteAllText($file,'# inert fixture, never executed')
    $fileAcl=Get-Acl -LiteralPath $file
    $fileAcl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
    Set-Acl -LiteralPath $file -AclObject $fileAcl
    @{name=$name;sha256=(Get-FileHash $file).Hash.ToLowerInvariant()}
})
$toolMeta=Join-Path $tools 'operator.json'
Write-OperatorJson $toolMeta @{formatVersion=1;engineSha=('d'*40);files=$toolEntries}
$toolMetaHash=(Get-FileHash $toolMeta).Hash.ToLowerInvariant()
Test-MsiTools $tools $toolMetaHash | Out-Null
foreach($name in 'Run-Msi.ps1','operator.json') {
    $file=Join-Path $tools $name
    $saved=(Get-Acl -LiteralPath $file).Sddl
    $unsafe=Get-Acl -LiteralPath $file
    $unsafe.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]'S-1-1-0','Write','Allow'))
    Set-Acl -LiteralPath $file -AclObject $unsafe
    $rejected=$false
    try{Test-MsiTools $tools $toolMetaHash | Out-Null}catch{$rejected=$_.Exception.Message -match 'Operator state permits untrusted writes'}
    Require $rejected 'Writable snapshot tool/metadata passed hash-only verification'
    $restore=Get-Acl -LiteralPath $file
    $restore.SetSecurityDescriptorSddlForm($saved)
    Set-Acl -LiteralPath $file -AclObject $restore
}
$savedMeta=Join-Path $root 'retained-metadata.json'
Move-Item -LiteralPath $toolMeta -Destination $savedMeta
New-Item -ItemType HardLink -Path $toolMeta -Target $savedMeta | Out-Null
$rejected=$false
try{Test-MsiTools $tools $toolMetaHash | Out-Null}catch{$rejected=$_.Exception.Message -match 'Invalid operator state file'}
Require $rejected 'Hard-linked recovery metadata was accepted'
Remove-Item -LiteralPath $toolMeta -Force
Move-Item -LiteralPath $savedMeta -Destination $toolMeta
$originalMeta=[IO.File]::ReadAllBytes($toolMeta)
[IO.File]::WriteAllText($toolMeta,('x'*32769))
$rejected=$false
try{Test-MsiTools $tools | Out-Null}catch{$rejected=$_.Exception.Message -match 'Invalid operator state file'}
Require $rejected 'Oversized recovery metadata was accepted'
[IO.File]::WriteAllBytes($toolMeta,$originalMeta)
Test-MsiTools $tools $toolMetaHash | Out-Null
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
    $parseErrors=$null
    $managerAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Manage-Trial.ps1'),[ref]$null,[ref]$parseErrors)
    $resolveDefinition=@($managerAst.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-MsiReceipt'},$false))
    Invoke-Expression $resolveDefinition[0].Extent.Text
    $terminal.state='terminal';$terminal.exitCode=0;$terminal.toolsSha256=$toolMetaHash
    Write-MsiReceipt $path $terminal
    $receiptPath=$path;$operatorDirectory=$root
    $originalInstallerState=${function:Get-InstallerState}
    try {
        function Get-InstallerState {'busy'}
        $blocked=$false
        try{Resolve-MsiReceipt | Out-Null}catch{$blocked=$_.Exception.Message -eq 'Windows Installer is busy; resolution refused'}
        Require ($blocked -and (Read-MsiReceipt $path).state -eq 'terminal') 'Busy installer cleared terminal fence'
        function Get-InstallerState {'unavailable'}
        $blocked=$false
        try{Resolve-MsiReceipt | Out-Null}catch{$blocked=$_.Exception.Message -eq 'Windows Installer state unavailable; resolution refused'}
        Require ($blocked -and (Read-MsiReceipt $path).state -eq 'terminal') 'Unknown installer state cleared terminal fence'
    } finally {Set-Item -Path Function:\Get-InstallerState -Value $originalInstallerState}
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
    Write-Host 'DI_OPERATOR_STATE_TESTS passed: atomic read snapshots, lock, intent, late completion, no kill/replay, deferred outcomes, missing PID, corruption'
} finally {$worker.Dispose()}
