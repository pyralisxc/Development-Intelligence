import fs from 'node:fs/promises';
import path from 'node:path';
import {createPrivateKey,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {regularAncestors} from './payload.mjs';
import {validateConfiguration} from './compatibility.mjs';

export const MANAGED_APP_BINDING='managed-github-app';
export const NATIVE_ACL_QUERY_TIMEOUT_MS=15_000;
// Same Windows service-SID derivation used by the MSI builder, not a trust hash.
const sidBytes=createHash('sha1').update(Buffer.from('DEVELOPMENTINTELLIGENCETRIAL','utf16le')).digest();
export const MANAGED_SERVICE_SID='S-1-5-80-'+Array.from({length:5},(_,index)=>sidBytes.readUInt32LE(index*4)).join('-');
const trustedOwners=new Set(['S-1-5-18','S-1-5-32-544']);
const readExecute=0x1200a9;
export class ManagedCredentialValidationError extends Error {
  constructor(stage) { super('Managed GitHub App protected material is unavailable or invalid'); this.code=`managed-credential-${stage}`; }
}

function fileSpecificRights(value) {
  if(!Number.isSafeInteger(value)||value < -0x80000000||value > 0xffffffff) throw new Error('Invalid native access mask');
  const raw=value>>>0;
  // Windows may retain signed GENERIC_* masks from installer SDDL. Map only
  // their documented file semantics before enforcing the same read-only policy.
  let rights=raw&0x0fffffff;
  if(raw&0x80000000) rights|=0x120089; // FILE_GENERIC_READ
  if(raw&0x40000000) rights|=0x120116; // FILE_GENERIC_WRITE
  if(raw&0x20000000) rights|=0x1200a0; // FILE_GENERIC_EXECUTE
  if(raw&0x10000000) rights|=0x1f01ff; // FILE_ALL_ACCESS
  return rights;
}

export function validateSecretAcl(acl,{directory=false}={}) {
  if(!acl || !trustedOwners.has(acl.owner) || (directory&&!acl.protected) || !Array.isArray(acl.rules) || !acl.rules.length) throw new Error('Protected credential ACL required');
  let serviceRead=false;
  for(const rule of acl.rules) {
    if(rule.type!=='Allow'||!Number.isSafeInteger(rule.rights)||(!trustedOwners.has(rule.sid)&&rule.sid!==MANAGED_SERVICE_SID)) throw new Error('Protected credential ACL required');
    if(rule.sid===MANAGED_SERVICE_SID) {
      const rights=fileSpecificRights(rule.rights);
      if(rights & ~readExecute) throw new Error('Service credential access must be read-only');
      if((rights&1)&&!rule.inheritOnly) serviceRead=true;
    }
  }
  if(!serviceRead) throw new Error('Exact service SID credential read access required');
}

export async function queryWindowsAclMetadata(targets) {
  if(!Array.isArray(targets)||targets.length<1||targets.length>4||targets.some(target=>typeof target!=='string'||!path.isAbsolute(target))) throw new ManagedCredentialValidationError('acl-query-input');
  const literals=targets.map(target=>"'"+target.replaceAll("'","''")+"'").join(',');
  // Read native ACL metadata only. Never include key bytes in arguments/output.
  const command=`$ErrorActionPreference='Stop'; $sid=[Security.Principal.SecurityIdentifier]; $rows=@(foreach($target in @(${literals})) {$acl=Get-Acl -LiteralPath $target; $rules=@($acl.GetAccessRules($true,$true,$sid)|ForEach-Object {@{sid=$_.IdentityReference.Value;rights=[long]$_.FileSystemRights;type=[string]$_.AccessControlType;inheritOnly=[bool]($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)}}); @{owner=$acl.GetOwner($sid).Value;protected=$acl.AreAccessRulesProtected;rules=$rules}}); ConvertTo-Json -InputObject $rows -Depth 5 -Compress`;
  const systemRoot=process.env.SystemRoot||'C:\\Windows';
  const env=Object.fromEntries(['SystemRoot','WINDIR','COMSPEC','SystemDrive','ProgramData'].flatMap(key=>process.env[key]?[[key,process.env[key]]]:[]));
  let stdout;
  try { ({stdout}=await promisify(execFile)(path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{env,windowsHide:true,timeout:NATIVE_ACL_QUERY_TIMEOUT_MS,maxBuffer:32*1024,encoding:'utf8'})); }
  catch(error) { throw new ManagedCredentialValidationError(error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'acl-query-output-bound':error.killed?'acl-query-timeout':typeof error.code==='number'?'acl-query-process':'acl-query-launch'); }
  try {
    const rows=JSON.parse(stdout.replace(/^\uFEFF/,''));
    if(!Array.isArray(rows)||rows.length!==targets.length||rows.some(row=>typeof row?.owner!=='string'||typeof row.protected!=='boolean'||!Array.isArray(row.rules))) throw new Error('shape');
    return rows;
  } catch { throw new ManagedCredentialValidationError('acl-query-output-shape'); }
}

/** Returns a native key object, never an environment-backed PEM. */
export async function loadManagedGithubApp(config,configDirectory,{inspectAcl}={}) {
  validateConfiguration(config);
  let bytes;
  let stage='file-boundary';
  try {
    if(!configDirectory||!path.isAbsolute(configDirectory)||path.basename(configDirectory).toLowerCase()!=='config') throw new Error('path');
    const keyPath=path.join(configDirectory,'github-app.pem');
    const configPath=path.join(configDirectory,'service.json');
    await regularAncestors(configPath);
    if(config.githubApp) await regularAncestors(keyPath);
    for(const directory of [path.dirname(configDirectory),configDirectory]) {
      if(!(await fs.lstat(directory)).isDirectory()) throw new Error('directory');
    }
    for(const [target,bound] of [[configPath,1024*1024],...(config.githubApp?[[keyPath,32*1024]]:[])]) {
      const stat=await fs.lstat(target);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>bound||stat.nlink!==1) throw new Error('file');
    }
    const targets=[path.dirname(configDirectory),configDirectory,configPath,...(config.githubApp?[keyPath]:[])];
    stage='acl-query';
    const acls=inspectAcl?await Promise.all(targets.map(inspectAcl)):await queryWindowsAclMetadata(targets);
    if(!Array.isArray(acls)||acls.length!==targets.length) throw new Error('acl');
    acls.forEach((acl,index)=>{stage=['data-root-acl','config-directory-acl','config-file-acl','key-file-acl'][index];validateSecretAcl(acl,{directory:index<2});});
    if(!config.githubApp) return {summary:{configuration:'not-configured',protectedConfiguration:'locally-validated',providerAuthentication:'not-probed',sourceReachability:'not-probed'}};
    stage='key-read';bytes=await fs.readFile(keyPath);
    stage='key-format';
    if(bytes.length>32*1024||!/^-----BEGIN (RSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END \1PRIVATE KEY-----\s*$/.test(bytes.toString('utf8'))) throw new Error('pem');
    const privateKey=createPrivateKey(bytes);
    if(privateKey.asymmetricKeyType!=='rsa'||(privateKey.asymmetricKeyDetails?.modulusLength??0)<2048) throw new Error('key');
    return {appId:config.githubApp.appId,privateKey,repositories:Object.values(config.projects).filter(project=>project.credential?.type==='github-app-bound').map(project=>project.repository),summary:{configuration:'locally-validated',credentialHandling:'process-memory-key-object',providerAuthentication:'not-probed',sourceReachability:'not-probed'}};
  } catch(error) { if(error instanceof ManagedCredentialValidationError) throw error; throw new ManagedCredentialValidationError(stage); }
  finally { bytes?.fill(0); }
}
