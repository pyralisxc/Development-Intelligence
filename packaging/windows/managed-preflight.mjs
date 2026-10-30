import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { assessCompatibility,observeHost,probeRemoteMetadata,validateConfiguration,validateDescriptor } from './compatibility.mjs';
import { regularAncestors,verifyPayload } from './payload.mjs';
import { loadManagedGithubApp,ManagedCredentialValidationError } from './managed-credentials.mjs';

export async function runPreflight(root,descriptor,config,{installed=false,configDirectory}={}) {
  validateDescriptor(descriptor);
  validateConfiguration(config);
  const {summary:repositoryAuthentication}=await loadManagedGithubApp(config,configDirectory);
  if(installed) {
    const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
    if(manifest.engineSha!==descriptor.engineSha||manifest.packagingSha!==descriptor.packagingSha) throw new Error('Installed descriptor identity mismatch');
    const {engineDescriptor}=await import(pathToFileURL(path.join(root,'app/dist/src/runtimeDescriptor.js')).href);
    if(JSON.stringify(engineDescriptor())!==JSON.stringify(descriptor.engine)) throw new Error('Installed engine descriptor does not match exact-source metadata');
  }
  const {canonicalDerivedObjectBlobPath}=await import(pathToFileURL(path.join(root,'app/dist/src/intelligence/canonicalStore.js')).href);
  const remote={...await probeRemoteMetadata(config,descriptor,canonicalDerivedObjectBlobPath),observedAt:new Date().toISOString()};
  return {...assessCompatibility(descriptor,config,await observeHost(root),remote),repositoryAuthentication};
}

async function main() {
  const args=process.argv.slice(2);
  const value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
  const root=value('--root'); const descriptorPath=value('--descriptor'); const configPath=value('--config');
  try {
    if(!root||!configPath) throw new Error('Missing preflight input');
    const manifest=await verifyPayload(root);
    await regularAncestors(configPath);
    if(descriptorPath) await regularAncestors(descriptorPath);
    for(const target of [configPath,...(descriptorPath?[descriptorPath]:[])]) {
      const stat=await fs.lstat(target);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024) throw new Error('Invalid bounded preflight file');
    }
    const descriptor=descriptorPath?JSON.parse(await fs.readFile(descriptorPath,'utf8')):manifest.descriptor;
    const config=JSON.parse(await fs.readFile(configPath,'utf8'));
    const report=await runPreflight(root,descriptor,config,{installed:!descriptorPath,configDirectory:path.dirname(configPath)});
    process.stdout.write(JSON.stringify(report)+'\n'); process.exitCode=report.canActivate?0:2;
  } catch(error) {
    process.stdout.write(JSON.stringify({formatVersion:1,canActivate:false,blocked:[error instanceof ManagedCredentialValidationError?error.code:'invalid-preflight-input-or-integrity'],authorityWrites:false})+'\n'); process.exitCode=2;
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
