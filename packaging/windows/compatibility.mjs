import os from 'node:os';
import fs from 'node:fs/promises';

export const MANAGED_LIMITS = Object.freeze({ nodeHeapMB:768, buildConcurrency:1, graphCacheEntries:2, snapshotCacheEntries:1, graphCacheRecords:50000, scratchBytes:2*1024**3, scratchPollMs:5000, shutdownMs:15000, logKiB:1024, logFiles:4 });

export function validateConfiguration(config) {
  if (![1,2].includes(config?.formatVersion) || config.authMode !== 'bearer' || typeof config.agentToken !== 'string' || config.agentToken.trim().length < 32 || config.agentToken !== config.agentToken.trim()) throw new Error('Explicit supported bearer configuration with a token of at least 32 characters is required');
  if (!config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) throw new Error('An explicit project access registry is required');
  if (Object.keys(config).some(key => !['formatVersion','authMode','agentToken','projects','remoteStorage','requiredCapabilities','githubApp'].includes(key))) throw new Error('Unknown managed configuration field');
  const references=Object.values(config.projects).filter(project=>project?.credential?.type==='github-app-bound');
  if (config.githubApp !== undefined) {
    if (config.formatVersion!==2 || !config.githubApp || Object.keys(config.githubApp).some(key=>!['appId','privateKeyFile'].includes(key)) || !/^[1-9][0-9]*$/.test(config.githubApp.appId) || !Number.isSafeInteger(Number(config.githubApp.appId)) || typeof config.githubApp.appId!=='string' || config.githubApp.privateKeyFile!=='github-app.pem' || !references.length) throw new Error('Invalid explicit managed GitHub App configuration');
  }
  for(const project of Object.values(config.projects)) {
    const credential=project?.credential;
    if (credential && credential.type!=='none') {
      if (config.formatVersion!==2 || !config.githubApp || credential.type!=='github-app-bound' || credential.binding!=='managed-github-app' || Object.keys(credential).some(key=>!['type','binding'].includes(key))) throw new Error('Unsupported managed repository credential reference');
      let url;
      try { url=new URL(project.repository); } catch { throw new Error('Invalid managed GitHub repository'); }
      if(url.protocol!=='https:'||url.hostname.toLowerCase()!=='github.com'||url.port||url.username||url.password||url.search||url.hash||!/^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/?$/.test(url.pathname)) throw new Error('Managed GitHub App references require explicit GitHub HTTPS repositories');
    }
  }
  if (config.remoteStorage && (typeof config.remoteStorage.storeId !== 'string' || !/^(?:store_)?[a-zA-Z0-9-]+$/.test(config.remoteStorage.storeId) || typeof config.remoteStorage.token !== 'string' || !config.remoteStorage.token)) throw new Error('Remote storage requires explicit storeId and token');
  if (config.requiredCapabilities !== undefined && (!Array.isArray(config.requiredCapabilities) || !config.requiredCapabilities.length || config.requiredCapabilities.some(item => !['immutable-replay','canonical-read'].includes(item)))) throw new Error('Unknown required managed capability');
  return config;
}

export function createDescriptor(engine, identity, dependencies) {
  return {
    formatVersion:1, packageFormatVersion:1, configFormats:[1,2], ...identity,
    target:{platform:'win32',architecture:'x64',frameworkMinimumRelease:528040},
    role:'compute-only', authorityWrites:false, engine, dependencies, limits:MANAGED_LIMITS,
    workloads:{immutableReplay:'supported',canonicalRead:'requires-compatible-remote-generation',incrementalPublication:'unsupported',acceptedAuthorityWrite:'forbidden'},
    sensorEvidence:'declared-software-support; runtime parser proof is separate',
  };
}

export function validateDescriptor(value) {
  if (value?.formatVersion !== 1 || value.packageFormatVersion !== 1 || !/^[a-f0-9]{40}$/.test(value.engineSha) || value.engineSha !== value.packagingSha || !Array.isArray(value.configFormats) || !value.configFormats.length || value.configFormats.some(item => !Number.isInteger(item) || item < 1) || value.role !== 'compute-only' || value.authorityWrites !== false || value.target?.platform !== 'win32' || value.target?.architecture !== 'x64') throw new Error('Unsupported package compatibility descriptor');
  const engine = value.engine;
  if (!engine || !Array.isArray(engine.graphSchemaVersions) || !engine.graphSchemaVersions.length || engine.graphSchemaVersions.some(item => !Number.isInteger(item) || item < 1) || typeof engine.analyzerVersion !== 'string' || !engine.analyzerVersion || !Array.isArray(engine.queryArtifactVersions) || !engine.queryArtifactVersions.length || typeof engine.queryPointerPath !== 'string' || !engine.queryPointerPath || !Array.isArray(engine.sourceAnalysis)) throw new Error('Invalid engine compatibility descriptor');
  if (!value.limits || Object.keys(value.limits).length!==Object.keys(MANAGED_LIMITS).length || Object.entries(MANAGED_LIMITS).some(([key,limit])=>value.limits[key]!==limit)) throw new Error('Unsupported managed resource limits');
  return value;
}

