import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { IntelligenceGraph } from '../types.js';
import { bindLocalGraphIndex, buildLocalGraphIndex, readIndexedQuestionEnvelope } from './localGraphIndex.js';
import { graphFamilyMemberships } from './graphFamilies.js';

type Field = 'nodes' | 'edges' | 'evidence';
type Entry = { generation: string; graphId: string; createdAt: string; sourceFingerprint: string | null };
type Catalog = { version: 1; project: string; active: string; entries: Entry[]; targets?: Record<string, string> };
type Part = { field: Field; file: string; sha256: string };
type Manifest = { version: 1; graph: IntelligenceGraph; parts: Part[] };

function projectDirectory(root: string, project: string): string {
  return path.join(path.resolve(root), 'source-graphs', createHash('sha256').update(project).digest('hex'));
}

async function catalogAt(directory: string): Promise<Catalog | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(directory, 'catalog.json'), 'utf8')) as Catalog;
    if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error('Invalid local graph catalog');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeCatalog(directory: string, catalog: Catalog): Promise<void> {
  const temporary = path.join(directory, `.catalog-${randomBytes(12).toString('hex')}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(catalog));
  await fs.rename(temporary, path.join(directory, 'catalog.json'));
}

/** Serialize publication and reads so terminal, Workbench and MCP cannot race retention. */
async function withCatalogLock<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(directory, '.catalog-lock');
  for (;;) {
    try {
      await fs.mkdir(lock);
      try { await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid })); }
      catch (error) { await fs.rm(lock, { recursive: true, force: true }); throw error; }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')) as { pid?: number };
        if (Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0) {
          try { process.kill(owner.pid, 0); }
          catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { await fs.rm(lock, { recursive: true, force: true }); continue; } }
        }
      } catch (readError) {
        if (!(readError instanceof SyntaxError) && (readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
        try { if (Date.now() - (await fs.stat(lock)).mtimeMs > 60_000) { await fs.rm(lock, { recursive: true, force: true }); continue; } }
        catch (statError) { if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue; throw statError; }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { return await fn(); }
  finally { await fs.rm(lock, { recursive: true, force: true }); }
}

/** Source graph generations are rebuildable; this directory never owns accepted semantic state. */
export async function saveLocalSourceGraph(root: string, graph: IntelligenceGraph, retain = 3, targetName = 'working'): Promise<Entry> {
  if (!Number.isSafeInteger(retain) || retain < 1) throw new Error('Graph retention must be a positive integer');
  if (!/^[A-Za-z0-9._-]+$/u.test(targetName)) throw new Error('Graph target must use letters, numbers, dot, underscore or dash');
  const directory = projectDirectory(root, graph.project);
  await fs.mkdir(directory, { recursive: true });
  const generation = randomBytes(16).toString('hex');
  const target = path.join(directory, generation);
  await fs.mkdir(target);
  const parts: Part[] = [];
  try {
    for (const field of ['nodes', 'edges', 'evidence'] as Field[]) {
      let batch: string[] = [];
      let size = 2;
      let index = 0;
      const flush = async () => {
        if (!batch.length) return;
        const body = `[${batch.join(',')}]`;
        const file = `${field}-${index++}.json`;
        await fs.writeFile(path.join(target, file), body);
        parts.push({ field, file, sha256: createHash('sha256').update(body).digest('hex') });
        batch = []; size = 2;
      };
      for (const item of graph[field]) {
        const body = JSON.stringify(item);
        const bytes = Buffer.byteLength(body) + 1;
        if (batch.length && size + bytes > 8 * 1024 * 1024) await flush();
        batch.push(body); size += bytes;
      }
      await flush();
    }
    buildLocalGraphIndex(target, generation, graph, graphFamilyMemberships(graph));
    const manifest: Manifest = { version: 1, graph: { ...graph, nodes: [], edges: [], evidence: [] }, parts };
    await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest));
    return await withCatalogLock(directory, async () => {
      const previous = await catalogAt(directory);
      if (previous && previous.project !== graph.project) throw new Error('Local graph project mismatch');
      const entry: Entry = { generation, graphId: graph.graphId, createdAt: graph.createdAt, sourceFingerprint: graph.sourceFingerprint };
      const entries = [entry, ...(previous?.entries ?? [])];
      const active = targetName === 'working' ? generation : previous?.active ?? generation;
      const targets = { ...(previous?.targets ?? (previous ? { working: previous.active } : {})), [targetName]: generation };
      const protectedGenerations = new Set([active, ...Object.values(targets)]);
      for (const item of entries) {
        if (protectedGenerations.size >= retain) break;
        protectedGenerations.add(item.generation);
      }
      const kept = entries.filter(item => protectedGenerations.has(item.generation));
      await writeCatalog(directory, { version: 1, project: graph.project, active, entries: kept, targets });
      const keptGenerations = new Set(kept.map(item => item.generation));
      for (const old of entries.filter(item => !keptGenerations.has(item.generation))) {
        if (/^[a-f0-9]{32}$/u.test(old.generation)) await fs.rm(path.join(directory, old.generation), { recursive: true, force: true });
      }
      return entry;
    });
  } catch (error) {
    // Once published, preserve the generation even if later cleanup fails.
    const current = await catalogAt(directory);
    if (!current?.entries.some(item => item.generation === generation)) await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function localSourceGraphHistory(root: string, project: string): Promise<Catalog | null> {
  return await catalogAt(projectDirectory(root, project));
}

/** Copy only catalog-referenced generations while each project is stable. */
export async function backupLocalSourceGraphs(root: string, destination: string): Promise<void> {
  const source = path.resolve(root, 'source-graphs');
  const target = path.resolve(destination, 'source-graphs');
  if (source === target || target.startsWith(`${source}${path.sep}`) || source.startsWith(`${target}${path.sep}`)) throw new Error('Backup and source graph directories must be separate');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(target);
  try {
    for (const name of await fs.readdir(source)) {
      if (!/^[a-f0-9]{64}$/u.test(name)) continue;
      const directory = path.join(source, name), destinationDirectory = path.join(target, name);
      if (!(await fs.stat(directory)).isDirectory()) continue;
      await withCatalogLock(directory, async () => {
        const catalog = await catalogAt(directory);
        if (!catalog) return;
        await fs.mkdir(destinationDirectory);
        await fs.copyFile(path.join(directory, 'catalog.json'), path.join(destinationDirectory, 'catalog.json'));
        for (const entry of catalog.entries) {
          if (!/^[a-f0-9]{32}$/u.test(entry.generation)) throw new Error('Invalid local graph generation');
          await fs.cp(path.join(directory, entry.generation), path.join(destinationDirectory, entry.generation), { recursive: true, errorOnExist: true, force: false });
        }
      });
    }
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function activateLocalSourceGraph(root: string, project: string, graphId: string): Promise<void> {
  const directory = projectDirectory(root, project);
  await readLocalSourceGraph(root, project, graphId);
  await withCatalogLock(directory, async () => {
    const catalog = await catalogAt(directory);
    const entry = catalog?.entries.find(item => item.graphId === graphId);
    if (!catalog || catalog.project !== project || !entry) throw new Error(`Local graph is not retained: ${graphId}`);
    await writeCatalog(directory, { ...catalog, active: entry.generation });
  });
}

export async function removeLocalGraphTarget(root: string, project: string, name: string): Promise<void> {
  if (name === 'working') throw new Error('The working target is updated by rebuilding the current files');
  const directory = projectDirectory(root, project);
  await withCatalogLock(directory, async () => {
    const catalog = await catalogAt(directory);
    if (!catalog || catalog.project !== project || !catalog.targets?.[name]) throw new Error(`Unknown local graph target: ${name}`);
    const targets = { ...catalog.targets };
    delete targets[name];
    await writeCatalog(directory, { ...catalog, targets });
  });
}

export async function readLocalSourceGraph(root: string, project: string, graphId?: string, generation?: string): Promise<IntelligenceGraph> {
  const directory = projectDirectory(root, project);
  try { await fs.access(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No local graph for ${project}; build it first`); throw error; }
  return await withCatalogLock(directory, async () => {
  const catalog = await catalogAt(directory);
  if (!catalog || catalog.project !== project) throw new Error(`No local graph for ${project}; build it first`);
  const entry = generation ? catalog.entries.find(item => item.generation === generation && (!graphId || item.graphId === graphId)) : graphId ? catalog.entries.find(item => item.graphId === graphId) : catalog.entries.find(item => item.generation === catalog.active);
  if (!entry || !/^[a-f0-9]{32}$/u.test(entry.generation)) throw new Error(`Local graph is not retained: ${graphId ?? 'active'}`);
  const target = path.join(directory, entry.generation);
  const manifest = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.version !== 1 || manifest.graph.project !== project || manifest.graph.graphId !== entry.graphId || !Array.isArray(manifest.parts)) throw new Error('Invalid local graph manifest');
  for (const part of manifest.parts) {
    if (!['nodes', 'edges', 'evidence'].includes(part.field) || !new RegExp(`^${part.field}-[0-9]+\\.json$`, 'u').test(part.file)) throw new Error('Invalid local graph part');
    const body = await fs.readFile(path.join(target, part.file), 'utf8');
    if (createHash('sha256').update(body).digest('hex') !== part.sha256) throw new Error(`Local graph part changed: ${part.file}`);
    const items = JSON.parse(body);
    if (!Array.isArray(items)) throw new Error('Invalid local graph part contents');
    for (const item of items) (manifest.graph[part.field] as unknown[]).push(item);
  }
    try {
      await fs.access(path.join(target, 'retrieval-index.sqlite'));
      bindLocalGraphIndex(manifest.graph, entry.generation, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return manifest.graph;
  });
}

