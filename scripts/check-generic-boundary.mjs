import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../src/', import.meta.url);
const forbidden = [
  /cardforge/i,
  /\bdesk\b/i,
  /\bpipeline\b/i,
  /game\s*studio/i,
  /founder[- ]to[- ]feature/i,
  /developer\s*os/i,
];

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(p));
    else if (entry.name.endsWith('.ts')) files.push(p);
  }
  return files;
}

const files = await walk(fileURLToPath(root));
const violations = [];
for (const file of files) {
  const text = await fs.readFile(file, 'utf8');
  for (const pattern of forbidden) {
    if (pattern.test(text)) violations.push(`${path.relative(process.cwd(), file)} matches ${pattern}`);
  }
}
if (violations.length) {
  console.error('Project-specific/workflow coupling found in generic source:\n' + violations.join('\n'));
  process.exit(1);
}
console.log('generic-boundary: ok');
