param([Parameter(Mandatory)][string]$PackageRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:COMPUTERNAME -eq 'OAKLEY') { throw 'Installation tests require a disposable GitHub-hosted Windows runner' }
$name = 'DevelopmentIntelligenceTrial'
$data = Join-Path $env:ProgramData $name
$first = Get-ChildItem (Join-Path $PackageRoot '2.9.237') -Filter '*.msi' | Select-Object -First 1
$second = Get-ChildItem (Join-Path $PackageRoot '2.9.238') -Filter '*.msi' | Select-Object -First 1
$unhealthy = Get-ChildItem (Join-Path $PackageRoot '2.9.239') -Filter '*.msi' | Select-Object -First 1
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
$token = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$config = @{ formatVersion=1; authMode='bearer'; agentToken=$token; projects=@{ fixture=@{ repository=([Uri]($fixture.Replace('\','/')+'/')).AbsoluteUri; defaultRef='main'; allowedRefs=@('main'); revisionPolicy='repository-history'; credential=@{type='none'} } } }
[IO.File]::WriteAllText((Join-Path $data 'config\service.json'), ($config | ConvertTo-Json -Depth 10))
[IO.File]::WriteAllText((Join-Path $data 'test-data\retained-authority-fixture.json'), '{"fixtureOnly":true,"acceptedRevision":"retained"}')
$configHash = (Get-FileHash (Join-Path $data 'config\service.json')).Hash
$health = Manage 'Start'
$nodeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($health.pid)"
$owner = Invoke-CimMethod -InputObject $nodeProcess -MethodName GetOwner
Assert ($owner.User -eq 'LOCAL SERVICE') 'Actual Node must run as LocalService'
$result = Rpc 'scan_graph' @{project='fixture';ref="commit:$revision"}
Assert (!$result.error -and !$result.result.isError) 'Bundled Git/native parser exact-revision scan failed'
$json = $result | ConvertTo-Json -Depth 60
Assert ($json -match $revision -and $json -match 'Sample') 'Actual graph must contain fixture identity and native parser output'
try { Invoke-WebRequest 'http://127.0.0.1:8788/mcp' -Method Post -ContentType 'application/json' -Body '{}' | Out-Null; throw 'Unauthorized request passed' } catch { Assert ($_.Exception.Response.StatusCode.value__ -eq 401) 'MCP must deny anonymous access' }
$measure = Get-Process -Id $health.pid
@{ pid=$health.pid; workingSetBytes=$measure.WorkingSet64; privateBytes=$measure.PrivateMemorySize64; cpuSeconds=$measure.CPU; engineSha=$health.engineSha } | ConvertTo-Json | Set-Content (Join-Path $PackageRoot 'resource-measurement.json')
Manage 'Stop'
Assert (!(Get-Process -Id $health.pid -ErrorAction SilentlyContinue)) 'Owned Node survived stop'
Manage 'Start' | Out-Null
$oldManagement = Join-Path (Runtime) 'Manage-Trial.ps1'
& $oldManagement -Action Update -Msi $second.FullName -ExpectedSha256 (Get-FileHash $second.FullName).Hash -PreviousMsi $first.FullName -PreviousSha256 (Get-FileHash $first.FullName).Hash
Assert ((Invoke-RestMethod 'http://127.0.0.1:8788/managed-health').msiVersion -eq '2.9.238') 'Upgrade identity failed'
Assert ((Get-FileHash (Join-Path $data 'config\service.json')).Hash -eq $configHash) 'Upgrade changed protected configuration'
Manage 'Restart' | Out-Null
$rollbackObserved = $false
try {
    & (Join-Path (Runtime) 'Manage-Trial.ps1') -Action Update -Msi $unhealthy.FullName -ExpectedSha256 (Get-FileHash $unhealthy.FullName).Hash -PreviousMsi $second.FullName -PreviousSha256 (Get-FileHash $second.FullName).Hash
} catch { $rollbackObserved = $_.Exception.Message -match 'known-good package restored' }
Assert $rollbackObserved 'Unhealthy update did not report verified rollback'
Assert ((Invoke-RestMethod 'http://127.0.0.1:8788/managed-health').msiVersion -eq '2.9.238') 'Rollback did not restore known-good service'
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
& (Join-Path (Runtime) 'Manage-Trial.ps1') -Action Restore -BackupDirectory $backup
& (Join-Path (Runtime) 'Manage-Trial.ps1') -Action Uninstall -Msi $second.FullName -ExpectedSha256 (Get-FileHash $second.FullName).Hash
Assert (!(Get-Service $name -ErrorAction SilentlyContinue)) 'Uninstall left service registration'
Assert ((Get-FileHash (Join-Path $data 'config\service.json')).Hash -eq $configHash) 'Uninstall removed protected configuration'
Assert (Test-Path (Join-Path $data 'test-data\retained-authority-fixture.json')) 'Uninstall removed protected fixture'
Msi '/i' $first.FullName
Manage 'Start' | Out-Null
Manage 'Stop'
Msi '/x' $first.FullName
@{ lifecycle='passed'; fixtureRevision=$revision; productionAccess=$false; unsigned=$true; rebootProof='not-run'; powerProof='not-run' } | ConvertTo-Json | Set-Content (Join-Path $PackageRoot 'lifecycle-result.json')
