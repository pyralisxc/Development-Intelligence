import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic, provider-free specimen. No project semantics or production hooks.
export function workloadSources() {
  const files = new Map();
  for (let i=0;i<64;i++) files.set(`module${i}.ts`, Array.from({length:20},(_,j)=>
    `export function value${i}_${j}(input: number): number { return input + ${i+j}; }`).join('\n'));
  for (let i=0;i<32;i++) {
    files.set(`Sample${i}.cs`, `namespace Fixture { public class Sample${i} { public int Count { get; set; } public int Value(int input) { return input + ${i}; } } }`);
    files.set(`Sample${i}.java`, `package fixture; public class Sample${i} { public int value(int input) { return input + ${i}; } }`);
    files.set(`sample${i}.py`, `def value_${i}(input):\n    return input + ${i}\n`);
  }
  files.set('revision.ts','export function historicalOnly(): string { return "old"; }\n');
  return files;
}
export async function writeWorkload(root) {
  await fs.mkdir(root); // Refuse reuse, never overwrite an existing fixture.
  const files=workloadSources();
  for (const [name,source] of files) await fs.writeFile(path.join(root,name),source,{flag:'wx'});
  return {files:files.size,sourceBytes:[...files.values()].reduce((n,s)=>n+Buffer.byteLength(s),0)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(JSON.stringify(await writeWorkload(process.argv[2])));
