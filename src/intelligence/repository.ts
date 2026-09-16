import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { EvidenceRecord, GraphCoverage, GraphEdge, GraphNode, IntelligenceGraph, SourceDescriptor } from '../types.js';
import { runChecked } from '../util/process.js';
import { stableHash } from '../util/hash.js';
import { analyzeByTechnology } from './analyzers/index.js';
import { detectProviders } from './providers.js';
import { evidenceRecord, observation, resolution, semanticEntity, semanticRelationship } from './model.js';
import { deriveNamingDivergences, deriveUnmatched, resolveCrossSource } from './resolver.js';

export const GRAPH_DIRECTORY = '.development-intelligence';
export const ANALYZER_VERSION = '2.1.0-stable-entity';

const MAX_FILE_BYTES = Number(process.env.DEVINT_GRAPH_MAX_FILE_BYTES ?? process.env.DEVINT_PARITY_MAX_FILE_BYTES ?? 1_000_000);
const MAX_FILES = Number(process.env.DEVINT_GRAPH_MAX_FILES ?? process.env.DEVINT_PARITY_MAX_FILES ?? 10_000);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const TEXT_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.json', '.md', '.mdx', '.html', '.htm']);
const SYMBOL_KINDS = new Set(['function', 'method', 'class', 'interface', 'type', 'declaration']);
const SEMANTIC_PREFIXES = new Set(['surface', 'capability', 'action', 'feature', 'route', 'api', 'mcp', 'provider', 'tool', 'workflow']);

interface TrackedFile {
  path: string;
  mode: string;
  blob: string;
}

interface ModuleBinding {
  local: string;
  imported: string;
  module: string;
  targetFile: string | null;
  line: number;
  bindingNode: GraphNode;
}

interface ReexportBinding {
  imported: string;
  targetFile: string;
}

interface ModuleInfo {
  sourceFile: ts.SourceFile;
  imports: Map<string, ModuleBinding>;
  reexports: Map<string, ReexportBinding>;
  exportAll: string[];
  importedSpecifiers: string[];
}

async function trackedFiles(root: string): Promise<TrackedFile[]> {
  const result = await runChecked('git', ['-C', root, 'ls-files', '-s', '-z']);
  const output: TrackedFile[] = [];
  for (const record of result.stdout.split('\0').filter(Boolean)) {
    const match = /^(\d+)\s+([0-9a-f]+)\s+\d+\t(.+)$/u.exec(record);
    if (!match) continue;
    const mode = match[1]!;
    const blob = match[2]!;
    const filePath = match[3]!;
    if (filePath === GRAPH_DIRECTORY || filePath.startsWith(`${GRAPH_DIRECTORY}/`)) continue;
    output.push({ path: filePath, mode, blob });
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

export async function sourceFingerprint(root: string): Promise<string> {
  const tracked = await trackedFiles(root);
  if (tracked.some(file => file.path.includes('\n'))) throw new Error('Tracked filenames containing newlines are not supported by graph sealing');
  const regular = tracked.filter(file => file.mode !== '120000' && file.mode !== '160000');
  const regularHashes = regular.length
    ? (await runChecked('git', ['-C', root, 'hash-object', '--no-filters', '--stdin-paths'], { input: `${regular.map(file => file.path).join('\n')}\n` })).stdout.trim().split(/\r?\n/u)
    : [];
  if (regularHashes.length !== regular.length) throw new Error('Unable to fingerprint every tracked regular source file');
  const regularByPath = new Map(regular.map((file, index) => [file.path, regularHashes[index]!]));
  const hash = createHash('sha256');
  for (const file of tracked) {
    let contentHash: string;
    if (file.mode === '120000') {
      const target = await fs.readlink(path.join(root, file.path));
      contentHash = createHash('sha256').update(target).digest('hex');
    } else if (file.mode === '160000') {
      contentHash = file.blob;
    } else {
      contentHash = regularByPath.get(file.path)!;
    }
    hash.update(`${file.mode}\0${contentHash}\0${file.path}\0`);
  }
  return hash.digest('hex');
}

function fileNode(source: SourceDescriptor, relative: string): GraphNode {
  return observation({
    id: `file:${relative}`,
    sourceId: source.id,
    kind: 'file',
    locator: relative,
    name: relative,
    field: 'path',
    value: relative,
    tags: ['repository'],
    layer: 'structural',
    checkpoint: false,
  });
}

function containsEdge(file: GraphNode, child: GraphNode, relative: string): GraphEdge {
  return resolution({
    from: file.id,
    to: child.id,
    kind: 'contains',
    strategy: 'syntax',
    confidence: 1,
    status: 'resolved',
    evidence: [relative],
    layer: child.layer ?? 'structural',
    checkpoint: false,
  });
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function repositoryPath(root: string, absolute: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(absolute);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  const relative = path.relative(resolvedRoot, resolved).split(path.sep).join('/');
  return relative && !relative.startsWith('../') ? relative : null;
}

function loadCompilerOptions(root: string): ts.CompilerOptions {
  const fallback: ts.CompilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
  };
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return fallback;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return fallback;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath), undefined, configPath);
  const options = { ...fallback, ...parsed.options, allowJs: true, noEmit: true };
  if (options.paths && !options.baseUrl) options.baseUrl = path.dirname(configPath);
  return options;
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  return [...new Map(edges.map(edge => [edge.id, edge])).values()];
}

