import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../src/', import.meta.url);
const forbiddenProjectCoupling = [
  /cardforge/i,
  /\bdesk\b/i,
  /\bpipeline\b/i,
  /game\s*studio/i,
  /founder[- ]to[- ]feature/i,
  /developer\s*os/i,
  /productRealityKind/i,
  /planned[-_ ]mcp/i,
];
const forbiddenArchitectureDependencies = [
  /codebase-memory-mcp/i,
  /CBM_CACHE_DIR/i,
  /@google-cloud\//i,
  /\bFirestore\b/i,
  /\bCloud Run\b/i,
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
  for (const pattern of [...forbiddenProjectCoupling, ...forbiddenArchitectureDependencies]) {
    if (pattern.test(text)) violations.push(`${path.relative(process.cwd(), file)} matches ${pattern}`);
  }
}
const packageText = await fs.readFile(new URL('../package.json', import.meta.url), 'utf8');
for (const pattern of forbiddenArchitectureDependencies) if (pattern.test(packageText)) violations.push(`package.json matches ${pattern}`);

if (violations.length) {
  console.error('Development Intelligence boundary violation:\n' + violations.join('\n'));
  process.exit(1);
}
console.log('generic-boundary: ok');
