import assert from 'node:assert/strict';
import test from 'node:test';
import {createDescriptor,assessCompatibility,probeRemoteMetadata,MANAGED_LIMITS} from '../packaging/windows/compatibility.mjs';
const engine={graphSchemaVersions:[2],analyzerVersion:'fixture-analyzer',queryArtifactVersions:[4],queryPointerPath:'current-query-generation.json',sourceAnalysis:[{technology:'fixture',precision:'declared'}]};
const descriptor=createDescriptor(engine,{engineSha:'a'.repeat(40),packagingSha:'a'.repeat(40)},{});
const config={formatVersion:1,authMode:'bearer',agentToken:'x'.repeat(32),projects:{fixture:{repository:'https://example.invalid/source.git'}}};
const host={platform:'win32',architecture:'x64',evidence:'unit-fixture'};
const available={state:'available',graphSchemaVersion:2,artifactFormatVersion:4,analyzerVersion:engine.analyzerVersion};

test('known package/config/host incompatibility blocks before activation',()=>{
  assert.equal(assessCompatibility(descriptor,config,host).canActivate,true);
  assert.equal(assessCompatibility({...descriptor,configFormats:[2]},config,host).canActivate,false);
  assert.equal(assessCompatibility({...descriptor,formatVersion:99},config,host).canActivate,false);
  assert.equal(assessCompatibility(descriptor,{...config,formatVersion:99},host).canActivate,false);
  assert.equal(assessCompatibility(descriptor,config,{...host,architecture:'arm64'}).canActivate,false);
  assert.equal(assessCompatibility({...descriptor,authorityWrites:true},config,host).canActivate,false);
});
test('remote availability and analyzer drift do not invent replay or authority incompatibility',()=>{
  for(const remote of [{state:'unavailable'},{...available,analyzerVersion:'another'},{...available,graphSchemaVersion:99}]) {
    const replay=assessCompatibility(descriptor,config,host,remote);
    assert.equal(replay.canActivate,true);
    assert.equal(replay.replay.sourceReachability,'not-probed');
    assert.equal(replay.remote.currentness,'not-verified');
    assert.equal(replay.authorityWrites,false);
    const requiredRead=assessCompatibility(descriptor,{...config,requiredCapabilities:['canonical-read']},host,remote);
    assert.equal(requiredRead.canActivate,false);
  }
  const compatible=assessCompatibility(descriptor,{...config,requiredCapabilities:['canonical-read']},host,available);
  assert.equal(compatible.canActivate,true);
  assert.equal(compatible.remote.readCompatibility,'metadata-compatible');
  assert.equal(compatible.remote.acceptedAuthorityCompatibility,'not-verified');
  assert.deepEqual(compatible.declared.limits,MANAGED_LIMITS);
});
test('metadata probe is bounded GET-only, discloses unavailable/mismatched metadata and never returns credentials',async()=>{
  const cfg={...config,remoteStorage:{storeId:'fixture',token:'fixture-secret-not-for-output'}};
  const calls=[];
  const fetcher=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({...available,project:'fixture',repository:config.projects.fixture.repository,revision:'b'.repeat(40)}));};
  const observed=await probeRemoteMetadata(cfg,descriptor,()=> 'fixture/current.json',fetcher);
  assert.equal(observed.state,'available');
  assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(JSON.stringify(observed).includes(cfg.remoteStorage.token),false);
  assert.equal((await probeRemoteMetadata(cfg,descriptor,()=> 'fixture/current.json',async()=>new Response('denied',{status:403}))).state,'unavailable');
  assert.equal((await probeRemoteMetadata(cfg,descriptor,()=> 'fixture/current.json',async()=>new Response('x'.repeat(129*1024)))).state,'unavailable');
  assert.equal((await probeRemoteMetadata(cfg,descriptor,()=> 'fixture/current.json',async()=>new Response('{}'))).state,'unavailable');
});

test('required canonical read cannot pass on only the first compatible project',async()=>{
  const cfg={...config,requiredCapabilities:['canonical-read'],projects:{a:{repository:'a'},b:{repository:'b'}},remoteStorage:{storeId:'fixture',token:'not-output'}};
  const fetcher=async url=>{const project=url.includes('/a/')?'a':'b';return new Response(JSON.stringify({...available,project,repository:project,revision:'b'.repeat(40),analyzerVersion:project==='a'?engine.analyzerVersion:'drift'}));};
  const remote=await probeRemoteMetadata(cfg,descriptor,project=>`${project}/current.json`,fetcher);
  assert.equal(remote.checkedCount,2);
  assert.equal(assessCompatibility(descriptor,cfg,host,remote).canActivate,false);
  const many={...cfg,projects:Object.fromEntries(Array.from({length:9},(_,i)=>[String(i),{repository:String(i)}]))};
  const bounded=await probeRemoteMetadata(many,descriptor,p=>`${p}/current.json`,async()=>new Response('{}'));
  assert.equal(bounded.checkedCount,8);
  assert.equal(bounded.reason,'project-probe-limit');
  assert.equal(assessCompatibility(descriptor,many,host,bounded).canActivate,false);
});
