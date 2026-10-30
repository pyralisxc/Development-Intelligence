param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][string]$WorkloadPath,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$Revision,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$AdvancedHead,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$EngineSha,
    [Parameter(Mandatory)]$Spec,
    [Parameter(Mandatory)]$Startup
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:COMPUTERNAME -eq 'OAKLEY') { throw 'Recovery tests require a disposable GitHub-hosted Windows runner' }
$serviceName = 'DevelopmentIntelligenceTrial'
$dataRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramData $serviceName))
$expectedSource = Join-Path $dataRoot 'test-data\workload'
$offlineSource = Join-Path $dataRoot 'test-data\workload-offline'
if ([IO.Path]::GetFullPath($WorkloadPath) -ne $expectedSource -or (Test-Path -LiteralPath $offlineSource)) { throw 'Unexpected fixture rename target' }
foreach ($target in $dataRoot,(Join-Path $dataRoot 'test-data'),$WorkloadPath) {
    if ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Fixture reparse boundary refused' }
}
$management = Join-Path $RuntimeRoot 'Manage-Trial.ps1'
$receiptPath = Join-Path $PackageRoot 'workload-recovery.json'
$events = [Collections.Generic.List[object]]::new()
$samples = [Collections.Generic.List[object]]::new()
$clock = [Diagnostics.Stopwatch]::StartNew()
$receipt = @{formatVersion=1;engineSha=$EngineSha;productionAccess=$false;unsigned=$true;status='incomplete';specimen='exact-DI-source-plus-synthetic-polyglot';sourceRevision=$Revision;advancedHead=$AdvancedHead;input=$Spec;startupContention=$Startup;measurements=$samples;phases=$events;limits=@{nodeHeapMB=768;buildConcurrency=1;graphCacheEntries=2;graphCacheRecords=50000};capacityAcceptance='not-established';rebootProof='not-run';powerProof='not-run';warmScope='repeated identical queries; no speed threshold or guaranteed cache residency'}
function Save-RecoveryReceipt { [IO.File]::WriteAllText($receiptPath,($receipt | ConvertTo-Json -Depth 12)) }
function Recovery-Phase([string]$Label) {
    if ($events.Count -ge 32 -or $Label -notmatch '^[a-z-]{1,64}$') { throw 'Invalid recovery phase' }
    $events.Add(@{phase=$Label;elapsedMs=$clock.ElapsedMilliseconds})
    Save-RecoveryReceipt
    Write-Host ('DI_RECOVERY_PHASE '+$Label)
}
function Require-Recovery($Condition,[string]$Message) { if (!$Condition) { throw $Message } }
function Recovery-Health { Invoke-RestMethod 'http://127.0.0.1:8788/managed-health' -TimeoutSec 3 }
function Recovery-Rpc([string]$Tool,$Arguments) {
    $body = @{jsonrpc='2.0';id=1;method='tools/call';params=@{name=$Tool;arguments=$Arguments}} | ConvertTo-Json -Depth 12
    Invoke-RestMethod 'http://127.0.0.1:8788/mcp' -Method Post -ContentType 'application/json' -Headers @{Authorization="Bearer $Token"} -Body $body -TimeoutSec 180
}
function Rpc-Failed($Response) {
    [bool]($Response.PSObject.Properties['error'] -or ($Response.PSObject.Properties['result'] -and $Response.result.PSObject.Properties['isError'] -and $Response.result.isError))
}
function Measure-Replay([string]$Label,[string]$GraphId='') {
    $healthNow = Recovery-Health
    $before = Get-Process -Id $healthNow.pid
    $beforeCpu = $before.TotalProcessorTime.TotalSeconds
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $arguments = @{project='workload';query='historicalOnly';layers=@('structural');limit=20}
    if ($GraphId) { $arguments.graphId=$GraphId } else { $arguments.ref="commit:$Revision" }
    $response = Recovery-Rpc 'search_graph' $arguments
    Require-Recovery (!(Rpc-Failed $response)) 'Exact workload graph query failed'
    $answer = $response.result.structuredContent
    Require-Recovery ($answer.revision -eq $Revision) 'Workload query substituted source revision'
    Require-Recovery (@($answer.nodes).Count -gt 0) 'Historical symbol was not reconstructed'
    $after = Get-Process -Id $healthNow.pid
    $samples.Add(@{operation='search_graph-historical-symbol';phase=$Label;elapsedMs=$timer.ElapsedMilliseconds;nodePid=$healthNow.pid;workingSetBytes=$after.WorkingSet64;privateBytes=$after.PrivateMemorySize64;processLifetimePeakWorkingSetBytes=$after.PeakWorkingSet64;cpuSecondsDelta=($after.TotalProcessorTime.TotalSeconds-$beforeCpu);graphId=$answer.graphId;revision=$answer.revision;nodeTotal=$answer.nodeTotal;edgeTotal=$answer.edgeTotal})
    Save-RecoveryReceipt
    $answer
}
try {
    $hostFacts = Get-CimInstance Win32_ComputerSystem -OperationTimeoutSec 10
    $receipt.host = @{platform='windows-2022-github-hosted';logicalProcessors=$hostFacts.NumberOfLogicalProcessors;totalMemoryBytes=$hostFacts.TotalPhysicalMemory;nodeVersion=(Recovery-Health).node;memoryScope='Node process only; excludes wrapper, parsers and Git children';timingScope='end-to-end HTTP operation, not latency SLA'}
    Recovery-Phase 'cold-and-warm'
    $cold = Measure-Replay 'cold'
    $graphId = $cold.graphId
    $identities = @($cold.nodes.id | Sort-Object)
    for ($i=0;$i -lt 3;$i++) {
        $warm = Measure-Replay 'warm' $graphId
        Require-Recovery ($warm.graphId -eq $graphId -and $warm.nodeTotal -eq $cold.nodeTotal) 'Warm query identity/count changed'
    }
    $latest = Recovery-Rpc 'search_graph' @{project='workload';graphId=$graphId;query='latestOnly';layers=@('structural');limit=20}
    Require-Recovery (!(Rpc-Failed $latest) -and $latest.result.structuredContent.nodeTotal -eq 0) 'Exact historical graph contains advanced-head symbol'
    $scan = Recovery-Rpc 'scan_graph' @{project='workload';ref="commit:$Revision"}
    Require-Recovery (!(Rpc-Failed $scan) -and $scan.result.structuredContent.revision -eq $Revision) 'Workload scan failed'
    $receipt.graph = @{graphId=$graphId;nodeCount=$scan.result.structuredContent.nodeCount;edgeCount=$scan.result.structuredContent.edgeCount;symbolIds=$identities}
    # Kill exactly the Node child proven to belong to this service. No fault
    # hook ships in the runtime; no manual Start masks failed automatic recovery.
    Recovery-Phase 'owned-child-crash'
    $oldHealth = Recovery-Health
    $ownedService = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -OperationTimeoutSec 10
    $ownedChild = Get-CimInstance Win32_Process -Filter "ProcessId=$($oldHealth.pid)" -OperationTimeoutSec 10
    Require-Recovery ($ownedChild.ParentProcessId -eq $ownedService.ProcessId -and $ownedChild.ExecutablePath -eq (Join-Path $RuntimeRoot 'node\node.exe')) 'Crash target is not owned Node child'
    $oldProcess = Get-Process -Id $oldHealth.pid
    $crashTimer = [Diagnostics.Stopwatch]::StartNew()
    $oldProcess.Kill()
    Require-Recovery ($oldProcess.WaitForExit(5000)) 'Crashed child did not exit'
    $recovered = $null
    while ($crashTimer.ElapsedMilliseconds -lt 90000) {
        try {
            $candidate = Recovery-Health
            if ($candidate.ready -and $candidate.engineSha -eq $EngineSha -and $candidate.packagingSha -eq $EngineSha -and $candidate.pid -ne $oldHealth.pid) { $recovered=$candidate; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    Require-Recovery ($null -ne $recovered) 'Automatic recovery deadline exceeded; no manual activation attempted'
    $newService = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -OperationTimeoutSec 10
    $newChild = Get-CimInstance Win32_Process -Filter "ProcessId=$($recovered.pid)" -OperationTimeoutSec 10
    Require-Recovery ($newChild.ParentProcessId -eq $newService.ProcessId -and $newService.State -eq 'Running') 'Recovered child is not service-owned'
    $receipt.crash = @{elapsedMs=$crashTimer.ElapsedMilliseconds;oldNodePid=$oldHealth.pid;newNodePid=$recovered.pid;oldWrapperPid=$ownedService.ProcessId;newWrapperPid=$newService.ProcessId;manualActivation=$false;scope='one first-failure automatic recovery; not repeated-crash availability'}
    $replayed = Measure-Replay 'after-crash' $graphId
    Require-Recovery ($replayed.graphId -eq $graphId -and (@($replayed.nodes.id | Sort-Object) -join ',') -eq ($identities -join ',')) 'Crash reconstruction changed graph identity'
    Recovery-Phase 'stop-and-scratch-loss'
    & $management -Action Stop
    Require-Recovery ((Get-Service $serviceName).Status -eq 'Stopped') 'Service did not stop before source loss'
    Require-Recovery (!(Get-Process -Id $recovered.pid -ErrorAction SilentlyContinue)) 'Recovery child survived stop'
    $scratch = Join-Path $dataRoot 'scratch'
    Require-Recovery (@(Get-ChildItem -LiteralPath $scratch -Force).Count -eq 0) 'Stopped scratch was not cleared'
    $receipt.scratchClearedBeforeOffline=$true
    # Same-parent rename only, exact allowlisted disposable paths checked above.
    Move-Item -LiteralPath $WorkloadPath -Destination $offlineSource
    try {
        Recovery-Phase 'offline-fresh-process'
        $offlineHealth = & $management -Action Start
        Require-Recovery ($offlineHealth.pid -ne $recovered.pid) 'Offline proof reused old process cache'
        $offlineTimer = [Diagnostics.Stopwatch]::StartNew()
        $offlineResult = Recovery-Rpc 'search_graph' @{project='workload';graphId=$graphId;query='historicalOnly';limit=20}
        Require-Recovery (Rpc-Failed $offlineResult) 'Unavailable source incorrectly returned a graph'
        if ($offlineResult.PSObject.Properties['result'] -and $offlineResult.result.PSObject.Properties['structuredContent']) { throw 'Offline failure returned graph data' }
        $receipt.offline = @{elapsedMs=$offlineTimer.ElapsedMilliseconds;failedExplicitly=$true;returnedGraphData=$false;freshProcess=$true;source='local configured Git source renamed; not provider/network outage'}
    } finally {
        # Restore the configured source even if the assertion failed. Never
        # overwrite an unexpected replacement or reuse uncertain installer state.
        if ((Test-Path -LiteralPath $offlineSource) -and !(Test-Path -LiteralPath $WorkloadPath)) { Move-Item -LiteralPath $offlineSource -Destination $WorkloadPath }
    }
    Recovery-Phase 'restore-and-exact-reconstruction'
    $rebuilt = Measure-Replay 'after-source-restore' $graphId
    Require-Recovery ($rebuilt.graphId -eq $graphId -and $rebuilt.nodeTotal -eq $cold.nodeTotal -and (@($rebuilt.nodes.id | Sort-Object) -join ',') -eq ($identities -join ',')) 'Restored graph differs from original immutable identity'
    $restoredScan = Recovery-Rpc 'scan_graph' @{project='workload';ref="commit:$Revision"}
    Require-Recovery (!(Rpc-Failed $restoredScan) -and $restoredScan.result.structuredContent.nodeCount -eq $receipt.graph.nodeCount -and $restoredScan.result.structuredContent.edgeCount -eq $receipt.graph.edgeCount) 'Reconstructed graph counts changed'
    Require-Recovery ((& git -C $WorkloadPath -c safe.directory=$WorkloadPath rev-parse HEAD).Trim() -eq $AdvancedHead) 'Fixture did not retain distinct advanced main'
    Require-Recovery ((Recovery-Health).role -eq 'compute-only') 'Recovery changed fixed authority role'
    $receipt.status='passed'
    Recovery-Phase 'passed'
} finally { Save-RecoveryReceipt }
