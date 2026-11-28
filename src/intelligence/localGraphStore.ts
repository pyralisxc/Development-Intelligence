import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { IntelligenceGraph } from '../types.js';
import { bindLocalGraphIndex, buildLocalGraphIndex, readIndexedQuestionEnvelope } from './localGraphIndex.js';
import { graphFamilyMemberships } from './graphFamilies.js';

type Field = 'nodes' | 'edges' | 'evidence';
type Entry = { generation: string; graphId: string; createdAt: string; sourceFingerprint: string | null; lastBuiltAt?: string };
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
async function withCatalogLock<T>(directory: string, fn: () => Promise<T>, immutableSnapshot = false): Promise<T> {
  if (immutableSnapshot) return await fn();
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
        if (typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
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
export async function saveLocalSourceGraph(root: string, graph: IntelligenceGraph, retain = 3, targetName = 'working', activate = true): Promise<Entry> {
  if (!Number.isSafeInteger(retain) || retain < 1) throw new Error('Graph retention must be a positive integer');
  if (!targetName.trim() || targetName !== targetName.trim() || /[\u0000-\u001f\u007f]/u.test(targetName)) throw new Error('Graph name must be non-empty and cannot contain control characters');
  const directory = projectDirectory(root, graph.project);
  await fs.mkdir(directory, { recursive: true });
  const generation = randomBytes(16).toString('hex');
  const target = path.join(directory, generation);
  await fs.mkdir(target);
  const parts: Part[] = [];
  const lengths = { nodes: new Float64Array(graph.nodes.length), edges: new Float64Array(graph.edges.length), evidence: new Float64Array(graph.evidence.length) };
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
      let ordinal = 0;
      for (const item of graph[field]) {
        const body = JSON.stringify(item);
        const length = Buffer.byteLength(body);
        lengths[field][ordinal++] = length;
        const bytes = length + 1;
        if (batch.length && size + bytes > 8 * 1024 * 1024) await flush();
        batch.push(body); size += bytes;
      }
      await flush();
    }
    const manifest: Manifest = { version: 1, graph: { ...graph, nodes: [], edges: [], evidence: [] }, parts };
    // Sharing is based on the complete serialized graph and metadata, not a
    // graph ID or topology fingerprint. Each name keeps its own catalog link.
    const comparable = (value: IntelligenceGraph) => JSON.stringify({ ...value, createdAt: undefined,
      sources: value.sources.map(source => source.id === 'repository' && source.kind === 'repository' && source.observedAt === value.createdAt
        ? { ...source, observedAt: undefined } : source) });
    const reused = await withCatalogLock(directory, async () => {
      const catalog = await catalogAt(directory);
      if (!catalog || catalog.project !== graph.project) return null;
      for (const candidate of catalog.entries) {
        if (candidate.graphId !== graph.graphId || !/^[a-f0-9]{32}$/u.test(candidate.generation)) continue;
        const candidateDirectory = path.join(directory, candidate.generation);
        try {
          const saved = JSON.parse(await fs.readFile(path.join(candidateDirectory, 'manifest.json'), 'utf8')) as Manifest;
          if (saved.version !== 1 || comparable(saved.graph) !== comparable(manifest.graph)
              || JSON.stringify(saved.parts) !== JSON.stringify(parts)
              || !bindLocalGraphIndex({ ...graph }, candidate.generation, candidateDirectory)) continue;
          let intact = true;
          for (const part of saved.parts) {
            if (!['nodes', 'edges', 'evidence'].includes(part.field) || !new RegExp(`^${part.field}-[0-9]+\\.json$`, 'u').test(part.file)
                || createHash('sha256').update(await fs.readFile(path.join(candidateDirectory, part.file))).digest('hex') !== part.sha256) { intact = false; break; }
          }
          if (!intact) continue;
        } catch { continue; }
        const entry: Entry = { ...candidate, lastBuiltAt: graph.createdAt };
        const entries = [entry, ...catalog.entries.filter(item => item.generation !== entry.generation)];
        const active = activate ? entry.generation : catalog.active;
        const targets = { ...(catalog.targets ?? { working: catalog.active }), [targetName]: entry.generation };
        const keep = new Set([active, ...Object.values(targets)]);
        for (const item of entries) { if (keep.size >= retain) break; keep.add(item.generation); }
        await writeCatalog(directory, { version: 1, project: graph.project, active, entries: entries.filter(item => keep.has(item.generation)), targets });
        for (const old of entries.filter(item => !keep.has(item.generation))) {
          if (/^[a-f0-9]{32}$/u.test(old.generation)) await fs.rm(path.join(directory, old.generation), { recursive: true, force: true });
        }
        return entry;
      }
      return null;
    });
    if (reused) { await fs.rm(target, { recursive: true, force: true }); return reused; }
    buildLocalGraphIndex(target, generation, graph, graphFamilyMemberships(graph), lengths);
    await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest));
    return await withCatalogLock(directory, async () => {
      const previous = await catalogAt(directory);
      if (previous && previous.project !== graph.project) throw new Error('Local graph project mismatch');
      const entry: Entry = { generation, graphId: graph.graphId, createdAt: graph.createdAt, sourceFingerprint: graph.sourceFingerprint };
      const entries = [entry, ...(previous?.entries ?? [])];
      const active = activate ? generation : previous?.active ?? generation;
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

/** Keep an in-flight account generation distinct from the published target. */
export function accountGraphStageTarget(graphId: string, claimId: string): string {
  if (!/^[a-f0-9]{32}$/u.test(graphId) || !/^[a-f0-9]{32}$/u.test(claimId)) throw new Error('Invalid account graph or claim identity');
  return `.di-account-stage-${graphId}-${claimId}`;
}

/**
 * Reconcile stages for one account graph while its caller holds the graph's
 * publication claim. The caller must supply the authoritative current graph captured under that
 * claim; never infer liveness from file age.
 */
export async function reconcileAccountGraphStages(root: string, project: string, graphId: string, currentGraphId: string, assertClaim: () => Promise<void>): Promise<void> {
  if (!currentGraphId || !/^[a-f0-9]{32}$/u.test(graphId)) throw new Error('Invalid account graph reference');
  const directory = projectDirectory(root, project), prefix = `.di-account-stage-${graphId}-`, targetName = `.di-account-current-${graphId}`;
  await withCatalogLock(directory, async () => {
    await assertClaim();
    const catalog = await catalogAt(directory);
    if (!catalog || catalog.project !== project) throw new Error('Account graph storage is unavailable');
    const current = catalog.entries.find(entry => entry.graphId === currentGraphId);
    if (!current) throw new Error('The current account graph is not available at this location');
    const targets = { ...(catalog.targets ?? { working: catalog.active }), [targetName]: current.generation };
    const removed = new Set<string>();
    for (const name of Object.keys(targets)) if (name.startsWith(prefix)) { removed.add(targets[name]!); delete targets[name]; }
    const active = removed.has(catalog.active) ? current.generation : catalog.active;
    const protectedGenerations = new Set([active, ...Object.values(targets)]);
    const retired = catalog.entries.filter(entry => removed.has(entry.generation) && !protectedGenerations.has(entry.generation));
    const retiredIds = new Set(retired.map(entry => entry.generation));
    await writeCatalog(directory, { ...catalog, active, entries: catalog.entries.filter(entry => !retiredIds.has(entry.generation)), targets });
    for (const entry of retired) if (/^[a-f0-9]{32}$/u.test(entry.generation)) await fs.rm(path.join(directory, entry.generation), { recursive: true, force: true });
  });
}

/** Storage accounting for the generations referenced by this project's catalog. */
export async function localSourceGraphStorage(root: string, project: string): Promise<Record<string, unknown> | null> {
  const directory = projectDirectory(root, project);
  const initial = await catalogAt(directory);
  if (!initial) return null;
  return await withCatalogLock(directory, async () => {
    const catalog = await catalogAt(directory);
    if (!catalog) return null;
    const generations = [];
    for (const entry of catalog.entries) {
      if (!/^[a-f0-9]{32}$/u.test(entry.generation)) throw new Error('Invalid local graph generation');
      const target = path.join(directory, entry.generation);
      let graphBytes = 0, indexBytes = 0;
      for (const item of await fs.readdir(target, { withFileTypes: true })) {
        if (!item.isFile()) continue;
        const size = (await fs.stat(path.join(target, item.name))).size;
        if (item.name === 'retrieval-index.sqlite') indexBytes += size;
        else graphBytes += size;
      }
      generations.push({ ...entry, active: catalog.active === entry.generation,
        names: Object.entries(catalog.targets ?? {}).filter(([, value]) => value === entry.generation).map(([name]) => name),
        graphBytes, indexBytes, indexPresent: indexBytes > 0, totalBytes: graphBytes + indexBytes });
    }
    return { project, generations, totalBytes: generations.reduce((sum, entry) => sum + entry.totalBytes, 0),
      retention: 'Active and named generations remain protected; other generations are pruned after a successful publication.',
      backup: 'Graph backup includes catalog-referenced generations and their indexes; it does not include source files or analysis caches.' };
  }, process.env.DEVINT_GRAPH_READ_ONLY_SNAPSHOT === '1');
}

/** Publish one already-built generation into another local store. */
export async function importLocalSourceGraph(source: string, destination: string, project: string, graphId: string, targetName: string, retain = 3, stageOnly = false): Promise<void> {
  if (path.resolve(source) === path.resolve(destination)) throw new Error('Transfer staging and graph storage must be different folders');
  if (!Number.isSafeInteger(retain) || retain < 1 || !targetName.trim()) throw new Error('Invalid graph retention or name');
  const sourceDirectory = projectDirectory(source, project), sourceCatalog = await catalogAt(sourceDirectory);
  const entry = sourceCatalog?.entries.find(item => item.graphId === graphId);
  if (!entry || !/^[a-f0-9]{32}$/u.test(entry.generation)) throw new Error('The transferred graph generation is unavailable');
  const generation = path.join(sourceDirectory, entry.generation);
  const destinationPath = path.resolve(destination);
  if (destinationPath === generation || destinationPath.startsWith(`${generation}${path.sep}`)) throw new Error('Graph storage cannot be inside the transferred generation');
  const manifest = JSON.parse(await fs.readFile(path.join(generation, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.version !== 1 || manifest.graph.project !== project || manifest.graph.graphId !== graphId || !Array.isArray(manifest.parts)) throw new Error('Invalid transferred graph manifest');
  const digest = async (file: string) => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  };
  for (const part of manifest.parts) {
    if (!['nodes', 'edges', 'evidence'].includes(part.field) || !new RegExp(`^${part.field}-[0-9]+\\.json$`, 'u').test(part.file)) throw new Error('Invalid transferred graph part');
    if (await digest(path.join(generation, part.file)) !== part.sha256) throw new Error(`Transferred graph part changed: ${part.file}`);
  }
  const directory = projectDirectory(destination, project), temporary = path.join(directory, `.transfer-${randomBytes(16).toString('hex')}`);
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.cp(generation, temporary, { recursive: true, force: false, errorOnExist: true });
    for (const item of await fs.readdir(temporary, { withFileTypes: true })) {
      if (!item.isFile()) throw new Error('Unexpected item in transferred graph');
      if (await digest(path.join(generation, item.name)) !== await digest(path.join(temporary, item.name))) throw new Error(`Transferred graph file changed: ${item.name}`);
    }
    await withCatalogLock(directory, async () => {
      const previous = await catalogAt(directory);
      if (previous && previous.project !== project) throw new Error('Local graph project mismatch');
      const generationPath = path.join(directory, entry.generation);
      try { await fs.rename(temporary, generationPath); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        for (const item of await fs.readdir(temporary, { withFileTypes: true })) {
          if (!item.isFile() || await digest(path.join(temporary, item.name)) !== await digest(path.join(generationPath, item.name))) throw new Error('An existing graph generation differs from the transferred generation');
        }
        await fs.rm(temporary, { recursive: true, force: true });
      }
      const entries = [entry, ...(previous?.entries ?? []).filter(item => item.generation !== entry.generation)];
      const targets = { ...(previous?.targets ?? (previous ? { working: previous.active } : {})), [targetName]: entry.generation };
      const active = !stageOnly && manifest.graph.sourceState ? entry.generation : previous?.active ?? entry.generation;
      const keep = new Set([active, ...Object.values(targets)]);
      for (const item of entries) { if (keep.size >= retain) break; keep.add(item.generation); }
      const kept = entries.filter(item => keep.has(item.generation));
      await writeCatalog(directory, { version: 1, project, active, entries: kept, targets });
      for (const item of entries.filter(item => !keep.has(item.generation))) {
        if (/^[a-f0-9]{32}$/u.test(item.generation)) await fs.rm(path.join(directory, item.generation), { recursive: true, force: true });
      }
    });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
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
  const directory = projectDirectory(root, project);
  await withCatalogLock(directory, async () => {
    const catalog = await catalogAt(directory);
    if (!catalog || catalog.project !== project || !catalog.targets || !Object.hasOwn(catalog.targets, name)) throw new Error(`Unknown local graph target: ${name}`);
    const targets = { ...catalog.targets };
    delete targets[name];
    await writeCatalog(directory, { ...catalog, targets });
  });
}

export async function readLocalSourceGraph(root: string, project: string, graphId?: string, generation?: string, skipIndex = false): Promise<IntelligenceGraph> {
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
    if (!skipIndex) try {
      await fs.access(path.join(target, 'retrieval-index.sqlite'));
      bindLocalGraphIndex(manifest.graph, entry.generation, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return manifest.graph;
  }, process.env.DEVINT_GRAPH_READ_ONLY_SNAPSHOT === '1');
}

/** Rebuild a disposable retrieval index from its retained, validated graph. */
export async function rebuildLocalGraphIndex(root: string, project: string, targetName?: string): Promise<Record<string, unknown>> {
  if (process.env.DEVINT_GRAPH_READ_ONLY_SNAPSHOT === '1') throw new Error('A read-only graph snapshot cannot be reindexed');
  const directory = projectDirectory(root, project);
  const catalog = await catalogAt(directory);
  if (!catalog || catalog.project !== project) throw new Error(`No local graph for ${project}; build it first`);
  const generation = targetName ? catalog.targets?.[targetName] : catalog.active;
  const entry = catalog.entries.find(item => item.generation === generation);
  if (!entry || !/^[a-f0-9]{32}$/u.test(entry.generation)) throw new Error(`No retained graph for ${targetName ?? 'active target'}`);
  const graph = await readLocalSourceGraph(root, project, entry.graphId, entry.generation, true);
  const temporary = await fs.mkdtemp(path.join(directory, '.reindex-'));
  let preserveTemporary = false;
  try {
    const lengths = { nodes: Float64Array.from(graph.nodes, item => Buffer.byteLength(JSON.stringify(item))),
      edges: Float64Array.from(graph.edges, item => Buffer.byteLength(JSON.stringify(item))),
      evidence: Float64Array.from(graph.evidence, item => Buffer.byteLength(JSON.stringify(item))) };
    const audit = buildLocalGraphIndex(temporary, entry.generation, graph, graphFamilyMemberships(graph), lengths);
    await withCatalogLock(directory, async () => {
      const current = await catalogAt(directory);
      if (!current?.entries.some(item => item.generation === entry.generation && item.graphId === entry.graphId)) throw new Error('The graph was removed while its index was being rebuilt');
      const target = path.join(directory, entry.generation, 'retrieval-index.sqlite');
      const backup = path.join(temporary, 'previous.sqlite');
      let hadPrevious = false;
      try { await fs.rename(target, backup); hadPrevious = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { await fs.rename(path.join(temporary, 'retrieval-index.sqlite'), target); }
      catch (error) {
        if (hadPrevious) {
          try { await fs.rename(backup, target); }
          catch { preserveTemporary = true; throw new Error(`Could not install or restore the retrieval index; the previous index remains at ${backup}`, { cause: error }); }
        }
        throw error;
      }
    });
    return { project, graphId: entry.graphId, generation: entry.generation, audit };
  } finally { if (!preserveTemporary) await fs.rm(temporary, { recursive: true, force: true }); }
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
  }, process.env.DEVINT_GRAPH_READ_ONLY_SNAPSHOT === '1');
}