function mergeNodes(nodes: GraphNode[]): GraphNode[] {
  const byId = new Map<string, GraphNode>();
  for (const node of nodes) {
    const current = byId.get(node.id);
    if (!current) {
      byId.set(node.id, node);
      continue;
    }
    const preferred = current.layer === 'semantic' ? current : node.layer === 'semantic' ? node : current;
    byId.set(node.id, {
      ...preferred,
      tags: [...new Set([...(current.tags ?? []), ...(node.tags ?? [])])].sort(),
      evidenceIds: [...new Set([...(current.evidenceIds ?? []), ...(node.evidenceIds ?? [])])].sort(),
      checkpoint: Boolean(current.checkpoint || node.checkpoint),
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function mergeEvidence(values: EvidenceRecord[]): EvidenceRecord[] {
  return [...new Map(values.map(item => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

function featureForFile(relative: string): string | null {
  const match = /^(?:src\/)?features\/([^/]+)(?:\/|$)/u.exec(relative);
  return match ? match[1]! : null;
}

function routeFromFile(relative: string): { kind: 'api' | 'route'; id: string; route: string } | null {
  const normalized = relative.replace(/\\/g, '/');
  const match = /^(?:src\/)?app\/(.*?)(?:\/)?(page|route)\.(?:[cm]?[jt]sx?)$/u.exec(normalized);
  if (!match) return null;
  const raw = match[1] ?? '';
  const segments = raw.split('/').filter(segment => segment && !/^\(.+\)$/u.test(segment));
  const route = `/${segments.join('/')}`.replace(/\/$/u, '') || '/';
  const kind = match[2] === 'route' && segments[0] === 'api' ? 'api' : 'route';
  return { kind, id: `${kind}:${route}`, route };
}

function evidenceForFile(relative: string, reason: string): EvidenceRecord {
  return evidenceRecord({ sourceId: `repo:${relative}`, kind: 'repository-evidence', locator: relative, message: reason });
}

async function crossFileTypeScriptGraph(
  root: string,
  sourceTexts: Map<string, string>,
  graphNodes: GraphNode[],
  fileNodes: Map<string, GraphNode>,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; moduleInfos: Map<string, ModuleInfo> }> {
  const options = loadCompilerOptions(root);
  const symbolsByFile = new Map<string, Map<string, GraphNode[]>>();
  for (const node of graphNodes) {
    if (!SYMBOL_KINDS.has(node.kind) || !node.name || !node.sourceId.startsWith('repo:')) continue;
    const file = node.sourceId.slice('repo:'.length);
    const byName = symbolsByFile.get(file) ?? new Map<string, GraphNode[]>();
    const bucket = byName.get(node.name) ?? [];
    bucket.push(node);
    byName.set(node.name, bucket);
    symbolsByFile.set(file, byName);
  }

  const moduleInfos = new Map<string, ModuleInfo>();
  const addedNodes: GraphNode[] = [];
  const addedEdges: GraphEdge[] = [];

  const resolveTargetFile = (fromFile: string, specifier: string): string | null => {
    const resolved = ts.resolveModuleName(specifier, path.join(root, fromFile), options, ts.sys).resolvedModule?.resolvedFileName;
    if (!resolved) return null;
    const relative = repositoryPath(root, resolved);
    if (!relative) return null;
    if (fileNodes.has(relative)) return relative;
    if (relative.endsWith('.d.ts')) {
      const withoutDeclaration = relative.slice(0, -5);
      for (const ext of CODE_EXTENSIONS) if (fileNodes.has(`${withoutDeclaration}${ext}`)) return `${withoutDeclaration}${ext}`;
    }
    return null;
  };

  for (const [relative, text] of sourceTexts) {
    const sourceFile = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, scriptKindFor(relative));
    const imports = new Map<string, ModuleBinding>();
    const reexports = new Map<string, ReexportBinding>();
    const exportAll: string[] = [];
    const importedSpecifiers: string[] = [];
    const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const fromFile = fileNodes.get(relative);

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const module = statement.moduleSpecifier.text;
        importedSpecifiers.push(module);
        const targetFile = resolveTargetFile(relative, module);
        const targetFileNode = targetFile ? fileNodes.get(targetFile) : null;
        if (fromFile && targetFileNode) addedEdges.push(resolution({
          from: fromFile.id,
          to: targetFileNode.id,
          kind: 'imports',
          strategy: 'module-resolution',
          confidence: 1,
          status: 'resolved',
          evidence: [`${relative}:${lineOf(statement)}`],
          layer: 'structural',
          checkpoint: false,
        }));
        const clause = statement.importClause;
        const bindings: Array<{ local: string; imported: string }> = [];
        if (clause?.name) bindings.push({ local: clause.name.text, imported: 'default' });
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) bindings.push({ local: element.name.text, imported: element.propertyName?.text ?? element.name.text });
        } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          bindings.push({ local: clause.namedBindings.name.text, imported: '*' });
        }
        for (const binding of bindings) {
          const bindingNode = observation({
            id: `import:${relative}#${binding.local}@${module}`,
            sourceId: `repo:${relative}`,
            kind: 'import-binding',
            locator: `${relative}:${lineOf(statement)}:import:${binding.local}`,
            name: binding.local,
            field: 'import',
            value: { module, imported: binding.imported, targetFile },
            layer: 'structural',
            checkpoint: false,
          });
          addedNodes.push(bindingNode);
          if (fromFile) addedEdges.push(containsEdge(fromFile, bindingNode, relative));
          imports.set(binding.local, { ...binding, module, targetFile, line: lineOf(statement), bindingNode });
        }
      }

      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const targetFile = resolveTargetFile(relative, statement.moduleSpecifier.text);
        if (!targetFile) continue;
        const targetFileNode = fileNodes.get(targetFile);
        if (fromFile && targetFileNode) addedEdges.push(resolution({
          from: fromFile.id,
          to: targetFileNode.id,
          kind: 'reexports',
          strategy: 'module-resolution',
          confidence: 1,
          status: 'resolved',
          evidence: [`${relative}:${lineOf(statement)}`],
          layer: 'structural',
          checkpoint: false,
        }));
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) reexports.set(element.name.text, { imported: element.propertyName?.text ?? element.name.text, targetFile });
        } else if (!statement.exportClause) {
          exportAll.push(targetFile);
        }
      }
    }
    moduleInfos.set(relative, { sourceFile, imports, reexports, exportAll, importedSpecifiers });
  }

  const resolveExportedSymbol = (file: string, name: string, seen = new Set<string>()): GraphNode | null => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const direct = symbolsByFile.get(file)?.get(name) ?? [];
    if (direct.length === 1) return direct[0]!;
    const info = moduleInfos.get(file);
    const reexport = info?.reexports.get(name);
    if (reexport) {
      const resolved = resolveExportedSymbol(reexport.targetFile, reexport.imported, seen);
      if (resolved) return resolved;
    }
    for (const target of info?.exportAll ?? []) {
      const resolved = resolveExportedSymbol(target, name, new Set(seen));
      if (resolved) return resolved;
    }
    return null;
  };

  for (const [relative, info] of moduleInfos) {
    const fromFile = fileNodes.get(relative);
    for (const binding of info.imports.values()) {
      if (!binding.targetFile || binding.imported === '*') continue;
      const target = resolveExportedSymbol(binding.targetFile, binding.imported);
      if (target) addedEdges.push(resolution({
        from: binding.bindingNode.id,
        to: target.id,
        kind: 'resolves_to',
        strategy: 'module-resolution',
        confidence: 1,
        status: 'resolved',
        evidence: [`${relative}:${binding.line}`],
        layer: 'structural',
        checkpoint: false,
      }));
    }

    const sourceFile = info.sourceFile;
    const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const owners: GraphNode[] = [];
    const ownerFor = (name: string, line: number): GraphNode | null => {
      const candidates = symbolsByFile.get(relative)?.get(name) ?? [];
      return candidates.find(node => node.locator.startsWith(`${relative}:${line}`)) ?? (candidates.length === 1 ? candidates[0]! : null);
    };
    const visit = (node: ts.Node): void => {
      let pushed = false;
      let owner: GraphNode | null = null;
      if (ts.isFunctionDeclaration(node) && node.name) owner = ownerFor(node.name.text, lineOf(node));
      else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) owner = ownerFor(node.name.text, lineOf(node));
      else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) owner = ownerFor(node.name.text, lineOf(node));
      if (owner) { owners.push(owner); pushed = true; }

      if (ts.isCallExpression(node)) {
        let target: GraphNode | null = null;
        if (ts.isIdentifier(node.expression)) {
          const binding = info.imports.get(node.expression.text);
          if (binding?.targetFile && binding.imported !== '*') target = resolveExportedSymbol(binding.targetFile, binding.imported);
        } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
          const binding = info.imports.get(node.expression.expression.text);
          if (binding?.targetFile && binding.imported === '*') target = resolveExportedSymbol(binding.targetFile, node.expression.name.text);
        }
        if (target) {
          const caller = owners.at(-1) ?? fromFile ?? null;
          if (caller && caller.id !== target.id) addedEdges.push(resolution({
            from: caller.id,
            to: target.id,
            kind: 'calls',
            strategy: 'module-resolution',
            confidence: 1,
            status: 'resolved',
            evidence: [`${relative}:${lineOf(node)}`],
            layer: 'structural',
            checkpoint: false,
          }));
        }
      }

      ts.forEachChild(node, visit);
      if (pushed) owners.pop();
    };
    visit(sourceFile);
  }

  return { nodes: addedNodes, edges: dedupeEdges(addedEdges), moduleInfos };
}

