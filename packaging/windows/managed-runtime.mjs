import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfiguration,validateDescriptor,observeHost } from './compatibility.mjs';
import { verifyPayload,regularAncestors,scratchInventory } from './payload.mjs';
import { runPreflight } from './managed-preflight.mjs';
export { validateConfiguration } from './compatibility.mjs';
export { verifyPayload,scratchInventory } from './payload.mjs';

export const SERVICE_NAME='DevelopmentIntelligenceTrial';
async function main() {
  const root=path.dirname(fileURLToPath(import.meta.url));
  const dataRoot=path.join(process.env.ProgramData||'C:\\ProgramData',SERVICE_NAME);
  const manifest=await verifyPayload(root);
  const configPath=path.join(dataRoot,'config','service.json');
  await regularAncestors(configPath);
  const config=validateConfiguration(JSON.parse(await fs.readFile(configPath,'utf8')));
  validateDescriptor(manifest.descriptor);
  const limits=manifest.descriptor.limits;
  const scratch=path.join(dataRoot,'scratch');
  const osEnvironment=Object.fromEntries(['SystemRoot','WINDIR','COMSPEC','ProgramData','SystemDrive'].flatMap(key=>process.env[key]?[[key,process.env[key]]]:[]));
  for(const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env,osEnvironment,{
    PATH:`${path.join(root,'git','cmd')};${path.join(root,'git','usr','bin')};${osEnvironment.SystemRoot}\\System32`,
    TEMP:scratch,TMP:scratch,HOME:scratch,USERPROFILE:scratch,
    NODE_ENV:'production',DEVINT_BUILD_SHA:manifest.engineSha,DEVINT_COMPUTE_ONLY:'1',
    DEVINT_AUTH_MODE:'bearer',DEVINT_BEARER_TOKEN:config.agentToken,
    DEVINT_HOST:'127.0.0.1',DEVINT_PORT:'8788',DEVINT_ALLOWED_HOSTS:'127.0.0.1,localhost',
    DEVINT_PROJECTS_JSON:JSON.stringify(config.projects),DEVINT_SCRATCH_DIR:scratch,
    DEVINT_GRAPH_BUILD_CONCURRENCY:String(limits.buildConcurrency),DEVINT_GRAPH_CACHE_SIZE:String(limits.graphCacheEntries),
    DEVINT_GRAPH_SNAPSHOT_CACHE_SIZE:String(limits.snapshotCacheEntries),DEVINT_GRAPH_CACHE_MAX_RECORDS:String(limits.graphCacheRecords),
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(scratch,'empty-gitconfig'),GIT_TERMINAL_PROMPT:'0',
    ...(config.remoteStorage?{DEVINT_CANONICAL_BLOB_STORE_ID:config.remoteStorage.storeId,DEVINT_CANONICAL_BLOB_TOKEN:config.remoteStorage.token}:{}),
  });
  // Engine metadata imports initialize normal runtime modules. Keep them behind
  // the same explicit environment boundary as the server itself.
  const preflight=await runPreflight(root,manifest.descriptor,config,{installed:true});
  if(!preflight.canActivate) throw new Error('Managed compatibility preflight refused activation');
  await scratchInventory(scratch);
  for(const name of await fs.readdir(scratch)) await fs.rm(path.join(scratch,name),{recursive:true,force:true});
  const {createDevelopmentIntelligenceServer}=await import('./app/dist/src/http.js');
  const server=createDevelopmentIntelligenceServer();
  const handlers=server.listeners('request');
  server.removeAllListeners('request');
  server.on('request',async(req,res)=>{
    if(req.url==='/managed-health') {
      const {project:_project,revision:_revision,projects:_projects,...remoteSummary}=preflight.remote;
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({ready:true,engineSha:manifest.engineSha,packagingSha:manifest.packagingSha,msiVersion:manifest.msiVersion,pid:process.pid,node:process.version,scheduler:'disabled',role:'compute-only',authority:'remote-read-only',descriptor:manifest.descriptor,capabilities:{...preflight,remote:remoteSummary,host:await observeHost(root)}}));
    } else for(const handler of handlers) handler.call(server,req,res);
  });
  let closing=false;
  const shutdown=()=>{
    if(closing) return; closing=true; clearInterval(quotaTimer);
    server.close(()=>process.exit(0));
    setTimeout(()=>process.exit(1),limits.shutdownMs).unref();
  };
  const quotaTimer=setInterval(async()=>{
    try {
      const files=await scratchInventory(scratch,true);
      if(files.reduce((sum,item)=>sum+item.bytes,0)>limits.scratchBytes) throw new Error('Scratch budget exceeded');
    } catch {console.error('Managed scratch budget/integrity failure; stopping');shutdown();}
  },limits.scratchPollMs);
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
  server.listen(8788,'127.0.0.1');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(()=>{console.error('Managed activation failed: check protected configuration, compatibility, package integrity and owned directory permissions');process.exitCode=1;});
}
