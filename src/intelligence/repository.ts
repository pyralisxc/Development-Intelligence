import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { GraphCoverage, GraphEdge, GraphNode, IntelligenceGraph, SourceDescriptor } from '../types.js';
import { runChecked } from '../util/process.js';
import { stableHash } from '../util/hash.js';
import { analyzeByTechnology } from './analyzers/index.js';
import { observation, resolution } from './model.js';
import { deriveNamingDivergences, deriveUnmatched, resolveCrossSource } from './resolver.js';

export const GRAPH_DIRECTORY = '.development-intelligence';
export const GRAPH_CHECKPOINT_PATH = `${GRAPH_DIRECTORY}/graph.ndjson`;

const MAX_FILE_BYTES = Number(process.env.DEVINT_GRAPH_MAX_FILE_BYTES ?? process.env.DEVINT_PARITY_MAX_FILE_BYTES ?? 1_000_000);
const MAX_FILES = Number(process.env.DEVINT_GRAPH_MAX_FILES ?? process.env.DEVINT_PARITY_MAX_FILES ?? 10_000);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const TEXT_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.json', '.md', '.mdx', '.html', '.htm']);
const SYMBOL_KINDS = new Set(['function', 'method', 'class', 'interface', 'type', 'declaration']);

interface TrackedFile {
  path: string;
  mode: string;
  blob: string;
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
    sourceId: source.id,
    kind: 'file',
    locator: relative,
    name: relative,
    field: 'path',
    value: relative,
    tags: ['repository'],
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
  });
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

async function crossFileTypeScriptGraph(
  root: string,
  sourceTexts: Map<string, string>,
  graphNodes: GraphNode[],
  fileNodes: Map<string, GraphNode>,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
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
    const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const fromFile = fileNodes.get(relative);

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const module = statement.moduleSpecifier.text;
        const targetFile = resolveTargetFile(relative, module);
        const targetFileNode = targetFile ? fileNodes.get(targetFile) : null;
        if (fromFile && targetFileNode) addedEdges.push(resolution({
          from: fromFile.id, to: targetFileNode.id, kind: 'imports', strategy: 'module-resolution', confidence: 1, status: 'resolved', evidence: [`${relative}:${lineOf(statement)}`],
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
            sourceId: `repo:${relative}`, kind: 'import-binding', locator: `${relative}:${lineOf(statement)}:import:${binding.local}`, name: binding.local, field: 'import',
            value: { module, imported: binding.imported, targetFile },
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
          from: fromFile.id, to: targetFileNode.id, kind: 'reexports', strategy: 'module-resolution', confidence: 1, status: 'resolved', evidence: [`${relative}:${lineOf(statement)}`],
        }));
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            reexports.set(element.name.text, { imported: element.propertyName?.text ?? element.name.text, targetFile });
          }
        } else if (!statement.exportClause) {
          exportAll.push(targetFile);
        }
      }
    }
    moduleInfos.set(relative, { sourceFile, imports, reexports, exportAll });
  }

  const resolveExportedSymbol = (file: string, name: string, seen = new Set<string>()): GraphNode | null => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const direct = symbolsByFile.get(file)?.get(name)?.[0];
    if (direct) return direct;
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
        from: binding.bindingNode.id, to: target.id, kind: 'resolves_to', strategy: 'module-resolution', confidence: 1, status: 'resolved', evidence: [`${relative}:${binding.line}`],
      }));
    }

    const sourceFile = info.sourceFile;
    const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const owners: GraphNode[] = [];
    const ownerFor = (name: string, line: number): GraphNode | null => {
      const candidates = symbolsByFile.get(relative)?.get(name) ?? [];
      return candidates.find(node => node.locator.startsWith(`${relative}:${line}`)) ?? candidates[0] ?? null;
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
            from: caller.id, to: target.id, kind: 'calls', strategy: 'module-resolution', confidence: 1, status: 'resolved', evidence: [`${relative}:${lineOf(node)}`],
          }));
        }
      }

      ts.forEachChild(node, visit);
      if (pushed) owners.pop();
    };
    visit(sourceFile);
  }

  return { nodes: addedNodes, edges: dedupeEdges(addedEdges) };
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
  const nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];
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
    edges.push(...result.resolutions, ...result.observations.map(node => containsEdge(file, node, trackedFile.path)));
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
  edges = dedupeEdges(resolveCrossSource(nodes, edges));
  const fingerprint = await sourceFingerprint(input.root);
  const coverage: GraphCoverage = {
    trackedFiles: tracked.length,
    eligibleFiles: eligible.length,
    analyzedFiles,
    skippedOversizedFiles,
    skippedNonRegularFiles,
  };
  return {
    schemaVersion: 1,
    graphId: `repo-${input.revision.slice(0, 12)}-${stableHash([fingerprint]).slice(0, 10)}`,
    project: input.project,
    role: input.role ?? 'W',
    createdAt,
    repositoryRevision: input.revision,
    sourceFingerprint: fingerprint,
    sources: [repositorySource],
    nodes,
    edges,
    namingDivergences: deriveNamingDivergences(nodes, edges),
    explicitValueConflicts: [],
    unmatchedNodeIds: deriveUnmatched(nodes, edges),
    unavailableSourceIds: [],
    coverage,
  };
}