function stableNodeShape(node: GraphNode): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name ?? null,
    value: node.value,
    tags: [...new Set(node.tags ?? [])].filter(tag => tag !== 'referenced').sort(),
  };
}

function stableEdgeShape(edge: GraphEdge): Record<string, unknown> {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    strategy: edge.strategy,
    confidence: edge.confidence,
    status: edge.status,
  };
}

export function checkpointProjection(graph: IntelligenceGraph): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = graph.nodes.filter(node => node.layer === 'semantic' && node.checkpoint !== false).sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge => edge.layer === 'semantic' && edge.checkpoint !== false && (!edge.from || ids.has(edge.from)) && (!edge.to || ids.has(edge.to))).sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges };
}

function graphFingerprints(nodes: GraphNode[], edges: GraphEdge[], evidence: EvidenceRecord[]): { topologyFingerprint: string; evidenceFingerprint: string } {
  const semanticNodes = nodes.filter(node => node.layer === 'semantic' && node.checkpoint !== false).sort((a, b) => a.id.localeCompare(b.id));
  const semanticIds = new Set(semanticNodes.map(node => node.id));
  const semanticEdges = edges.filter(edge => edge.layer === 'semantic' && edge.checkpoint !== false && (!edge.from || semanticIds.has(edge.from)) && (!edge.to || semanticIds.has(edge.to))).sort((a, b) => a.id.localeCompare(b.id));
  const topology = JSON.stringify({ nodes: semanticNodes.map(stableNodeShape), edges: semanticEdges.map(stableEdgeShape) });
  const evidenceById = new Map(evidence.map(item => [item.id, item]));
  const evidenceIds = new Set<string>();
  for (const node of semanticNodes) for (const id of node.evidenceIds ?? []) evidenceIds.add(id);
  for (const edge of semanticEdges) for (const id of edge.evidenceIds ?? []) evidenceIds.add(id);
  const evidencePayload = [...evidenceIds].sort().map(id => evidenceById.get(id) ?? { id, unavailable: true });
  return {
    topologyFingerprint: createHash('sha256').update(topology).digest('hex'),
    evidenceFingerprint: createHash('sha256').update(JSON.stringify(evidencePayload)).digest('hex'),
  };
}

