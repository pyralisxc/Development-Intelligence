import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync} from 'node:crypto';
import {bindGithubAppCredential,resolveRepositoryCredential} from '../src/source/repositoryCredential.js';
import {gitAuth} from '../src/source/gitAuth.js';
import {runChecked} from '../src/util/process.js';
import type {ProjectConfig} from '../src/types.js';

const repository='https://github.com/fixture/approved.git';
const config: ProjectConfig={repository,defaultRef:'HEAD',credential:{type:'github-app-bound',binding:'fixture-memory'}};

test('in-memory App binding reuses single-repository read-only exchange without key environment/child/header exposure',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const dispose=bindGithubAppCredential('fixture-memory','123456',privateKey,[repository]);
  const originalFetch=globalThis.fetch;
  const calls: string[]=[];
  globalThis.fetch=async(input: any,init: any={})=>{
    const url=String(input);calls.push(url);
    assert.equal(init.redirect,'error');assert.ok(init.signal);
    assert.equal(JSON.stringify(init).includes('BEGIN PRIVATE KEY'),false);
    if(url.endsWith('/repos/fixture/approved/installation')) return Response.json({id:42,account:{login:'fixture'}});
    assert.ok(url.endsWith('/app/installations/42/access_tokens'));
    assert.deepEqual(JSON.parse(init.body),{repositories:['approved'],permissions:{contents:'read',pull_requests:'read'}});
    return Response.json({token:'disposable-read-token',expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{contents:'read',metadata:'read',pull_requests:'read'}});
  };
  try {
    const credential=await resolveRepositoryCredential(config);
    assert.equal(credential?.token,'disposable-read-token');
    const auth=await gitAuth(config);
    try {
      assert.equal(auth.env.DEVINT_GIT_TOKEN,'disposable-read-token');
      const child=await runChecked(process.execPath,['-e',`const values=Object.values(process.env);console.log(JSON.stringify({pem:values.some(v=>v.includes('BEGIN PRIVATE KEY')),token:process.env.DEVINT_GIT_TOKEN==='disposable-read-token'}))`],{env:auth.env,timeoutMs:5000});
      assert.deepEqual(JSON.parse(child.stdout),{pem:false,token:true});
    } finally {await auth.cleanup();}
    await assert.rejects(resolveRepositoryCredential({...config,repository:'https://github.com/fixture/other.git'}),/outside the in-memory/);
    assert.equal(calls.length,2,'unlisted repository must be refused before provider call, cached token remains scoped');
    assert.equal(Object.values(process.env).some(value=>typeof value==='string'&&value.includes('BEGIN PRIVATE KEY')),false);
    dispose();
    await assert.rejects(resolveRepositoryCredential(config),/material is unavailable/);
  } finally {dispose();globalThis.fetch=originalFetch;}
});

test('bound credential exchange refuses write scope and malformed/oversized responses without exposing payload',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const originalFetch=globalThis.fetch;
  try {
    for(const response of [Response.json({token:'fake-secret-write-token',expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{contents:'write'}}),new Response('fake-secret-non-json'),new Response('x'.repeat(65537))]) {
      const dispose=bindGithubAppCredential('fixture-memory','123456',privateKey,[repository]);
      globalThis.fetch=async(input: any)=>String(input).endsWith('/installation')?Response.json({id:42,account:{login:'fixture'}}):response;
      try { await assert.rejects(resolveRepositoryCredential(config),(error: Error)=>!error.message.includes('fake-secret')&&/non-read permission|invalid or exceeds bounds/.test(error.message)); }
      finally {dispose();}
    }
  } finally {globalThis.fetch=originalFetch;}
});

test('binding replacement/disposal cannot admit an old in-flight token into the new binding cache',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const originalFetch=globalThis.fetch;
  let tokenRequested!: ()=>void;
  const requested=new Promise<void>(resolve=>{tokenRequested=resolve;});
  let respond!: (response: Response)=>void;
  const dispose=bindGithubAppCredential('fixture-memory','123456',privateKey,[repository]);
  globalThis.fetch=async(input: any)=>{
    if(String(input).endsWith('/installation')) return Response.json({id:42,account:{login:'fixture'}});
    tokenRequested();return await new Promise<Response>(resolve=>{respond=resolve;});
  };
  try {
    const pending=resolveRepositoryCredential(config);await requested;
    const replacement=bindGithubAppCredential('fixture-memory','123456',privateKey,[repository]);
    dispose();
    respond(Response.json({token:'old-disposable-token',expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{contents:'read',pull_requests:'read'}}));
    try {await assert.rejects(pending,/binding changed/);} finally {replacement();}
  } finally {dispose();globalThis.fetch=originalFetch;}
});
