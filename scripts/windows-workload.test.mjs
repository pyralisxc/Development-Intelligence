import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workloadSources,writeWorkload } from '../packaging/windows/workload-fixture.mjs';

test('managed workload specimen is deterministic, bounded, cross-language and refuses reuse',async()=>{
  const sources=workloadSources();
  assert.equal(sources.size,161);
  for(const [ext,count] of [['.ts',65],['.cs',32],['.java',32],['.py',32]]) assert.equal([...sources.keys()].filter(n=>n.endsWith(ext)).length,count);
  assert.deepEqual(workloadSources(),sources);
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'di-workload-'));
  try {
    const root=path.join(parent,'fixture');
    const result=await writeWorkload(root);
    assert.equal(result.files,161);
    assert.ok(result.sourceBytes>90000&&result.sourceBytes<200000);
    await assert.rejects(writeWorkload(root),{code:'EEXIST'});
    assert.equal(await fs.readFile(path.join(root,'revision.ts'),'utf8'),sources.get('revision.ts'));
  } finally { await fs.rm(parent,{recursive:true,force:true}); }
});