function addFrameworkSemantics(input: {
  sourceTexts: Map<string, string>;
  moduleInfos: Map<string, ModuleInfo>;
  fileNodes: Map<string, GraphNode>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: EvidenceRecord[];
}): void {
  const featureByFile = new Map<string, string>();
  const routeByFile = new Map<string, { kind: 'api' | 'route'; id: string; route: string }>();

  for (const relative of input.fileNodes.keys()) {
    const feature = featureForFile(relative);
    if (feature) {
      featureByFile.set(relative, feature);
      const proof = evidenceForFile(relative, `Observed feature owner ${feature} from repository structure`);
      input.evidence.push(proof);
      input.nodes.push(semanticEntity({ id: `feature:${feature}`, sourceId: proof.sourceId, kind: 'feature', locator: relative, name: feature, value: { id: feature }, evidenceIds: [proof.id], tags: ['framework-observed'] }));
    }
    const route = routeFromFile(relative);
    if (route) {
      routeByFile.set(relative, route);
      const proof = evidenceForFile(relative, `Observed ${route.kind} ${route.route} from framework route structure`);
      input.evidence.push(proof);
      input.nodes.push(semanticEntity({ id: route.id, sourceId: proof.sourceId, kind: route.kind, locator: relative, name: route.route, value: { route: route.route }, evidenceIds: [proof.id], tags: ['framework-observed'] }));
    }
  }

  for (const edge of input.edges.filter(edge => edge.kind === 'imports' && edge.status === 'resolved' && edge.from && edge.to)) {
    const fromFile = edge.from.startsWith('file:') ? edge.from.slice(5) : null;
    const toFile = edge.to.startsWith('file:') ? edge.to.slice(5) : null;
    if (!fromFile || !toFile) continue;
    const fromFeature = featureByFile.get(fromFile);
    const toFeature = featureByFile.get(toFile);
    if (fromFeature && toFeature && fromFeature !== toFeature) {
      const proof = evidenceForFile(fromFile, `Feature ${fromFeature} imports feature ${toFeature}`);
      input.evidence.push(proof);
      input.edges.push(semanticRelationship({ from: `feature:${fromFeature}`, to: `feature:${toFeature}`, kind: 'depends-on', evidence: edge.evidence, evidenceIds: [proof.id], strategy: 'module-resolution' }));
    }
    const route = routeByFile.get(fromFile);
    if (route && toFeature) {
      const proof = evidenceForFile(fromFile, `${route.kind} ${route.route} imports feature ${toFeature}`);
      input.evidence.push(proof);
      input.edges.push(semanticRelationship({ from: route.id, to: `feature:${toFeature}`, kind: route.kind === 'api' ? 'uses-feature' : 'composes', evidence: edge.evidence, evidenceIds: [proof.id], strategy: 'module-resolution' }));
    }
  }

  for (const [relative, text] of input.sourceTexts) {
    const info = input.moduleInfos.get(relative);
    const providers = detectProviders(info?.importedSpecifiers ?? [], text);
    if (!providers.length) continue;
    const owners: string[] = [];
    const feature = featureByFile.get(relative);
    const route = routeByFile.get(relative);
    if (feature) owners.push(`feature:${feature}`);
    if (route) owners.push(route.id);
    for (const provider of providers) {
      const proof = evidenceForFile(relative, `${provider.reason}: ${provider.label}`);
      input.evidence.push(proof);
      input.nodes.push(semanticEntity({ id: `provider:${provider.id}`, sourceId: proof.sourceId, kind: 'provider', locator: relative, name: provider.label, value: { provider: provider.id }, evidenceIds: [proof.id], tags: ['provider-observed'] }));
      for (const owner of owners) input.edges.push(semanticRelationship({ from: owner, to: `provider:${provider.id}`, kind: 'integrates-with', evidence: [relative], evidenceIds: [proof.id], strategy: provider.reason }));
    }
  }

  for (const node of input.nodes.filter(node => node.kind === 'mcp-tool' && node.name)) {
    const relative = node.sourceId.startsWith('repo:') ? node.sourceId.slice(5) : node.locator.split(':')[0]!;
    const proof = evidenceForFile(relative, `Observed MCP tool registration ${node.name}`);
    input.evidence.push(proof);
    const mcpId = `mcp:${node.name}`;
    input.nodes.push(semanticEntity({ id: mcpId, sourceId: proof.sourceId, kind: 'mcp', locator: node.locator, name: node.name, value: { tool: node.name }, evidenceIds: [proof.id], tags: ['protocol-observed'] }));
    const feature = featureByFile.get(relative);
    if (feature) input.edges.push(semanticRelationship({ from: mcpId, to: `feature:${feature}`, kind: 'implemented-by', evidence: [node.locator], evidenceIds: [proof.id], strategy: 'protocol-registration' }));
  }
}