export async function observeHost(storagePath) {
  let storage = {state:'unavailable',availableBytes:null};
  try { const stat = await fs.statfs(storagePath); storage = {state:'observed',availableBytes:stat.bavail*stat.bsize}; } catch { }
  return {evidence:'node-os-observation',observedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,executingNode:process.version,logicalProcessors:os.availableParallelism(),totalMemoryBytes:os.totalmem(),availableMemoryBytes:os.freemem(),storage};
}

export function assessCompatibility(descriptor, config, host, remote={state:'not-checked'}) {
  const blocked = [];
  try { validateDescriptor(descriptor); } catch { blocked.push('unsupported-package-descriptor'); }
  try { validateConfiguration(config); } catch { blocked.push('unsupported-or-invalid-configuration'); }
  if (blocked.length) return {formatVersion:1,canActivate:false,blocked,remote:{state:remote.state},authorityWrites:false};
  if (!descriptor.configFormats.includes(config.formatVersion)) blocked.push('unsupported-config-format');
  if (host.platform !== descriptor.target.platform || host.architecture !== descriptor.target.architecture) blocked.push('unsupported-host-platform');
  let remoteRead = 'unavailable';
  if (remote.state === 'available') {
    const observations = remote.projects ?? [remote];
    remoteRead = observations.map(item => !descriptor.engine.graphSchemaVersions.includes(item.graphSchemaVersion) ? 'unsupported-graph-schema'
      : !descriptor.engine.queryArtifactVersions.includes(item.artifactFormatVersion) ? 'unsupported-query-artifact-format'
      : item.analyzerVersion !== descriptor.engine.analyzerVersion ? 'analyzer-drift' : 'metadata-compatible').find(item=>item!=='metadata-compatible') ?? 'metadata-compatible';
  }
  const required = config.requiredCapabilities ?? ['immutable-replay'];
  if (required.includes('canonical-read') && remoteRead !== 'metadata-compatible') blocked.push(`required-canonical-read:${remoteRead}`);
  return {
    formatVersion:1,canActivate:blocked.length===0,blocked,
    identity:{engineSha:descriptor.engineSha,packagingSha:descriptor.packagingSha},
    replay:{softwareCompatibility:'supported',sourceReachability:'not-probed'},
    remote:{...remote,readCompatibility:remoteRead,currentness:'not-verified',acceptedAuthorityCompatibility:'not-verified',runtimeIntegrityValidation:'still-required'},
    authorityWrites:false,host,declared:{engine:descriptor.engine,workloads:descriptor.workloads,limits:descriptor.limits,sensorEvidence:descriptor.sensorEvidence},
  };
}

export async function probeRemoteMetadata(config, descriptor, blobPath, fetcher=fetch) {
  if (!config.remoteStorage) return {state:'not-configured'};
  const projects = Object.keys(config.projects).sort();
  if (!projects.length) return {state:'unavailable',reason:'no-project-selected'};
  const limit=8;
  const storeId = config.remoteStorage.storeId.replace(/^store_/, '');
  async function probe(project) {
  try {
    const url = `https://${storeId}.private.blob.vercel-storage.com/${blobPath(project,descriptor.engine.queryPointerPath).split('/').map(encodeURIComponent).join('/')}?cache=0`;
    const response = await fetcher(url, {method:'GET',headers:{authorization:`Bearer ${config.remoteStorage.token}`,'x-vercel-blob-store-id':storeId},redirect:'error',signal:AbortSignal.timeout(2500)});
    if (!response.ok) return {state:'unavailable',reason:'remote-http',httpStatus:response.status};
    const reader = response.body?.getReader();
    if (!reader) return {state:'unavailable',reason:'empty-metadata'};
    const chunks=[]; let length=0;
    try { for (;;) { const {done,value}=await reader.read(); if(done) break; length+=value.byteLength; if(length>128*1024) throw new Error('bounded'); chunks.push(value); } }
    finally { await reader.cancel().catch(()=>{}); }
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value.project!==project || value.repository!==config.projects[project].repository || !/^[a-f0-9]{40}$/i.test(value.revision) || !Number.isInteger(value.graphSchemaVersion) || !Number.isInteger(value.artifactFormatVersion) || typeof value.analyzerVersion!=='string') return {state:'unavailable',reason:'invalid-metadata'};
    return {state:'available',evidence:'remote-query-pointer-metadata',project,revision:value.revision,graphSchemaVersion:value.graphSchemaVersion,artifactFormatVersion:value.artifactFormatVersion,analyzerVersion:value.analyzerVersion};
  } catch { return {state:'unavailable',reason:'remote-unreachable-or-invalid'}; }
  }
  const observations=[];
  for(let offset=0;offset<Math.min(projects.length,limit);offset+=4) observations.push(...await Promise.all(projects.slice(offset,Math.min(offset+4,limit)).map(probe)));
  return {state:projects.length<=limit&&observations.every(item=>item.state==='available')?'available':'unavailable',scope:'all-configured-projects-with-bounded-limit',configuredCount:projects.length,checkedCount:observations.length,limit,reason:projects.length>limit?'project-probe-limit':observations.some(item=>item.state!=='available')?'project-metadata-unavailable':undefined,projects:observations};
}
