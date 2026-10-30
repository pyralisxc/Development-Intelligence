param([Parameter(Mandatory)][string]$OperatorRoot,[Parameter(Mandatory)][string]$MsiPath,[Parameter(Mandatory)][ValidateSet('/i','/x')][string]$Verb,[Parameter(Mandatory)][string]$PackageRoot,[switch]$CorruptManifest)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:COMPUTERNAME -eq 'OAKLEY') { throw 'MSI reconciliation tests require disposable hosted Windows' }
$serviceName='DevelopmentIntelligenceTrial'
$data=Join-Path $env:ProgramData $serviceName
$operatorDirectory=Join-Path $data 'config'
$receiptPath=Join-Path $operatorDirectory 'operator-msi.json'
$management=Join-Path $OperatorRoot 'Manage-Trial.ps1'
$operatorScripts=$OperatorRoot
. (Join-Path $OperatorRoot 'Operator-State.ps1')
# Reuse the exact operator functions with a one-millisecond caller wait. There is
# no shipped CLI fault switch, modified installed script or fake installer.
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($management,[ref]$null,[ref]$errors)
if($errors){throw 'Operator parse failed'}
foreach($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) { Invoke-Expression $definition.Extent.Text }
$operatorLock=Enter-OperatorLock (Join-Path $operatorDirectory 'operator.lock')
$uncertain=$false
try {
    $originalReceiptHash=if(Test-Path -LiteralPath $receiptPath){(Get-FileHash $receiptPath).Hash}else{''}
    $badPinRefused=$false
    try {Invoke-Msi $Verb $MsiPath ('0'*64) '' 1} catch {$badPinRefused=$_.Exception.Message -match 'checksum mismatch'}
    $afterReceiptHash=if(Test-Path -LiteralPath $receiptPath){(Get-FileHash $receiptPath).Hash}else{''}
    if(!$badPinRefused -or $originalReceiptHash -ne $afterReceiptHash){throw 'Unapproved MSI pin was re-baselined or created intent'}
    if($CorruptManifest){[IO.File]::WriteAllText((Join-Path (Installed-Root) 'manifest.json'),'{malformed candidate')}
    Invoke-Msi $Verb $MsiPath (Get-FileHash $MsiPath).Hash '' 1
} catch {$uncertain=$_.Exception.Message -match 'DI_MSI_UNCERTAIN'} finally {$operatorLock.Dispose()}
if(!$uncertain){throw 'Real MSI caller deadline was not observed'}
$refused=$false
try {& $management -Action Start | Out-Null} catch {$refused=$_.Exception.Message -match 'DI_MSI_UNCERTAIN'}
if(!$refused){throw 'Pending MSI allowed a new mutation'}
$deadline=[Diagnostics.Stopwatch]::StartNew()
do {
    $observation=& $management -Action Reconcile
    if($observation.state -eq 'terminal'){break}
    Start-Sleep -Milliseconds 200
} while($deadline.ElapsedMilliseconds -lt 120000)
if($observation.state -ne 'terminal' -or $observation.exitCode -ne 0 -or $observation.mutationAllowed){throw 'Real waiter did not retain successful terminal evidence behind fence'}
$resolved=& $management -Action Resolve
if(!$resolved.mutationAllowed){throw 'Explicit verified resolution did not release fence'}
if((Get-Service $serviceName -ErrorAction SilentlyContinue) -and (Get-Service $serviceName).Status -ne 'Stopped'){throw 'Resolution unexpectedly activated a service'}
@{verb=$Verb;approvedHashRefusal=$badPinRefused;malformedManifestRemoval=[bool]$CorruptManifest;deadlineObserved=$uncertain;pendingMutationRefused=$refused;terminalExitCode=$observation.exitCode;explicitResolution=$true;activationPerformed=$false;replayPerformed=$false;productionAccess=$false} | ConvertTo-Json | Set-Content (Join-Path $PackageRoot ('operator-reconciliation-'+$(if($Verb -eq '/i'){'install'}else{'uninstall'})+'.json'))
