param([Parameter(Mandatory)][string]$PackageRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:COMPUTERNAME -eq 'OAKLEY') { throw 'Installation tests require a disposable GitHub-hosted Windows runner' }
$name = 'DevelopmentIntelligenceTrial'
$data = Join-Path $env:ProgramData $name
$first = Get-ChildItem (Join-Path $PackageRoot '2.9.237') -Filter '*.msi' | Select-Object -First 1
$second = Get-ChildItem (Join-Path $PackageRoot '2.9.238') -Filter '*.msi' | Select-Object -First 1
$unhealthy = Get-ChildItem (Join-Path $PackageRoot '2.9.239') -Filter '*.msi' | Select-Object -First 1
$incompatible = Get-ChildItem (Join-Path $PackageRoot '2.9.240') -Filter '*.msi' | Select-Object -First 1
function Assert($condition, [string]$message) { if (!$condition) { throw $message } }
function Phase([ValidatePattern('^[a-z][a-z0-9-]{0,63}$')][string]$Label) {
    if ($phaseEvents.Count -ge 64) { throw 'Fixture phase receipt bound exceeded' }
    $phaseEvents.Add(@{phase=$Label;utc=[DateTime]::UtcNow.ToString('o');elapsedMs=$phaseClock.ElapsedMilliseconds})
    [IO.File]::WriteAllText((Join-Path $PackageRoot 'lifecycle-phases.json'), (@{formatVersion=1;engineSha=$fixtureEngineSha;productionAccess=$false;phases=$phaseEvents.ToArray()} | ConvertTo-Json -Depth 5))
    Write-Host ('DI_LIFECYCLE_PHASE ' + $Label)
}
$phaseClock = [Diagnostics.Stopwatch]::StartNew()
$phaseEvents = [Collections.Generic.List[object]]::new()
$fixtureEngineSha = (& git rev-parse HEAD).Trim()
Assert ($fixtureEngineSha -match '^[a-f0-9]{40}$') 'Exact fixture engine identity required'
function Msi-Exit([string[]]$Arguments) {
    $p = Start-Process msiexec.exe -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    try {
        if (!$p.WaitForExit(300000)) {
            Phase 'msi-deadline-outcome-uncertain'
            throw 'Fixture MSI deadline exceeded; operation outcome uncertain; do not retry this runner'
        }
        $p.ExitCode
    } finally { $p.Dispose() }
}
function Msi([string]$verb, [string]$target) {
    $exitCode = Msi-Exit -Arguments @($verb, ('"'+$target+'"'), '/qn', '/norestart', '/l*v', ('"'+$target+'.install.log"'))
    Assert ($exitCode -eq 0) "MSI operation failed: $exitCode"
}
function Runtime {
    $svc = Get-CimInstance Win32_Service -Filter "Name='$name'"
    Assert ($svc.PathName -match '^"?(.+DevelopmentIntelligenceTrial\.exe)"?$') 'Unexpected service executable'
    Split-Path $Matches[1]
}
function Manage([string]$action) { & (Join-Path (Runtime) 'Manage-Trial.ps1') -Action $action }
function Health { Invoke-RestMethod 'http://127.0.0.1:8788/managed-health' -TimeoutSec 10 }
function Rpc([string]$tool, $arguments) {
    $body = @{ jsonrpc='2.0'; id=1; method='tools/call'; params=@{ name=$tool; arguments=$arguments } } | ConvertTo-Json -Depth 20
    Invoke-RestMethod 'http://127.0.0.1:8788/mcp' -Method Post -ContentType 'application/json' -Headers @{Authorization="Bearer $token"} -Body $body -TimeoutSec 60
}
Phase 'install-first'
Msi '/i' $first.FullName
$initial = Get-CimInstance Win32_Service -Filter "Name='$name'"
Assert ($initial.State -eq 'Stopped' -and $initial.StartMode -eq 'Manual') 'Install must be stopped/manual'
Assert ($initial.StartName -eq 'NT AUTHORITY\LocalService') 'Restricted LocalService identity required'
Assert (!(Test-Path (Join-Path $data 'config\service.json'))) 'Installer must not create credentials'
$sidConfig = & sc.exe qsidtype $name
Assert (($sidConfig -join '') -match 'UNRESTRICTED') 'Service SID was not installed'
$runtime = Runtime
Assert (!(Test-Path (Join-Path $runtime 'app\dist\src\untracked-package-poison.js'))) 'Untracked caller source leaked into exact-SHA package'
Assert ((Get-Acl (Join-Path $data 'scratch')).Sddl -match 'S-1-5-80-') 'Scratch must have service SID ACL'
Assert ((Get-Acl $runtime).Sddl -notmatch '\(A;[^)]*;FA;;;LS\)') 'LocalService must not own binaries'
Phase 'unconfigured-start-refusal'
try { Manage 'Start'; throw 'Unconfigured start unexpectedly succeeded' } catch { Assert ($_.Exception.Message -match 'configuration') 'Wrong unconfigured failure' }
Phase 'fixture-and-protected-credentials'
$fixture = Join-Path $data 'test-data\repository'
New-Item -ItemType Directory -Path $fixture | Out-Null
$samples = @{ 'sample.cs'='public class Sample { public int Count { get; set; } }'; 'Sample.java'='public class Sample { public int count() { return 1; } }'; 'sample.py'="def count():`n    return 1" }
$samples.GetEnumerator() | ForEach-Object { [IO.File]::WriteAllText((Join-Path $fixture $_.Key), $_.Value) }
& git init --initial-branch=main $fixture
& git -C $fixture add .
& git -C $fixture -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture
$revision = (& git -C $fixture rev-parse HEAD).Trim()
$workload = Join-Path $data 'test-data\workload'
$workloadSpec = (& node (Join-Path $PSScriptRoot 'workload-fixture.mjs') $workload) | ConvertFrom-Json
Assert ($LASTEXITCODE -eq 0) 'Workload generation failed'
$corpusArchive = Join-Path $PackageRoot 'engine-source.zip'
& git archive --format=zip "--output=$corpusArchive" HEAD src package.json
Assert ($LASTEXITCODE -eq 0) 'Exact committed engine corpus export failed'
Expand-Archive -LiteralPath $corpusArchive -DestinationPath (Join-Path $workload 'engine')
$inputFiles = @(Get-ChildItem -LiteralPath $workload -Recurse -File)
$workloadSpec = @{synthetic=$workloadSpec;engineSourceSha=$fixtureEngineSha;engineArchiveSha256=(Get-FileHash $corpusArchive).Hash.ToLowerInvariant();totalFiles=$inputFiles.Count;totalSourceBytes=($inputFiles | Measure-Object Length -Sum).Sum}
& git init --initial-branch=main $workload
& git -C $workload add .
& git -C $workload -c user.name=Fixture -c user.email=fixture@example.invalid commit -m historical-workload
$workloadRevision = (& git -C $workload rev-parse HEAD).Trim()
[IO.File]::WriteAllText((Join-Path $workload 'revision.ts'), 'export function latestOnly(): string { return "new"; }')
& git -C $workload add .
& git -C $workload -c user.name=Fixture -c user.email=fixture@example.invalid commit -m advance-main
$workloadHead = (& git -C $workload rev-parse HEAD).Trim()
Assert ($workloadRevision -match '^[a-f0-9]{40}$' -and $workloadHead -ne $workloadRevision) 'Distinct immutable workload revisions required'
& icacls.exe $workload /setowner 'NT AUTHORITY\LocalService' /T /Q | Out-Null
Assert ($LASTEXITCODE -eq 0) 'Workload ownership setup failed'
& icacls.exe $fixture /setowner 'NT AUTHORITY\LocalService' /T /Q | Out-Null
Assert ($LASTEXITCODE -eq 0) 'Fixture ownership setup failed'
$token = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$project = @{ repository=([Uri]($fixture.Replace('\','/')+'/')).AbsoluteUri; defaultRef='main'; allowedRefs=@('main'); revisionPolicy='repository-history'; credential=@{type='none'} }
$config = @{ formatVersion=2; authMode='bearer'; agentToken=$token; projects=@{ fixture=$project; orphan=$project; 'private-uncontacted'=@{repository='https://github.com/fixture/uncontacted.git';defaultRef='HEAD';credential=@{type='github-app-bound';binding='managed-github-app'}} }; githubApp=@{appId='123456';privateKeyFile='github-app.pem'}; remoteStorage=@{storeId='fixture-store';token='fixture-write-capable-looking-token'} }
$workloadProject = $project.Clone()
$workloadProject.repository = ([Uri]($workload.Replace('\','/')+'/')).AbsoluteUri
$config.projects.workload = $workloadProject
# Generated only on this disposable runner. Never contact the configured fake
# private repository or write generated material to uploaded artifacts/logs.
$rsa = [Security.Cryptography.RSA]::Create(2048)
$fakePrivatePem = $rsa.ExportPkcs8PrivateKeyPem()
$rsa.Dispose()
$keyPath = Join-Path $data 'config\github-app.pem'
[IO.File]::WriteAllText($keyPath,$fakePrivatePem)
$serviceSid = ([Security.Principal.NTAccount]"NT SERVICE\$name").Translate([Security.Principal.SecurityIdentifier])
$policySid = (& node --input-type=module -e "import {MANAGED_SERVICE_SID} from './packaging/windows/managed-credentials.mjs'; console.log(MANAGED_SERVICE_SID)").Trim()
Assert ($serviceSid.Value -eq $policySid) 'Pinned policy service SID differs from actual installed Windows service identity'
$keyAcl = [Security.AccessControl.FileSecurity]::new()
$keyAcl.SetAccessRuleProtection($true,$false)
$keyAcl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
foreach ($sid in 'S-1-5-18','S-1-5-32-544') { $keyAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]$sid,'FullControl','Allow')) }
$keyAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($serviceSid,'ReadAndExecute','Allow'))
Set-Acl -LiteralPath $keyPath -AclObject $keyAcl
$keyHash = (Get-FileHash -LiteralPath $keyPath).Hash
[IO.File]::WriteAllText((Join-Path $data 'config\service.json'), ($config | ConvertTo-Json -Depth 10))
[IO.File]::WriteAllText((Join-Path $data 'test-data\retained-authority-fixture.json'), '{"fixtureOnly":true,"acceptedRevision":"retained"}')
$configHash = (Get-FileHash (Join-Path $data 'config\service.json')).Hash
$aclReceipt = @{}
foreach ($target in @{dataRoot=$data;configDirectory=(Join-Path $data 'config');configFile=(Join-Path $data 'config\service.json');keyFile=$keyPath}.GetEnumerator()) {
    $acl = Get-Acl -LiteralPath $target.Value
    $aclReceipt[$target.Key] = @{owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$acl.AreAccessRulesProtected;rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {@{sid=$_.IdentityReference.Value;rights=[long]$_.FileSystemRights;type=[string]$_.AccessControlType}})}
}
# Nonsecret native ACL evidence only; never serialize the configuration/key.
$aclReceipt | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $PackageRoot 'credential-acl-receipt.json')
Phase 'configured-start'
# One finite CPU peer is controlled contention, not a saturation/capacity model.
$peer = Start-Process node -ArgumentList @('-e','"const end=Date.now()+45000;while(Date.now()<end){}"') -WindowStyle Hidden -PassThru
$startupClock = [Diagnostics.Stopwatch]::StartNew()
try {
    $health = Manage 'Start'
    $peer.Refresh()
    $startupMeasurement = @{elapsedMs=$startupClock.ElapsedMilliseconds;peerCpuSeconds=$peer.TotalProcessorTime.TotalSeconds;peerExitedBeforeReady=$peer.HasExited;peerMaximumMs=45000;peerCount=1}
    Assert ($startupMeasurement.peerCpuSeconds -gt 0) 'Startup peer did not establish CPU work'
    if ($peer.HasExited) { Assert ($peer.ExitCode -eq 0) 'Startup CPU peer failed before readiness' }
} finally {
    if (!$peer.HasExited) { $peer.Kill(); [void]$peer.WaitForExit(5000) }
    $peer.Dispose()
}
Assert ($health.descriptor.engineSha -eq $health.engineSha) 'Exact-source descriptor identity missing'
Assert ($health.capabilities.repositoryAuthentication.configuration -eq 'locally-validated' -and $health.capabilities.repositoryAuthentication.providerAuthentication -eq 'not-probed') 'Restricted service did not validate protected key, or falsely claimed provider access'
Assert ($health.capabilities.host.logicalProcessors -gt 0 -and $health.capabilities.host.totalMemoryBytes -gt 0) 'Observed node resource facts missing'
Assert ($health.capabilities.declared.workloads.incrementalPublication -eq 'unsupported') 'Unsupported workload must not be advertised'
Phase 'capability-preflight'
$preflight = Manage 'Preflight'
Assert ($preflight.canActivate -and $preflight.replay.softwareCompatibility -eq 'supported') 'Replay preflight failed'
Assert ($preflight.remote.readCompatibility -eq 'unavailable' -and $preflight.remote.currentness -eq 'not-verified') 'Fake remote credential availability was not reported honestly'
Assert (($preflight | ConvertTo-Json -Depth 20) -notmatch [regex]::Escape($token)) 'Preflight disclosed credentials'
Assert (($preflight | ConvertTo-Json -Depth 20) -notmatch [regex]::Escape(($fakePrivatePem -split "`n")[1])) 'Preflight disclosed private material'
# Operator preflight refuses bad local material without stopping the valid
# running service. Direct service start independently repeats the same checks.
Phase 'credential-refusal-checks'
$credentialManagement = Join-Path (Runtime) 'Manage-Trial.ps1'
$protectedPid = $health.pid
function Assert-CredentialRefusal([string]$ExpectedRefusal='preflight refused') {
    $report = Manage 'Preflight'
    Assert (!$report.canActivate) 'Unsafe credential material passed preflight'
    $rejected = $false
    try { & $credentialManagement -Action Update -Msi $second.FullName -ExpectedSha256 (Get-FileHash $second.FullName).Hash -PreviousMsi $first.FullName -PreviousSha256 (Get-FileHash $first.FullName).Hash | Out-Null } catch { $rejected = $_.Exception.Message -match [regex]::Escape($ExpectedRefusal) }
    Assert $rejected 'Invalid credential did not refuse update before disruption'
    Assert ((Health).pid -eq $protectedPid) 'Credential refusal disrupted valid service'
}
[IO.File]::WriteAllText($keyPath,'malformed disposable fixture')
Assert-CredentialRefusal
[IO.File]::WriteAllText($keyPath,$fakePrivatePem)
$unsafeAcl = Get-Acl -LiteralPath $keyPath
$unsafeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]'S-1-1-0','Read','Allow'))
Set-Acl -LiteralPath $keyPath -AclObject $unsafeAcl
Assert-CredentialRefusal
Set-Acl -LiteralPath $keyPath -AclObject $keyAcl
Move-Item -LiteralPath $keyPath -Destination ($keyPath+'.retained-fixture')
Assert-CredentialRefusal
New-Item -ItemType HardLink -Path $keyPath -Target ($keyPath+'.retained-fixture') | Out-Null
Assert-CredentialRefusal
Remove-Item -LiteralPath $keyPath -Force
Move-Item -LiteralPath ($keyPath+'.retained-fixture') -Destination $keyPath
$deniedAcl = Get-Acl -LiteralPath $keyPath
$deniedAcl.PurgeAccessRules($serviceSid)
Set-Acl -LiteralPath $keyPath -AclObject $deniedAcl
Assert-CredentialRefusal
Set-Acl -LiteralPath $keyPath -AclObject $keyAcl
$configDirectory = Join-Path $data 'config'
$configSddl = (Get-Acl -LiteralPath $configDirectory).Sddl
$replaceableAcl = Get-Acl -LiteralPath $configDirectory
$replaceableAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]'S-1-1-0','Write','Allow'))
Set-Acl -LiteralPath $configDirectory -AclObject $replaceableAcl
Assert-CredentialRefusal -ExpectedRefusal 'Operator directory permits untrusted writes'
$restoredAcl = Get-Acl -LiteralPath $configDirectory
$restoredAcl.SetSecurityDescriptorSddlForm($configSddl)
Set-Acl -LiteralPath $configDirectory -AclObject $restoredAcl
$serviceConfigPath = Join-Path $configDirectory 'service.json'
$serviceConfigSddl = (Get-Acl -LiteralPath $serviceConfigPath).Sddl
$unsafeServiceConfig = Get-Acl -LiteralPath $serviceConfigPath
$unsafeServiceConfig.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]'S-1-1-0','Write','Allow'))
Set-Acl -LiteralPath $serviceConfigPath -AclObject $unsafeServiceConfig
Assert-CredentialRefusal
$restoredServiceConfig = Get-Acl -LiteralPath $serviceConfigPath
$restoredServiceConfig.SetSecurityDescriptorSddlForm($serviceConfigSddl)
Set-Acl -LiteralPath $serviceConfigPath -AclObject $restoredServiceConfig
Assert ((Get-FileHash $keyPath).Hash -eq $keyHash) 'Fixture restoration changed key bytes'
Assert ((Health | ConvertTo-Json -Depth 20) -notmatch [regex]::Escape(($fakePrivatePem -split "`n")[1])) 'Health disclosed private material'
Assert ((Health).pid -eq $health.pid) 'Non-listening preflight disrupted the running service'
Assert ($health.role -eq 'compute-only' -and $health.authority -eq 'remote-read-only') 'Managed role must be fixed even with remote credentials configured'
Phase 'compute-only-denials'
foreach ($route in '/workbench/reconcile-canonical','/workbench/semantics/change-verify') {
    $denied = Invoke-WebRequest ("http://127.0.0.1:8788"+$route) -Method Post -Headers @{Authorization="Bearer $token"} -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck -TimeoutSec 10
    Assert ($denied.StatusCode -eq 403 -and $denied.Content -match 'COMPUTE_ONLY_AUTHORITY_DENIED') 'Managed authority mutation route was not denied'
}
$deniedScan = Rpc 'scan_graph' @{project='fixture'}
Assert ($deniedScan.result.isError -and ($deniedScan | ConvertTo-Json -Depth 10) -match 'immutable') 'Current/default W publication must be denied'
$nodeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($health.pid)"
$owner = Invoke-CimMethod -InputObject $nodeProcess -MethodName GetOwner
Assert ($owner.User -eq 'LOCAL SERVICE') 'Actual Node must run as LocalService'
Phase 'exact-replay'
$result = Rpc 'scan_graph' @{project='fixture';ref="commit:$revision"}
Assert (!$result.PSObject.Properties['error'] -and !($result.result.PSObject.Properties['isError'] -and $result.result.isError)) 'Bundled Git/native parser exact-revision scan failed'
$scan = $result.result.structuredContent
Assert ($scan.revision -eq $revision -and $scan.nodeCount -gt 3) 'Actual scan must report the exact fixture revision'
# scan_graph deliberately returns compact counts, not graph nodes. Inspect the
# declared structural query surface to prove each bundled native parser ran.
Phase 'native-symbols'
$symbols = Rpc 'search_graph' @{project='fixture';ref="commit:$revision";kinds=@('class','method','function','property');layers=@('structural');limit=100}
Assert (!$symbols.PSObject.Properties['error'] -and !($symbols.result.PSObject.Properties['isError'] -and $symbols.result.isError)) 'Native symbol query failed'
$nodes = @($symbols.result.structuredContent.nodes)
Assert (@($nodes | Where-Object kind -eq 'class').Count -eq 2) 'C#/Java class parsing failed'
Assert (@($nodes | Where-Object kind -eq 'property').Count -ge 1) 'C# property parsing failed'
Assert (@($nodes | Where-Object kind -eq 'method').Count -ge 1) 'Java method parsing failed'
Assert (@($nodes | Where-Object kind -eq 'function').Count -ge 1) 'Python function parsing failed'
try { Invoke-WebRequest 'http://127.0.0.1:8788/mcp' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null; throw 'Unauthorized request passed' } catch { Assert ($_.Exception.Response.StatusCode.value__ -eq 401) 'MCP must deny anonymous access' }
$measure = Get-Process -Id $health.pid
@{ pid=$health.pid; workingSetBytes=$measure.WorkingSet64; privateBytes=$measure.PrivateMemorySize64; cpuSeconds=$measure.CPU; engineSha=$health.engineSha } | ConvertTo-Json | Set-Content (Join-Path $PackageRoot 'resource-measurement.json')
Phase 'workload-recovery'
& (Join-Path $PSScriptRoot 'Test-WorkloadRecovery.ps1') -PackageRoot $PackageRoot -RuntimeRoot $runtime -Token $token -WorkloadPath $workload -Revision $workloadRevision -AdvancedHead $workloadHead -EngineSha $fixtureEngineSha -Spec $workloadSpec -Startup $startupMeasurement
# Recovery deliberately changes the Node PID. Refresh the owned identity used by
# the subsequent existing child-tree lifecycle proof.
$health = Health
# After genuine parser/Git proof, substitute a disposable long-lived Git child
# while the service is already running. This tests supervisor tree cleanup without
# shipping a production test hook or weakening startup payload integrity.
Phase 'process-tree-fixture'
$probeSource = Join-Path $PackageRoot 'ChildProbe.cs'
$probe = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
class ChildProbe {
  static void Main() {
    string here = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
    foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
      if (Convert.ToString(entry.Value).Contains("BEGIN PRIVATE KEY")) { File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("DEVINT_SCRATCH_DIR"),"credential-leak.flag"),"leak"); Environment.Exit(42); }
    }
    string node = Path.GetFullPath(Path.Combine(here, "..", "..", "node", "node.exe"));
    Process.Start(new ProcessStartInfo(node, "-e \"setInterval(()=>{},1000)\"") { UseShellExecute=false, CreateNoWindow=true });
    Thread.Sleep(120000);
  }
}
'@
[IO.File]::WriteAllText($probeSource, $probe)
$probeExe = Join-Path $PackageRoot 'ChildProbe.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe "/out:$probeExe" $probeSource
Assert ($LASTEXITCODE -eq 0) 'Disposable process-tree probe compilation failed'
$gitExe = Join-Path $runtime 'git\cmd\git.exe'
$gitBytes = [IO.File]::ReadAllBytes($gitExe)
Copy-Item -LiteralPath $probeExe -Destination $gitExe -Force
$job = Start-Job -ArgumentList $token,$revision -ScriptBlock {
    param($credential,$sha)
    $body = @{jsonrpc='2.0';id=1;method='tools/call';params=@{name='scan_graph';arguments=@{project='orphan';ref="commit:$sha"}}} | ConvertTo-Json -Depth 8
    try { Invoke-RestMethod 'http://127.0.0.1:8788/mcp' -Method Post -ContentType 'application/json' -Headers @{Authorization="Bearer $credential"} -Body $body -TimeoutSec 45 | Out-Null } catch { }
}
$probeProcess = $null
for ($attempt=0; $attempt -lt 40; $attempt++) {
    $probeProcess = Get-CimInstance Win32_Process -Filter "Name='git.exe'" | Where-Object ExecutablePath -eq $gitExe | Select-Object -First 1
    if ($probeProcess) { break }
    Start-Sleep -Milliseconds 100
}
Assert ($null -ne $probeProcess) 'Active owned Git probe was not observed'
Assert (!(Test-Path (Join-Path $data 'scratch\credential-leak.flag'))) 'Child process received long-lived private key'
Start-Sleep -Milliseconds 300
$probeChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($probeProcess.ProcessId)")
Assert ($probeChildren.Count -gt 0) 'Nested owned Node child was not observed'
Phase 'owned-child-stop'
Manage 'Stop'
Assert (!(Get-Process -Id $health.pid -ErrorAction SilentlyContinue)) 'Owned Node survived stop'
foreach ($childId in @($probeProcess.ProcessId) + @($probeChildren.ProcessId)) { Assert (!(Get-Process -Id $childId -ErrorAction SilentlyContinue)) 'Owned active descendant survived stop' }
Stop-Job $job
Remove-Job $job -Force
[IO.File]::WriteAllBytes($gitExe, $gitBytes)
Phase 'restart-after-child-stop'
Manage 'Start' | Out-Null
$oldManagement = Join-Path (Runtime) 'Manage-Trial.ps1'
$beforePreflight = (Health).pid
Phase 'incompatible-update-refusal'
$incompatibleRejected = $false
try { & $oldManagement -Action Update -Msi $incompatible.FullName -ExpectedSha256 (Get-FileHash $incompatible.FullName).Hash -PreviousMsi $first.FullName -PreviousSha256 (Get-FileHash $first.FullName).Hash } catch { $incompatibleRejected = $_.Exception.Message -match 'unsupported-config-format' }
Assert $incompatibleRejected 'Known incompatible candidate was not refused before service disruption'
Assert ((Health).pid -eq $beforePreflight) 'Incompatible preflight stopped the running service'
Assert ((Get-FileHash (Join-Path $data 'config\service.json')).Hash -eq $configHash) 'Incompatible preflight changed protected configuration'
# An accidental direct MSI major upgrade must also stop before StopServices.
Phase 'raw-msi-upgrade-refusal'
$directExitCode = Msi-Exit -Arguments @('/i', ('"'+$incompatible.FullName+'"'), '/qn', '/norestart')
Assert ($directExitCode -ne 0) 'Raw MSI upgrade bypassed required descriptor preflight'
Assert ((Health).pid -eq $beforePreflight) 'Raw MSI refusal disrupted the existing service'
# Internally inconsistent descriptor metadata is refused even when the caller
# supplies the fixture MSI's correct outer hash.
Phase 'corrupt-update-refusal'
$corruptMsi = Join-Path $PackageRoot 'corrupt-descriptor.msi'
Copy-Item -LiteralPath $second.FullName -Destination $corruptMsi
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase($corruptMsi,1)
$view = $database.OpenView("UPDATE ``Property`` SET ``Value``='$('0'*64)' WHERE ``Property``='DI_DESCRIPTOR_SHA256'")
[void]$view.Execute(); [void]$view.Close(); [void]$database.Commit()
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
$corruptDescriptorRejected = $false
$corruptDescriptorError = 'no exception'
try { & $oldManagement -Action Update -Msi $corruptMsi -ExpectedSha256 (Get-FileHash $corruptMsi).Hash -PreviousMsi $first.FullName -PreviousSha256 (Get-FileHash $first.FullName).Hash } catch { $corruptDescriptorError = $_.Exception.Message; $corruptDescriptorRejected = $corruptDescriptorError -match 'descriptor integrity failure' }
Assert $corruptDescriptorRejected "Corrupt descriptor refusal was not reached: $corruptDescriptorError"
Assert ((Health).pid -eq $beforePreflight) 'Corrupt descriptor refusal disrupted existing service'
$badHashRejected = $false
try { & $oldManagement -Action Update -Msi $second.FullName -ExpectedSha256 ('0'*64) -PreviousMsi $first.FullName -PreviousSha256 (Get-FileHash $first.FullName).Hash } catch { $badHashRejected = $_.Exception.Message -match 'checksum mismatch' }
Assert $badHashRejected 'Corrupt MSI input was not refused'
$wrongPriorRejected = $false
try { & $oldManagement -Action Update -Msi $second.FullName -ExpectedSha256 (Get-FileHash $second.FullName).Hash -PreviousMsi $second.FullName -PreviousSha256 (Get-FileHash $second.FullName).Hash } catch { $wrongPriorRejected = $_.Exception.Message -match 'does not match' }
Assert $wrongPriorRejected 'Wrong known-good MSI identity was not refused'
Assert ((Health).pid -eq $beforePreflight) 'Preflight refusal stopped the running service'
Phase 'healthy-update'
& $oldManagement -Action Update -Msi $second.FullName -ExpectedSha256 (Get-FileHash $second.FullName).Hash -PreviousMsi $first.FullName -PreviousSha256 (Get-FileHash $first.FullName).Hash
Assert ((Health).msiVersion -eq '2.9.238') 'Upgrade identity failed'
Assert ((Get-FileHash (Join-Path $data 'config\service.json')).Hash -eq $configHash) 'Upgrade changed protected configuration'
Assert ((Get-FileHash $keyPath).Hash -eq $keyHash) 'Upgrade changed protected key'
Phase 'restart-updated'
Manage 'Restart' | Out-Null
Phase 'unhealthy-update-rollback'
$rollbackObserved = $false
$rollbackManagement=Join-Path (Runtime) 'Manage-Trial.ps1'
try {
    & $rollbackManagement -Action Update -Msi $unhealthy.FullName -ExpectedSha256 (Get-FileHash $unhealthy.FullName).Hash -PreviousMsi $second.FullName -PreviousSha256 (Get-FileHash $second.FullName).Hash
} catch {
    $caught=$_.Exception
    $rollbackObserved = $caught.Message -match 'known-good package restored'
    $safeMessages=@(
        'DI_MSI_UNCERTAIN: unresolved MSI intent; use Reconcile, never kill or replay',
        'DI_MSI_UNCERTAIN: waiter exited without terminal evidence; mutation refused',
        'DI_MSI_UNCERTAIN: MSI deadline exceeded; waiter may still be running; use Reconcile'
    )
    $safeMessage=if($caught.Message -in $safeMessages -or $caught.Message -match '^DI_MSI_FAILED: terminal Windows Installer exit \d+$' -or $caught.Message -match '^DI_MSI_DEFERRED: suspended/busy/reboot-required outcome \d+; no automatic rollback$'){$caught.Message}else{$null}
    $observation=$null
    try {$observation=& (Join-Path $PackageRoot '2.9.238\operator\Manage-Trial.ps1') -Action Reconcile} catch { }
    @{verifiedRollbackReported=$rollbackObserved;exceptionType=$caught.GetType().FullName;safeCaughtMessage=$safeMessage;otherMessageRedacted=(!$safeMessage -and !$rollbackObserved);msi=$observation;originalWaiterPathExists=(Test-Path -LiteralPath (Join-Path (Split-Path $rollbackManagement) 'Run-Msi.ps1'));snapshotExists=(Test-Path -LiteralPath (Join-Path $data 'config\operator-tools\operator.json'));productionAccess=$false} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $PackageRoot 'rollback-observation.json')
}
Assert $rollbackObserved 'Unhealthy update did not report verified rollback'
Assert ((Health).msiVersion -eq '2.9.238') 'Rollback did not restore known-good service'
Assert ((Get-FileHash $keyPath).Hash -eq $keyHash) 'Rollback changed protected key'
# Real runtime corruption is refused by the installed integrity gate.
Phase 'runtime-corruption-refusal'
Manage 'Stop'
$runtime = Runtime
$nodeScript = Join-Path $runtime 'app\dist\src\http.js'
$bytes = [IO.File]::ReadAllBytes($nodeScript)
[IO.File]::AppendAllText($nodeScript, "`n// corrupt laboratory fixture")
$corruptionRejected = $false
try { Manage 'Start' | Out-Null } catch { $corruptionRejected = $_.Exception.Message -match 'integrity failure' }
Assert $corruptionRejected 'Corrupt runtime was not rejected before activation'
Stop-Service $name -ErrorAction SilentlyContinue
[IO.File]::WriteAllBytes($nodeScript, $bytes)
Manage 'Start' | Out-Null
Phase 'fixture-backup-restore'
$backup = Join-Path $PackageRoot 'fixture-backup'
& (Join-Path (Runtime) 'Manage-Trial.ps1') -Action Backup -BackupDirectory $backup
Assert (!(Test-Path (Join-Path $backup 'config'))) 'Backup must exclude credentials'
Assert (!(Get-ChildItem -LiteralPath $backup -Recurse -Filter '*.pem')) 'Backup included protected key'
$backupFixture = Join-Path $backup 'test-data\retained-authority-fixture.json'
$backupBytes = [IO.File]::ReadAllBytes($backupFixture)
[IO.File]::WriteAllText($backupFixture, 'corrupt backup fixture')
$corruptBackupRejected = $false
try { & (Join-Path (Runtime) 'Manage-Trial.ps1') -Action Restore -BackupDirectory $backup } catch { $corruptBackupRejected = $_.Exception.Message -match 'Backup integrity' }
Assert $corruptBackupRejected 'Restore did not reject a corrupt backup'
[IO.File]::WriteAllBytes($backupFixture, $backupBytes)
& (Join-Path (Runtime) 'Manage-Trial.ps1') -Action Restore -BackupDirectory $backup
Phase 'uninstall-retention'
Phase 'inflight-msi-repair-reconciliation'
& (Join-Path $PSScriptRoot 'Test-MsiReconciliation.ps1') -OperatorRoot (Join-Path $PackageRoot '2.9.238\operator') -MsiPath $second.FullName -Verb '/i' -PackageRoot $PackageRoot
& (Join-Path (Runtime) 'Manage-Trial.ps1') -Action Uninstall -Msi $second.FullName -ExpectedSha256 (Get-FileHash $second.FullName).Hash
Assert (!(Get-Service $name -ErrorAction SilentlyContinue)) 'Uninstall left service registration'
Assert ((Get-FileHash (Join-Path $data 'config\service.json')).Hash -eq $configHash) 'Uninstall removed protected configuration'
Assert ((Get-FileHash $keyPath).Hash -eq $keyHash) 'Uninstall removed protected key'
Assert (Test-Path (Join-Path $data 'test-data\retained-authority-fixture.json')) 'Uninstall removed protected fixture'
Phase 'reinstall-start-stop'
Msi '/i' $first.FullName
Manage 'Start' | Out-Null
Manage 'Stop'
$runtime = Runtime
Phase 'inflight-uninstall-reconciliation'
& (Join-Path $PSScriptRoot 'Test-MsiReconciliation.ps1') -OperatorRoot (Join-Path $PackageRoot '2.9.237\operator') -MsiPath $first.FullName -Verb '/x' -PackageRoot $PackageRoot -CorruptManifest
Msi '/i' $first.FullName
Manage 'Start' | Out-Null
Manage 'Stop'
$runtime = Runtime
[IO.File]::WriteAllText((Join-Path $data 'scratch\abandoned.tmp'), 'disposable')
$readonlyDirectory = Join-Path $data 'scratch\abandoned-checkout\.git\objects'
New-Item -ItemType Directory -Path $readonlyDirectory -Force | Out-Null
$readonlyFile = Join-Path $readonlyDirectory 'readonly-object'
[IO.File]::WriteAllText($readonlyFile, 'disposable Git object')
[IO.File]::SetAttributes($readonlyFile, [IO.FileAttributes]::ReadOnly)
[IO.File]::WriteAllText((Join-Path $runtime 'node\node.exe'), 'corrupt laboratory runtime')
Phase 'corrupt-runtime-uninstall'
Msi '/x' $first.FullName
Assert (!(Test-Path (Join-Path $data 'scratch\abandoned.tmp'))) 'Cached MSI helper did not clean scratch with corrupt installed Node'
Assert (!(Test-Path -LiteralPath $readonlyFile)) 'Cached MSI helper did not clean readonly Git scratch'
Assert ((Get-FileHash (Join-Path $data 'config\service.json')).Hash -eq $configHash) 'Corrupt-runtime uninstall changed protected configuration'
Assert ((Get-FileHash $keyPath).Hash -eq $keyHash) 'Corrupt-runtime uninstall changed protected key'
Phase 'final-secret-exclusion'
foreach ($log in Get-ChildItem (Join-Path $data 'logs') -File) { Assert ([IO.File]::ReadAllText($log.FullName) -notmatch [regex]::Escape(($fakePrivatePem -split "`n")[1])) 'Service logs disclosed private material' }
foreach ($metadata in Get-ChildItem $PackageRoot -Recurse -File | Where-Object { $_.Name -in 'manifest.json','Package.wxs' -or $_.Name -like '*.msi.json' -or ($_.DirectoryName -eq $PackageRoot -and $_.Extension -eq '.json') }) { Assert ([IO.File]::ReadAllText($metadata.FullName) -notmatch [regex]::Escape(($fakePrivatePem -split "`n")[1])) 'Uploaded metadata disclosed private material' }
@{ lifecycle='passed'; fixtureRevision=$revision; productionAccess=$false; unsigned=$true; rebootProof='not-run'; powerProof='not-run' } | ConvertTo-Json | Set-Content (Join-Path $PackageRoot 'lifecycle-result.json')
Phase 'passed'
