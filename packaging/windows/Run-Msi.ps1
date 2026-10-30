param([Parameter(Mandatory)][string]$ReceiptPath,[Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{32}$')][string]$OperationId)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$PSModuleAutoLoadingPreference='None'
foreach ($module in 'Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management','Microsoft.PowerShell.Security') { Import-Module (Join-Path $PSHOME ('Modules\'+$module+'\'+$module+'.psd1')) -ErrorAction Stop }
. (Join-Path $PSScriptRoot 'Operator-State.ps1')
$packageGuard=$null
try {
    Assert-OperatorDirectory (Split-Path $ReceiptPath)
    $record=Read-MsiReceipt $ReceiptPath
    if ($record.operationId -ne $OperationId -or $record.state -ne 'intent') { throw 'Invalid MSI launch intent' }
    $record.state='starting'
    $record.workerPid=$PID
    $record.workerStartTicks=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString()
    Write-MsiReceipt $ReceiptPath $record
    $packageGuard=[IO.File]::Open($record.packagePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    if ((Get-FileHash -LiteralPath $record.packagePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $record.sha256) { throw 'MSI package changed before launch' }
    $arguments=@($record.verb,('"'+$record.packagePath+'"'),'/qn','/norestart')
    if ($record.descriptorHash) { $arguments+=('DI_CHECKED_DESCRIPTOR_SHA256='+$record.descriptorHash) }
    $installer=Start-Process (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $record.msiPid=$installer.Id
    $record.msiStartTicks=$installer.StartTime.ToUniversalTime().Ticks.ToString()
    $record.state='running'
    Write-MsiReceipt $ReceiptPath $record
    # Transient observer holds the actual child handle through exit, including
    # beyond the operator's wait deadline. No service, task, retry or kill.
    $installer.WaitForExit()
    $record.exitCode=$installer.ExitCode
    $record.state='terminal'
    Write-MsiReceipt $ReceiptPath $record
    $installer.Dispose()
} catch {
    # Intent remains fail-closed if launch/observation/persistence is interrupted.
    [Console]::Error.WriteLine('MSI waiter could not retain terminal evidence; use Reconcile; do not replay')
    exit 1
} finally { if($packageGuard){$packageGuard.Dispose()} }
