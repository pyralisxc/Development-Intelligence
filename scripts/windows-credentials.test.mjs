import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,sign,verify} from 'node:crypto';
import {validateConfiguration} from '../packaging/windows/compatibility.mjs';
import {loadManagedGithubApp,validateSecretAcl,MANAGED_APP_BINDING,MANAGED_SERVICE_SID,queryWindowsAclMetadata,ManagedCredentialValidationError} from '../packaging/windows/managed-credentials.mjs';

const serviceSid=MANAGED_SERVICE_SID;
const safeAcl=()=>({owner:'S-1-5-32-544',protected:true,serviceSid,rules:[{sid:'S-1-5-18',type:'Allow',rights:2032127},{sid:'S-1-5-32-544',type:'Allow',rights:2032127},{sid:serviceSid,type:'Allow',rights:0x1200a9}]});
const config={formatVersion:2,authMode:'bearer',agentToken:'x'.repeat(32),githubApp:{appId:'123456',privateKeyFile:'github-app.pem'},projects:{fixture:{repository:'https://github.com/fixture/approved.git',defaultRef:'HEAD',credential:{type:'github-app-bound',binding:MANAGED_APP_BINDING}}}};

test('managed private sources require explicit format2 and narrow bound references, not environment passthrough',()=>{
  assert.equal(validateConfiguration(config),config);
  assert.doesNotThrow(()=>validateConfiguration({...config,formatVersion:1,githubApp:undefined,projects:{fixture:{repository:'file:///fixture'}}}));
  for(const change of [{formatVersion:1},{githubApp:{...config.githubApp,privateKeyFile:'../other.pem'}},{githubApp:{...config.githubApp,privateKey:'inline'}},{githubApp:{...config.githubApp,appId:123}},{githubApp:undefined},{projects:{fixture:{...config.projects.fixture,credential:{type:'token-env',tokenEnv:'KEY'}}}},{projects:{fixture:{...config.projects.fixture,credential:{type:'github-app-env',appIdEnv:'APP',privateKeyEnv:'KEY'}}}},{projects:{fixture:{...config.projects.fixture,repository:'https://github.com.attacker.invalid/fixture/approved'}}}]) assert.throws(()=>validateConfiguration({...config,...change}));
});

test('credential ACL policy rejects unrelated identities, service writes, untrusted owner and replaceable directories',()=>{
  assert.doesNotThrow(()=>validateSecretAcl(safeAcl(),{directory:true}));
  for(const acl of [{...safeAcl(),owner:'S-1-5-21-1'},{...safeAcl(),protected:false},{...safeAcl(),rules:[...safeAcl().rules,{sid:'S-1-1-0',type:'Allow',rights:1}]},{...safeAcl(),rules:[...safeAcl().rules,{sid:'S-1-5-19',type:'Allow',rights:1}]},{...safeAcl(),rules:[...safeAcl().rules,{sid:serviceSid,type:'Allow',rights:2}]},{...safeAcl(),rules:safeAcl().rules.filter(rule=>rule.sid!==serviceSid)}]) assert.throws(()=>validateSecretAcl(acl,{directory:true}));
  const forged='S-1-5-80-1-2-3-4-5';
  assert.throws(()=>validateSecretAcl({...safeAcl(),serviceSid:forged,rules:safeAcl().rules.map(rule=>rule.sid===serviceSid?{...rule,sid:forged}:rule)}));
});

test('native signed GRGX maps to file read/execute, never to a generic negative-mask exemption',()=>{
  const acl=rights=>({...safeAcl(),rules:safeAcl().rules.map(rule=>rule.sid===serviceSid?{...rule,rights}:rule)});
  assert.doesNotThrow(()=>validateSecretAcl(acl(-1610612736),{directory:true}));
  assert.doesNotThrow(()=>validateSecretAcl(acl(0x1200a9),{directory:true}));
  for(const rights of [0x20000000,0x40000000,0x10000000,-1073741824,-1,0xa0000002,0x100000001]) assert.throws(()=>validateSecretAcl(acl(rights),{directory:true}));
});

test('native Windows ACL executable/isolated-env/JSON transport works without service installation',{skip:process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'},async()=>{
  const rows=await queryWindowsAclMetadata([path.resolve('AGENTS.md'),path.resolve('ORCHESTRATION.md')]);
  assert.equal(rows.length,2);
  assert.ok(rows.every(row=>typeof row.owner==='string'&&typeof row.protected==='boolean'&&Array.isArray(row.rules)));
  await assert.rejects(queryWindowsAclMetadata([path.resolve('nonexistent-acl-transport-fixture')]),error=>error instanceof ManagedCredentialValidationError&&error.code==='managed-credential-acl-query-process');
});

test('protected loader returns native memory key and local-only declaration, refuses bad files and links without disclosing material',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'devint-fake-key-'));
  const directory=path.join(root,'config');await fs.mkdir(directory);
  const keyPath=path.join(directory,'github-app.pem');
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const pem=privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const options={inspectAcl:async()=>safeAcl()};
  try {
    await fs.writeFile(path.join(directory,'service.json'),JSON.stringify(config),{mode:0o600});
    await fs.writeFile(keyPath,pem,{mode:0o600});
    const loaded=await loadManagedGithubApp(config,directory,options);
    assert.equal(loaded.privateKey.asymmetricKeyType,'rsa');
    const payload=Buffer.from('disposable-signature-fixture');
    assert.equal(verify('RSA-SHA256',payload,publicKey,sign('RSA-SHA256',payload,loaded.privateKey)),true);
    assert.equal(loaded.summary.providerAuthentication,'not-probed');
    assert.equal(loaded.summary.sourceReachability,'not-probed');
    assert.equal(JSON.stringify(loaded).includes(pem.split('\n')[1]),false);
    await assert.rejects(loadManagedGithubApp(config,directory,{inspectAcl:async()=>({...safeAcl(),owner:'untrusted'})}),/protected material/);
    await assert.rejects(loadManagedGithubApp(config,directory,{inspectAcl:async target=>target.endsWith('service.json')?{...safeAcl(),rules:[...safeAcl().rules,{sid:'S-1-1-0',type:'Allow',rights:2}]}:safeAcl()}),/protected material/);
    for(const bytes of ['not a PEM', 'x'.repeat(33*1024),generateKeyPairSync('rsa',{modulusLength:1024}).privateKey.export({type:'pkcs8',format:'pem'}).toString()]) {
      await fs.writeFile(keyPath,bytes);await assert.rejects(loadManagedGithubApp(config,directory,options),error=>error.message==='Managed GitHub App protected material is unavailable or invalid');
    }
    await fs.unlink(keyPath);await assert.rejects(loadManagedGithubApp(config,directory,options),/protected material/);
    const other=path.join(root,'other.pem');await fs.writeFile(other,pem,{mode:0o600});
    await fs.link(other,keyPath);await assert.rejects(loadManagedGithubApp(config,directory,options),/protected material/);await fs.unlink(keyPath);
    await fs.symlink(root,path.join(directory,'junction'),'junction');
    await assert.rejects(loadManagedGithubApp(config,path.join(directory,'junction','config'),options),/protected material/);
    await fs.unlink(path.join(directory,'junction'));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
