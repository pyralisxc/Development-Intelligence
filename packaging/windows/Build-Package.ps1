param(
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$MsiVersion,
    [string]$Output = (Join-Path $PSScriptRoot '..\..\.package-build'),
    [switch]$LaboratoryFailure
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($LaboratoryFailure -and ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted')) { throw 'Fault injection is restricted to disposable CI' }
$sha = (& git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') { throw 'Exact Git identity required' }
if (& git -C $repo status --porcelain --untracked-files=no) { throw 'Package must be built from committed source' }
$build = [IO.Path]::GetFullPath((Join-Path $Output $MsiVersion))
if (Test-Path -LiteralPath $build) { throw 'Use a fresh output/version directory' }
$payload = Join-Path $build 'payload'
New-Item -ItemType Directory -Path $payload -Force | Out-Null
$pins = Get-Content (Join-Path $PSScriptRoot 'dependencies.json') -Raw | ConvertFrom-Json
foreach ($name in 'node','git','winsw') {
    $pin = $pins.$name
    $download = Join-Path $build "$name.download"
    Invoke-WebRequest $pin.url -OutFile $download
    if ((Get-FileHash $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) { throw "$name checksum mismatch" }
    if ($name -eq 'winsw') { Copy-Item $download (Join-Path $payload 'DevelopmentIntelligenceTrial.exe') }
    else {
        $zip = Join-Path $build "$name.zip"
        Move-Item -LiteralPath $download -Destination $zip
        $expanded = Join-Path $build "$name-expanded"
        Expand-Archive -LiteralPath $zip -DestinationPath $expanded
        if ($name -eq 'node') {
            New-Item -ItemType Directory -Path (Join-Path $payload 'node') | Out-Null
            Copy-Item (Join-Path $expanded "node-v$($pin.version)-win-x64\node.exe") (Join-Path $payload 'node\node.exe')
            Copy-Item (Join-Path $expanded "node-v$($pin.version)-win-x64\LICENSE") (Join-Path $payload 'node\LICENSE')
        } else { Move-Item -LiteralPath $expanded -Destination (Join-Path $payload 'git') }
    }
}
if (!(Test-Path (Join-Path $payload 'git\usr\bin\sh.exe'))) { throw 'Git askpass requires bundled sh.exe' }
$app = Join-Path $payload 'app'
New-Item -ItemType Directory -Path $app | Out-Null
Copy-Item (Join-Path $repo 'dist') $app -Recurse
Copy-Item (Join-Path $repo 'package.json'),(Join-Path $repo 'package-lock.json') $app
& npm.cmd ci --omit=dev --no-audit --no-fund --prefix $app
if ($LASTEXITCODE -ne 0) { throw 'Production dependency packaging failed' }
Copy-Item (Join-Path $PSScriptRoot 'managed-runtime.mjs'),(Join-Path $PSScriptRoot 'Manage-Trial.ps1') $payload
$wrapper = @'
<service>
  <id>DevelopmentIntelligenceTrial</id>
  <name>Development Intelligence Trial</name>
  <description>Explicitly configured, loopback-only DI compute trial</description>
  <executable>%BASE%\node\node.exe</executable>
  <arguments>--max-old-space-size=768 "%BASE%\managed-runtime.mjs"</arguments>
  <env name="NODE_OPTIONS" value="" />
  <workingdirectory>%BASE%</workingdirectory>
  <stoptimeout>20sec</stoptimeout>
  <stopparentprocessfirst>false</stopparentprocessfirst>
  <logpath>%ProgramData%\DevelopmentIntelligenceTrial\logs</logpath>
  <log mode="roll-by-size"><sizeThreshold>1024</sizeThreshold><keepFiles>4</keepFiles></log>
</service>
'@
if ($LaboratoryFailure) { $wrapper = $wrapper.Replace('--max-old-space-size=768', '--deliberately-invalid-laboratory-flag') }
[IO.File]::WriteAllText((Join-Path $payload 'DevelopmentIntelligenceTrial.xml'), $wrapper)
$files = @(Get-ChildItem -LiteralPath $payload -Recurse -File | Sort-Object FullName | ForEach-Object {
    if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse payload refused' }
    @{ path = [IO.Path]::GetRelativePath($payload, $_.FullName).Replace('\','/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$manifest = @{ formatVersion=1; engineSha=$sha; packagingSha=$sha; msiVersion=$MsiVersion; unsignedLaboratoryArtifact=$true; platform='win32-x64'; dependencies=$pins; files=$files }
[IO.File]::WriteAllText((Join-Path $payload 'manifest.json'), ($manifest | ConvertTo-Json -Depth 8))
function Escape-Xml([string]$value) { [Security.SecurityElement]::Escape($value) }
function File-Id([string]$value) {
    $hash = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($value))
    'f' + [Convert]::ToHexString($hash).Substring(0,30)
}
$components = [Collections.Generic.List[string]]::new()
$refs = [Collections.Generic.List[string]]::new()
foreach ($file in Get-ChildItem -LiteralPath $payload -Recurse -File) {
    $relative = [IO.Path]::GetRelativePath($payload, $file.FullName)
    $id = File-Id $relative
    $directory = [IO.Path]::GetDirectoryName($relative)
    $subdirectory = if ($directory) { ' Subdirectory="' + (Escape-Xml $directory) + '"' } else { '' }
    $service = if ($relative -eq 'DevelopmentIntelligenceTrial.exe') { @'
      <ServiceInstall Id="TrialService" Name="DevelopmentIntelligenceTrial" DisplayName="Development Intelligence Trial" Type="ownProcess" Start="demand" ErrorControl="normal" Account="NT AUTHORITY\LocalService" Vital="yes">
        <ServiceConfig ServiceSid="unrestricted" OnInstall="yes" OnReinstall="yes" />
        <util:ServiceConfig FirstFailureActionType="restart" SecondFailureActionType="none" ThirdFailureActionType="none" RestartServiceDelayInSeconds="30" ResetPeriodInDays="1" />
      </ServiceInstall>
      <ServiceControl Id="TrialControl" Name="DevelopmentIntelligenceTrial" Stop="both" Remove="uninstall" Wait="yes" />
'@ } else { '' }
    $components.Add('<Component Id="'+$id+'" Directory="RuntimeFolder"'+$subdirectory+' Guid="*"><File Id="'+$id+'File" Source="'+(Escape-Xml $file.FullName)+'" KeyPath="yes" />'+$service+'</Component>')
    $refs.Add('<ComponentRef Id="'+$id+'" />')
}
# Derive the immutable NT SERVICE SID, independent of account-name localization.
$sidBytes = [Security.Cryptography.SHA1]::HashData([Text.Encoding]::Unicode.GetBytes('DEVELOPMENTINTELLIGENCETRIAL'))
$serviceSid = 'S-1-5-80-' + ((0..4 | ForEach-Object { [BitConverter]::ToUInt32($sidBytes, $_*4) }) -join '-')
$admin = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
$readAcl = $admin + "(A;OICI;GRGX;;;$serviceSid)"
$writeAcl = $admin + "(A;OICI;FA;;;$serviceSid)"
$dataComponents = ''
foreach ($folder in 'config','logs','scratch','test-data') {
    $sddl = if ($folder -in 'logs','scratch') { $writeAcl } else { $readAcl }
    $dataComponents += '<Directory Id="Data'+$folder.Replace('-','')+'" Name="'+$folder+'"><Component Id="Data'+$folder.Replace('-','')+'Component" Guid="*" Permanent="yes"><CreateFolder><PermissionEx Sddl="'+$sddl+'" /></CreateFolder></Component></Directory>'
    $refs.Add('<ComponentRef Id="Data'+$folder.Replace('-','')+'Component" />')
}
$xml = @"
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs" xmlns:util="http://wixtoolset.org/schemas/v4/wxs/util">
 <Package Name="Development Intelligence Trial (unsigned laboratory)" Manufacturer="Development Intelligence" Version="$MsiVersion" UpgradeCode="B09658F5-C884-4ACD-85D2-46AC3D82DA13" Scope="perMachine" InstallerVersion="500">
  <MajorUpgrade DowngradeErrorMessage="Use explicit preserve-state rollback to the known-good MSI." Schedule="afterInstallInitialize" />
  <Property Id="DI_ENGINE_SHA" Value="$sha" />
  <Property Id="DI_PACKAGING_SHA" Value="$sha" />
  <MediaTemplate EmbedCab="yes" CompressionLevel="high" />
  <StandardDirectory Id="ProgramFiles64Folder"><Directory Id="INSTALLFOLDER" Name="Development Intelligence Trial"><Directory Id="RuntimeFolder" Name="$MsiVersion-$($sha.Substring(0,12))" /></Directory></StandardDirectory>
  <StandardDirectory Id="CommonAppDataFolder"><Directory Id="TrialData" Name="DevelopmentIntelligenceTrial"><Component Id="TrialDataComponent" Guid="*" Permanent="yes"><CreateFolder><PermissionEx Sddl="$readAcl" /></CreateFolder></Component>$dataComponents</Directory></StandardDirectory>
  $($components -join "`n")
  <Feature Id="Complete" Title="Managed trial" Level="1"><ComponentRef Id="TrialDataComponent" />$($refs -join "`n")</Feature>
 </Package>
</Wix>
"@
$wxs = Join-Path $build 'Package.wxs'
[IO.File]::WriteAllText($wxs, $xml)
$msi = Join-Path $build "DevelopmentIntelligenceTrial-$MsiVersion-x64-UNSIGNED.msi"
& wix build $wxs -arch x64 -ext WixToolset.Util.wixext/5.0.2 -out $msi
if ($LASTEXITCODE -ne 0) { throw 'MSI build failed' }
@{ msiVersion=$MsiVersion; engineSha=$sha; packagingSha=$sha; sha256=(Get-FileHash $msi -Algorithm SHA256).Hash.ToLowerInvariant(); unsignedLaboratoryArtifact=$true } | ConvertTo-Json | Set-Content "$msi.json"
Write-Output $msi
