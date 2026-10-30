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
function Msi([string]$verb, [string]$target) {
    $p = Start-Process msiexec.exe -ArgumentList @($verb, ('"'+$target+'"'), '/qn', '/norestart', '/l*v', ('"'+$target+'.install.log"')) -WindowStyle Hidden -Wait -PassThru
    Assert ($p.ExitCode -eq 0) "MSI operation failed: $($p.ExitCode)"
}
function Runtime {
    $svc = Get-CimInstance Win32_Service -Filter "Name='$name'"
    Assert ($svc.PathName -match '^"?(.+DevelopmentIntelligenceTrial\.exe)"?$') 'Unexpected service executable'
    Split-Path $Matches[1]
}
function Manage([string]$action) { & (Join-Path (Runtime) 'Manage-Trial.ps1') -Action $action }
function Rpc([string]$tool, $arguments) {
    $body = @{ jsonrpc='2.0'; id=1; method='tools/call'; params=@{ name=$tool; arguments=$arguments } } | ConvertTo-Json -Depth 20
    Invoke-RestMethod 'http://127.0.0.1:8788/mcp' -Method Post -ContentType 'application/json' -Headers @{Authorization="Bearer $token"} -Body $body
}
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
try { Manage 'Start'; throw 'Unconfigured start unexpectedly succeeded' } catch { Assert ($_.Exception.Message -match 'configuration') 'Wrong unconfigured failure' }
$fixture = Join-Path $data 'test-data\repository'
New-Item -ItemType Directory -Path $fixture | Out-Null
$samples = @{ 'sample.cs'='public class Sample { public int Count { get; set; } }'; 'Sample.java'='public class Sample { public int count() { return 1; } }'; 'sample.py'="def count():`n    return 1" }
$samples.GetEnumerator() | ForEach-Object { [IO.File]::WriteAllText((Join-Path $fixture $_.Key), $_.Value) }
& git init --initial-branch=main $fixture
& git -C $fixture add .
& git -C $fixture -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture
$revision = (& git -C $fixture rev-parse HEAD).Trim()
& icacls.exe $fixture /setowner 'NT AUTHORITY\LocalService' /T /Q | Out-Null
Assert ($LASTEXITCODE -eq 0) 'Fixture ownership setup failed'
$token = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$project = @{ repository=([Uri]($fixture.Replace('\','/')+'/')).AbsoluteUri; defaultRef='main'; allowedRefs=@('main'); revisionPolicy='repository-history'; credential=@{type='none'} }
$config = @{ formatVersion=2; authMode='bearer'; agentToken=$token; projects=@{ fixture=$project; orphan=$project; 'private-uncontacted'=@{repository='https://github.com/fixture/uncontacted.git';defaultRef='HEAD';credential=@{type='github-app-bound';binding='managed-github-app'}} }; githubApp=@{appId='123456';privateKeyFile='github-app.pem'}; remoteStorage=@{storeId='fixture-store';token='fixture-write-capable-looking-token'} }
# Generated only on this disposable runner. Never contact the configured fake
# private repository or write generated material to uploaded artifacts/logs.
$rsa = [Security.Cryptography.RSA]::Create(2048)
$fakePrivatePem = $rsa.ExportPkcs8PrivateKeyPem()
$rsa.Dispose()
$keyPath = Join-Path $data 'config\github-app.pem'
[IO.File]::WriteAllText($keyPath,$fakePrivatePem)
$serviceSid = ([Security.Principal.NTAccount]"NT SERVICE\$name").Translate([Security.Principal.SecurityIdentifier])
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
$health = Manage 'Start'
Assert ($health.descriptor.engineSha -eq $health.engineSha) 'Exact-source descriptor identity missing'
Assert ($health.capabilities.repositoryAuthentication.configuration -eq 'locally-validated' -and $health.capabilities.repositoryAuthentication.providerAuthentication -eq 'not-probed') 'Restricted service did not validate protected key, or falsely claimed provider access'
Assert ($health.capabilities.host.logicalProcessors -gt 0 -and $health.capabilities.host.totalMemoryBytes -gt 0) 'Observed node resource facts missing'
Assert ($health.capabilities.declared.workloads.incrementalPublication -eq 'unsupported') 'Unsupported workload must not be advertised'
$preflight = Manage 'Preflight'
Assert ($preflight.canActivate -and $preflight.replay.softwareCompatibility -eq 'supported') 'Replay preflight failed'
Assert ($preflight.remote.readCompatibility -eq 'unavailable' -and $preflight.remote.currentness -eq 'not-verified') 'Fake remote credential availability was not reported honestly'
Assert (($preflight | ConvertTo-Json -Depth 20) -notmatch [regex]::Escape($token)) 'Preflight disclosed credentials'
Assert (($preflight | ConvertTo-Json -Depth 20) -notmatch [regex]::Escape(($fakePrivatePem -split "`n")[1])) 'Preflight disclosed private material'
# Operator preflight refuses bad local material without stopping the valid
# running service. Direct service start independently repeats the same checks.
$credentialManagement = Join-Path (Runtime) 'Manage-Trial.ps1'
$protectedPid = $health.pid
function Assert-CredentialRefusal {
    $report = Manage 'Preflight'
    Assert (!$report.canActivate) 'Unsafe credential material passed preflight'
    $rejected = $false
    try { & $credentialManagement -Action Update -Msi $second.FullName -ExpectedSha256 (Get-FileHash $second.FullName).Hash -PreviousMsi $first.FullName -PreviousSha256 (Get-FileHash $first.FullName).Hash | Out-Null } catch { $rejected = $_.Exception.Message -match 'preflight refused' }
    Assert $rejected 'Invalid credential did not refuse update before disruption'
    Assert ((Invoke-RestMethod 'http://127.0.0.1:8788/managed-health').pid -eq $protectedPid) 'Credential refusal disrupted valid service'
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
Assert-CredentialRefusal
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
Assert ((Invoke-RestMethod 'http://127.0.0.1:8788/managed-health' | ConvertTo-Json -Depth 20) -notmatch [regex]::Escape(($fakePrivatePem -split "`n")[1])) 'Health disclosed private material'
Assert ((Invoke-RestMethod 'http://127.0.0.1:8788/managed-health').pid -eq $health.pid) 'Non-listening preflight disrupted the running service'
Assert ($health.role -eq 'compute-only' -and $health.authority -eq 'remote-read-only') 'Managed role must be fixed even with remote credentials configured'
foreach ($route in '/workbench/reconcile-canonical','/workbench/semantics/change-verify') {
    $denied = Invoke-WebRequest ("http://127.0.0.1:8788"+$route) -Method Post -Headers @{Authorization="Bearer $token"} -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck
    Assert ($denied.StatusCode -eq 403 -and $denied.Content -match 'COMPUTE_ONLY_AUTHORITY_DENIED') 'Managed authority mutation route was not denied'
}
$deniedScan = Rpc 'scan_graph' @{project='fixture'}
Assert ($deniedScan.result.isError -and ($deniedScan | ConvertTo-Json -Depth 10) -match 'immutable') 'Current/default W publication must be denied'
$nodeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($health.pid)"
$owner = Invoke-CimMethod -InputObject $nodeProcess -MethodName GetOwner
Assert ($owner.User -eq 'LOCAL SERVICE') 'Actual Node must run as LocalService'
$result = Rpc 'scan_graph' @{project='fixture';ref="commit:$revision"}
Assert (!$result.PSObject.Properties['error'] -and !($result.result.PSObject.Properties['isError'] -and $result.result.isError)) 'Bundled Git/native parser exact-revision scan failed'
$scan = $result.result.structuredContent
Assert ($scan.revision -eq $revision -and $scan.nodeCount -gt 3) 'Actual scan must report the exact fixture revision'
# scan_graph deliberately returns compact counts, not graph nodes. Inspect the
# declared structural query surface to prove each bundled native parser ran.
$symbols = Rpc 'search_graph' @{project='fixture';ref="commit:$revision";kinds=@('class','method','function','property');layers=@('structural');limit=100}
Assert (!$symbols.PSObject.Properties['error'] -and !($symbols.result.PSObject.Properties['isError'] -and $symbols.result.isError)) 'Native symbol query failed'
$nodes = @($symbols.result.structuredContent.nodes)
Assert (@($nodes | Where-Object kind -eq 'class').Count -eq 2) 'C#/Java class parsing failed'
Assert (@($nodes | Where-Object kind -eq 'property').Count -ge 1) 'C# property parsing failed'
Assert (@($nodes | Where-Object kind -eq 'method').Count -ge 1) 'Java method parsing failed'
Assert (@($nodes | Where-Object kind -eq 'function').Count -ge 1) 'Python function parsing failed'
try { Invoke-WebRequest 'http://127.0.0.1:8788/mcp' -Method Post -ContentType 'application/json' -Body '{}' | Out-Null; throw 'Unauthorized request passed' } catch { Assert ($_.Exception.Response.StatusCode.value__ -eq 401) 'MCP must deny anonymous access' }
$measure = Get-Process -Id $health.pid
@{ pid=$health.pid; workingSetBytes=$measure.WorkingSet64; privateBytes=$measure.PrivateMemorySize64; cpuSeconds=$measure.CPU; engineSha=$health.engineSha } | ConvertTo-Json | Set-Content (Join-Path $PackageRoot 'resource-measurement.json')
# After genuine parser/Git proof, substitute a disposable long-lived Git child
# while the service is already running. This tests supervisor tree cleanup without
# shipping a production test hook or weakening startup payload integrity.
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
    try { Invoke-RestMethod 'http://127.0.0.1:8788/mcp' -Method Post -ContentType 'application/json' -Headers @{Authorization="Bearer $credential"} -Body $body | Out-Null } catch { }
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
Manage 'Stop'
Assert (!(Get-Process -Id $health.pid -ErrorAction SilentlyContinue)) 'Owned Node survived stop'
foreach ($childId in @($probeProcess.ProcessId) + @($probeChildren.ProcessId)) { Assert (!(Get-Process -Id $childId -ErrorAction SilentlyContinue)) 'Owned active descendant survived stop' }
Stop-Job $job
Remove-Job $job -Force
[IO.File]::WriteAllBytes($gitExe, $gitBytes)
Manage 'Start' | Out-Null
$oldManagement = Join-Path (Runtime) 'Manage-Trial.ps1'
$beforePreflight = (Invoke-RestMethod 'http://127.0.0.1:8788/managed-health').pid
$incompatibleRejected = $false
try { & $oldManagement -Action Update -Msi $incompatible.FullName -ExpectedSha256 (Get-FileHash $incompatible.FullName).Hash -PreviousMsi $first.FullName -PreviousSha256 (Get-FileHash $first.FullName).Hash } catch { $incompatibleRejected = $_.Exception.Message -match 'unsupported-config-format' }
Assert $incompatibleRejected 'Known incompatible candidate was not refused before service disruption'
Assert ((Invoke-RestMethod 'http://127.0.0.1:8788/managed-health').pid -eq $beforePreflight) 'Incompatible preflight stopped the running service'
Assert ((Get-FileHash (Join-Path $data 'config\service.json')).Hash -eq $configHash) 'Incompatible preflight changed protected configuration'
# An accidental direct MSI major upgrade must also stop before StopServices.
$direct = Start-Process msiexec.exe -ArgumentList @('/i', ('"'+$incompatible.FullName+'"'), '/qn', '/norestart') -WindowStyle Hidden -Wait -PassThru
Assert ($direct.ExitCode -ne 0) 'Raw MSI upgrade bypassed required descriptor preflight'
Assert ((Invoke-RestMethod 'http://127.0.0.1:8788/managed-health').pid -eq $beforePreflight) 'Raw MSI refusal disrupted the existing service'
# Internally inconsistent descriptor metadata is refused even when the caller
# supplies the fixture MSI's correct outer hash.
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
Assert ((Invoke-RestMethod 'http://127.0.0.1:8788/managed-health').pid -eq $beforePreflight) 'Corrupt descriptor refusal disrupted existing service'
$badHashRejected = $false
try { & $oldManagement -Action Update -Msi $second.FullName -ExpectedSha256 ('0'*64) -PreviousMsi $first.FullName -PreviousSha256 (Get-FileHash $first.FullName).Hash } catch { $badHashRejected = $_.Exception.Message -match 'checksum mismatch' }
Assert $badHashRejected 'Corrupt MSI input was not refused'
$wrongPriorRejected = $false
try { & $oldManagement -Action Update -Msi $second.FullName -ExpectedSha256 (Get-FileHash $second.FullName).Hash -PreviousMsi $second.FullName -PreviousSha256 (Get-FileHash $second.FullName).Hash } catch { $wrongPriorRejected = $_.Exception.Message -match 'does not match' }
Assert $wrongPriorRejected 'Wrong known-good MSI identity was not refused'
Assert ((Invoke-RestMethod 'http://127.0.0.1:8788/managed-health').pid -eq $beforePreflight) 'Preflight refusal stopped the running service'
& $oldManagement -Action Update -Msi $second.FullName -ExpectedSha256 (Get-FileHash $second.FullName).Hash -PreviousMsi $first.FullName -PreviousSha256 (Get-FileHash $first.FullName).Hash
Assert ((Invoke-RestMethod 'http://127.0.0.1:8788/managed-health').msiVersion -eq '2.9.238') 'Upgrade identity failed'
Assert ((Get-FileHash (Join-Path $data 'config\service.json')).Hash -eq $configHash) 'Upgrade changed protected configuration'
Assert ((Get-FileHash $keyPath).Hash -eq $keyHash) 'Upgrade changed protected key'
Manage 'Restart' | Out-Null
$rollbackObserved = $false
try {
    & (Join-Path (Runtime) 'Manage-Trial.ps1') -Action Update -Msi $unhealthy.FullName -ExpectedSha256 (Get-FileHash $unhealthy.FullName).Hash -PreviousMsi $second.FullName -PreviousSha256 (Get-FileHash $second.FullName).Hash
} catch { $rollbackObserved = $_.Exception.Message -match 'known-good package restored' }
Assert $rollbackObserved 'Unhealthy update did not report verified rollback'
Assert ((Invoke-RestMethod 'http://127.0.0.1:8788/managed-health').msiVersion -eq '2.9.238') 'Rollback did not restore known-good service'
Assert ((Get-FileHash $keyPath).Hash -eq $keyHash) 'Rollback changed protected key'
# Real runtime corruption is refused by the installed integrity gate.
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
& (Join-Path (Runtime) 'Manage-Trial.ps1') -Action Uninstall -Msi $second.FullName -ExpectedSha256 (Get-FileHash $second.FullName).Hash
Assert (!(Get-Service $name -ErrorAction SilentlyContinue)) 'Uninstall left service registration'
Assert ((Get-FileHash (Join-Path $data 'config\service.json')).Hash -eq $configHash) 'Uninstall removed protected configuration'
Assert ((Get-FileHash $keyPath).Hash -eq $keyHash) 'Uninstall removed protected key'
Assert (Test-Path (Join-Path $data 'test-data\retained-authority-fixture.json')) 'Uninstall removed protected fixture'
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
Msi '/x' $first.FullName
Assert (!(Test-Path (Join-Path $data 'scratch\abandoned.tmp'))) 'Cached MSI helper did not clean scratch with corrupt installed Node'
Assert (!(Test-Path -LiteralPath $readonlyFile)) 'Cached MSI helper did not clean readonly Git scratch'
Assert ((Get-FileHash (Join-Path $data 'config\service.json')).Hash -eq $configHash) 'Corrupt-runtime uninstall changed protected configuration'
Assert ((Get-FileHash $keyPath).Hash -eq $keyHash) 'Corrupt-runtime uninstall changed protected key'
foreach ($log in Get-ChildItem (Join-Path $data 'logs') -File) { Assert ([IO.File]::ReadAllText($log.FullName) -notmatch [regex]::Escape(($fakePrivatePem -split "`n")[1])) 'Service logs disclosed private material' }
foreach ($metadata in Get-ChildItem $PackageRoot -Recurse -File | Where-Object { $_.Name -in 'manifest.json','Package.wxs' -or $_.Name -like '*.msi.json' -or ($_.DirectoryName -eq $PackageRoot -and $_.Extension -eq '.json') }) { Assert ([IO.File]::ReadAllText($metadata.FullName) -notmatch [regex]::Escape(($fakePrivatePem -split "`n")[1])) 'Uploaded metadata disclosed private material' }
@{ lifecycle='passed'; fixtureRevision=$revision; productionAccess=$false; unsigned=$true; rebootProof='not-run'; powerProof='not-run' } | ConvertTo-Json | Set-Content (Join-Path $PackageRoot 'lifecycle-result.json')
