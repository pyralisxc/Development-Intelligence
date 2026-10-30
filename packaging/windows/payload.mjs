import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function regularAncestors(root) {
  for (let current=path.resolve(root); ; current=path.dirname(current)) {
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Reparse package ancestor refused');
    if (path.dirname(current)===current) break;
  }
}
export async function scratchInventory(root,transient=false) {
  const items=[];
  async function visit(directory) {
    let names;
    try { names=await fs.readdir(directory); } catch(error) { if(transient&&error.code==='ENOENT') return; throw error; }
    for(const name of names) {
      const target=path.join(directory,name); let stat;
      try { stat=await fs.lstat(target); } catch(error) { if(transient&&error.code==='ENOENT') continue; throw error; }
      if(stat.isSymbolicLink()) throw new Error('Scratch contains a reparse link; operator inspection is required');
      if(stat.isDirectory()) await visit(target);
      else if(stat.isFile()) items.push({path:target,bytes:stat.size});
      else throw new Error('Scratch contains an unsupported file type');
    }
  }
  const stat=await fs.lstat(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()) throw new Error('Scratch root is not a regular directory');
  await visit(root); return items;
}
export async function verifyPayload(root) {
  await regularAncestors(root);
  const manifestStat=await fs.lstat(path.join(root,'manifest.json'));
  if(!manifestStat.isFile()||manifestStat.isSymbolicLink()||manifestStat.size>16*1024**2) throw new Error('Invalid package manifest file');
  const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
  if(manifest.formatVersion!==1||!/^[a-f0-9]{40}$/.test(manifest.engineSha)||manifest.packagingSha!==manifest.engineSha||!Array.isArray(manifest.files)||!manifest.files.length) throw new Error('Invalid package identity');
  const actual=new Set((await scratchInventory(root)).map(item=>path.relative(root,item.path).replaceAll('\\','/').toLowerCase()));
  actual.delete('manifest.json'); const declared=new Set();
  for(const item of manifest.files) {
    if(typeof item.path!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256)||path.isAbsolute(item.path)||/[\\:]/.test(item.path)||item.path.split('/').some(part=>!part||part==='.'||part==='..')) throw new Error('Invalid manifest path');
    const key=item.path.toLowerCase();
    if(declared.has(key)||!actual.has(key)) throw new Error('Package inventory mismatch');
    declared.add(key); const target=path.join(root,item.path); const stat=await fs.lstat(target);
    if(!stat.isFile()||stat.isSymbolicLink()) throw new Error('Package contains a non-regular file');
    if(createHash('sha256').update(await fs.readFile(target)).digest('hex')!==item.sha256) throw new Error(`Package integrity failure: ${item.path}`);
  }
  if(actual.size!==declared.size) throw new Error('Package contains undeclared files');
  return manifest;
}
