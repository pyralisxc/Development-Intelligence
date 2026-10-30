import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {queryWindowsAclMetadata,ManagedCredentialValidationError,NATIVE_ACL_QUERY_TIMEOUT_MS} from './managed-credentials.mjs';

// Native startup/transport proof, not a parallel-suite load benchmark. Run this
// explicitly before source verification; installed lifecycle repeats real ACL
// checks under the actual restricted service identity.
test('native Windows ACL executable/isolated-env/JSON transport works without service installation',{skip:process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'},async()=>{
  const started=Date.now();
  const rows=await queryWindowsAclMetadata([path.resolve('AGENTS.md'),path.resolve('ORCHESTRATION.md'),path.resolve('.')]);
  const elapsedMs=Date.now()-started;
  assert.equal(rows.length,3);
  assert.ok(rows.every(row=>typeof row.owner==='string'&&typeof row.protected==='boolean'&&Array.isArray(row.rules)));
  const receiptDirectory=path.resolve('.package-build');
  await fs.mkdir(receiptDirectory,{recursive:true});
  await fs.writeFile(path.join(receiptDirectory,'native-acl-transport.json'),JSON.stringify({metadataOnly:true,requiresServiceInstallation:false,parallelSourceVerification:false,pathCount:rows.length,elapsedMs,timeoutMs:NATIVE_ACL_QUERY_TIMEOUT_MS,maxOutputBytes:32768}));
  await assert.rejects(queryWindowsAclMetadata([path.resolve('nonexistent-acl-transport-fixture')]),error=>error instanceof ManagedCredentialValidationError&&error.code==='managed-credential-acl-query-process');
});