/** Open the identity and coverage envelope for generation-bound record access.
 * The arrays are intentionally empty: callers must use the index to select
 * records and must not treat the envelope as a materialized complete graph. */
export async function withLocalSourceGraphEnvelope<T>(root: string, project: string, use: (graph: IntelligenceGraph) => Promise<T> | T, graphId?: string, generation?: string, compactQuestion = false): Promise<T> {
  const directory = projectDirectory(root, project);
  return await withCatalogLock(directory, async () => {
    const catalog = await catalogAt(directory);
    if (!catalog || catalog.project !== project) throw new Error(`No local graph for ${project}; build it first`);
    const entry = generation ? catalog.entries.find(item => item.generation === generation && (!graphId || item.graphId === graphId)) : graphId ? catalog.entries.find(item => item.graphId === graphId) : catalog.entries.find(item => item.generation === catalog.active);
    if (!entry || !/^[a-f0-9]{32}$/u.test(entry.generation)) throw new Error(`Local graph is not retained: ${graphId ?? 'active'}`);
    const target = path.join(directory, entry.generation);
    try { await fs.access(path.join(target, 'retrieval-index.sqlite')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('This retained graph needs a current retrieval index'); throw error; }
    if (compactQuestion) {
      const graph = readIndexedQuestionEnvelope(target, project, entry.generation, entry.graphId, entry.sourceFingerprint);
      if (!graph || !bindLocalGraphIndex(graph, entry.generation, target)) throw new Error('This retained graph needs a current retrieval index');
      return await use(graph);
    }
    const manifest = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8')) as Manifest;
    if (manifest.version !== 1 || manifest.graph.project !== project || manifest.graph.graphId !== entry.graphId || !Array.isArray(manifest.parts)) throw new Error('Invalid local graph manifest');
    if (manifest.graph.nodes.length || manifest.graph.edges.length || manifest.graph.evidence.length) throw new Error('Invalid local graph envelope');
    if (!bindLocalGraphIndex(manifest.graph, entry.generation, target)) throw new Error('This retained graph needs a current retrieval index');
    return await use(manifest.graph);
  });
}