function ensureSemanticTargets(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const ids = new Set(nodes.map(node => node.id));
  const additions: GraphNode[] = [];
  for (const edge of edges) {
    if (edge.layer !== 'semantic' || !edge.to || ids.has(edge.to)) continue;
    const separator = edge.to.indexOf(':');
    if (separator <= 0) continue;
    const kind = edge.to.slice(0, separator);
    if (!SEMANTIC_PREFIXES.has(kind)) continue;
    additions.push(semanticEntity({
      id: edge.to,
      sourceId: 'semantic-reference',
      kind,
      locator: edge.to,
      name: edge.to.slice(separator + 1),
      value: { id: edge.to, referenced: true },
      tags: ['referenced'],
      evidenceIds: edge.evidenceIds,
    }));
    ids.add(edge.to);
  }
  return additions;
}

export async function buildRepositoryGraph(input: {
  project: string;
  repository: string;
  revision: string;
  root: string;
  role?: 'A' | 'W' | 'B';
}): Promise<IntelligenceGraph> {
  const createdAt = new Date().toISOString();
  const tracked = await trackedFiles(input.root);
  const eligible = tracked.filter(file => TEXT_EXTENSIONS.has(path.extname(file.path).toLowerCase()));
  const selected = eligible.slice(0, MAX_FILES);
  const warnings: string[] = [];
  if (selected.length < eligible.length) warnings.push(`Graph file limit reached: analyzed ${selected.length} of ${eligible.length} eligible tracked files.`);

  let skippedOversizedFiles = 0;
  let skippedNonRegularFiles = 0;
  let analyzedFiles = 0;
  let nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];
  let evidence: EvidenceRecord[] = [];
  const fileNodes = new Map<string, GraphNode>();
  const sourceTexts = new Map<string, string>();

  for (const trackedFile of selected) {
    const root = path.resolve(input.root);
    const absolute = path.resolve(root, trackedFile.path);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      warnings.push(`Skipped tracked path outside repository root: ${trackedFile.path}`);
      skippedNonRegularFiles += 1;
      continue;
    }
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      warnings.push(`Skipped non-regular tracked file: ${trackedFile.path}`);
      skippedNonRegularFiles += 1;
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      skippedOversizedFiles += 1;
      continue;
    }
    const fileSource: SourceDescriptor = {
      id: `repo:${trackedFile.path}`,
      kind: 'repository-file',
      locator: trackedFile.path,
      revision: input.revision,
      observedAt: createdAt,
      available: true,
    };
    const file = fileNode(fileSource, trackedFile.path);
    fileNodes.set(trackedFile.path, file);
    const text = await fs.readFile(absolute, 'utf8');
    if (CODE_EXTENSIONS.has(path.extname(trackedFile.path).toLowerCase())) sourceTexts.set(trackedFile.path, text);
    const result = analyzeByTechnology({ source: fileSource, text, locatorBase: trackedFile.path });
    nodes.push(file, ...result.observations);
    edges.push(...result.resolutions, ...result.observations.filter(node => node.layer !== 'semantic').map(node => containsEdge(file, node, trackedFile.path)));
    evidence.push(...(result.evidence ?? []));
    analyzedFiles += 1;
  }

  if (skippedOversizedFiles > 0) warnings.push(`Skipped ${skippedOversizedFiles} tracked files larger than ${MAX_FILE_BYTES} bytes.`);
  const repositorySource: SourceDescriptor = {
    id: 'repository',
    kind: 'repository',
    locator: input.repository,
    revision: input.revision,
    observedAt: createdAt,
    available: true,
    ...(warnings.length ? { warnings } : {}),
  };

  const crossFile = await crossFileTypeScriptGraph(input.root, sourceTexts, nodes, fileNodes);
  nodes.push(...crossFile.nodes);
  edges.push(...crossFile.edges);
  addFrameworkSemantics({ sourceTexts, moduleInfos: crossFile.moduleInfos, fileNodes, nodes, edges, evidence });
  nodes.push(...ensureSemanticTargets(nodes, edges));
  nodes = mergeNodes(nodes);
  evidence = mergeEvidence(evidence);
  edges = dedupeEdges(resolveCrossSource(nodes, edges));

  const fingerprint = await sourceFingerprint(input.root);
  const fingerprints = graphFingerprints(nodes, edges, evidence);
  const coverage: GraphCoverage = {
    trackedFiles: tracked.length,
    eligibleFiles: eligible.length,
    analyzedFiles,
    skippedOversizedFiles,
    skippedNonRegularFiles,
  };
  return {
    schemaVersion: 2,
    analyzerVersion: ANALYZER_VERSION,
    graphId: `repo-${input.revision.slice(0, 12)}-${stableHash([fingerprint, ANALYZER_VERSION]).slice(0, 10)}`,
    project: input.project,
    role: input.role ?? 'W',
    createdAt,
    repositoryRevision: input.revision,
    sourceFingerprint: fingerprint,
    topologyFingerprint: fingerprints.topologyFingerprint,
    evidenceFingerprint: fingerprints.evidenceFingerprint,
    sources: [repositorySource],
    evidence,
    nodes,
    edges,
    namingDivergences: deriveNamingDivergences(nodes, edges),
    explicitValueConflicts: [],
    unmatchedNodeIds: deriveUnmatched(nodes, edges),
    unavailableSourceIds: [],
    coverage,
  };
}
