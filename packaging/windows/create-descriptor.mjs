import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDescriptor } from './compatibility.mjs';
const [source,sha,output]=process.argv.slice(2);
if (!source || !/^[a-f0-9]{40}$/.test(sha??'') || !output) throw new Error('Exact source, SHA and output required');
const { engineDescriptor }=await import(pathToFileURL(path.join(source,'dist/src/runtimeDescriptor.js')).href);
const dependencies=JSON.parse(await fs.readFile(path.join(source,'packaging/windows/dependencies.json'),'utf8'));
await fs.writeFile(output,JSON.stringify(createDescriptor(engineDescriptor(),{engineSha:sha,packagingSha:sha},dependencies)));
