import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { EvidenceRecord, ExplicitValueConflict, GraphCoverage, GraphCoverageFile, GraphEdge, GraphNode, IntelligenceGraph, SourceDescriptor } from '../types.js';
import type { RepositoryChangedFile } from '../source/git.js';
import { runChecked } from '../util/process.js';
import { stableHash } from '../util/hash.js';
import { analyzeByTechnology, isOperationalConfigPath, supportsSourcePath } from './analyzers/index.js';
import { detectProviders } from './providers.js';
import { evidenceRecord, observation, resolution, semanticEntity, semanticRelationship } from './model.js';
import { deriveNamingDivergences, deriveUnmatched, resolveCrossSource } from './resolver.js';
import { resolveEvidenceSpine } from './spine.js';
import { resolveFrameworkSpine } from './frameworkSpine.js';
import { compilerTypeScriptReferences } from './typescriptCompilerLens.js';

export const GRAPH_DIRECTORY = '.development-intelligence';
export const ANALYZER_VERSION = '2.17.0-compiler-symbol-lens';

const MAX_FILE_BYTES = Number(process.env.DEVINT_GRAPH_MAX_FILE_BYTES ?? process.env.DEVINT_PARITY_MAX_FILE_BYTES ?? 1_000_000);
const MAX_FILES = Number(process.env.DEVINT_GRAPH_MAX_FILES ?? process.env.DEVINT_PARITY_MAX_FILES ?? 10_000);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const POLYGLOT_EXTENSIONS = new Set(['.cs', '.java', '.py', '.go', '.rs']);
const UNITY_SERIALIZED_EXTENSIONS = new Set(['.meta', '.unity', '.prefab', '.asset', '.mat', '.anim', '.controller', '.mixer']);
const UNITY_JSON_EXTENSIONS = new Set(['.asmdef', '.asmref', '.inputactions']);
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

export function isRepositoryAnalysisIgnoredPath(relative: string): boolean {
  const normalized = relative.replace(/\\/gu, '/').replace(/^\.\//u, '');
  return normalized === GRAPH_DIRECTORY
    || normalized.startsWith(`${GRAPH_DIRECTORY}/`)
    || /(^|\/)node_modules(?:\/|$)/u.test(normalized);
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
    if (isRepositoryAnalysisIgnoredPath(filePath)) continue;
    output.push({ path: filePath, mode, blob });
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

async function trackedSymlinkTarget(root: string, relative: string): Promise<string> {
  const absolute = path.join(root, relative);
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) return await fs.readlink(absolute);
  // Git for Windows may materialize mode-120000 entries as ordinary files when
  // native symlink creation is unavailable. The file payload is the link target;
  // reading it does not follow or expose the referenced path.
  return await fs.readFile(absolute, 'utf8');
}

export async function sourceFingerprint(root: string): Promise<string> {
  const tracked = await trackedFiles(root);
  if (tracked.some(file => file.path.includes('\n'))) throw new Error('Tracked filenames containing newlines are not supported by graph sealing');
  const regular = tracked.filter(file => file.mode !== '120000' && file.mode !== '160000');
  const regularHashes = regular.length
    ? (await runChecked('git', ['-C', root, 'hash-object', '--stdin-paths'], { input: `${regular.map(file => file.path).join('\n')}\n` })).stdout.trim().split(/\r?\n/u)
    : [];
  if (regularHashes.length !== regular.length) throw new Error('Unable to fingerprint every tracked regular source file');
  const regularByPath = new Map(regular.map((file, index) => [file.path, regularHashes[index]!]));
  const hash = createHash('sha256');
  for (const file of tracked) {
    let contentHash: string;
    if (file.mode === '120000') {
      const target = await trackedSymlinkTarget(root, file.path);
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
    tags: ['repository', ...(isOperationalConfigPath(relative) ? ['operational'] : [])],
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
  const byId = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const current = byId.get(edge.id);
    if (!current) {
      byId.set(edge.id, edge);
      continue;
    }
    byId.set(edge.id, {
      ...current,
      evidence: [...new Set([...(current.evidence ?? []), ...(edge.evidence ?? [])])].sort(),
      evidenceIds: [...new Set([...(current.evidenceIds ?? []), ...(edge.evidenceIds ?? [])])].sort(),
      checkpoint: Boolean(current.checkpoint || edge.checkpoint),
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function equivalentValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function semanticConflicts(left: GraphNode, right: GraphNode): ExplicitValueConflict[] {
  if (left.layer !== 'semantic' || right.layer !== 'semantic') return [];
  const fields: Array<[string, unknown, unknown]> = [
    ['kind', left.kind, right.kind],
    ['name', left.name ?? null, right.name ?? null],
    ['value', left.value, right.value],
  ];
  return fields
    .filter(([, a, b]) => !equivalentValue(a, b))
    .map(([key, leftValue, rightValue]) => ({
      entityId: left.id,
      leftSourceId: left.sourceId,
      rightSourceId: right.sourceId,
      key,
      leftValue,
      rightValue,
    }));
}

function mergeNodes(nodes: GraphNode[]): { nodes: GraphNode[]; conflicts: ExplicitValueConflict[] } {
  const byId = new Map<string, GraphNode>();
  const conflicts: ExplicitValueConflict[] = [];
  for (const node of nodes) {
    const current = byId.get(node.id);
    if (!current) {
      byId.set(node.id, node);
      continue;
    }
    const discovered = semanticConflicts(current, node);
    conflicts.push(...discovered);
    let preferred: GraphNode;
    if (current.layer === 'semantic' && node.layer === 'semantic') {
      preferred = [current, node].sort((a, b) => `${a.sourceId}\0${a.locator}`.localeCompare(`${b.sourceId}\0${b.locator}`))[0]!;
    } else {
      preferred = current.layer === 'semantic' ? current : node.layer === 'semantic' ? node : current;
    }
    const conflicted = discovered.length > 0 || current.tags?.includes('conflicted') || node.tags?.includes('conflicted');
    byId.set(node.id, {
      ...preferred,
      tags: [...new Set([...(current.tags ?? []), ...(node.tags ?? []), ...(conflicted ? ['conflicted'] : [])])].sort(),
      evidenceIds: [...new Set([...(current.evidenceIds ?? []), ...(node.evidenceIds ?? [])])].sort(),
      checkpoint: Boolean(current.checkpoint || node.checkpoint),
    });
  }
  const uniqueConflicts = [...new Map(conflicts.map(item => [JSON.stringify(item), item])).values()];
  return { nodes: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), conflicts: uniqueConflicts };
}

function mergeEvidence(values: EvidenceRecord[]): EvidenceRecord[] {
  return [...new Map(values.map(item => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

interface UnityAssetGuidValue {
  guid: string;
  assetPath: string;
}

interface UnityGuidReferenceValue {
  from: string;
  relationship: string;
  guid: string;
  fileId: string;
  type?: string;
}

function unityAssetGuid(value: unknown): value is UnityAssetGuidValue {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.guid === 'string' && /^[0-9a-f]{32}$/u.test(candidate.guid) && typeof candidate.assetPath === 'string';
}

function unityGuidReference(value: unknown): value is UnityGuidReferenceValue {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.from === 'string'
    && typeof candidate.relationship === 'string'
    && typeof candidate.guid === 'string'
    && /^[0-9a-f]{32}$/u.test(candidate.guid)
    && typeof candidate.fileId === 'string';
}

function resolveUnityGraph(input: {
  revision: string;
  createdAt: string;
  trackedPaths: Set<string>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: EvidenceRecord[];
  fileNodes: Map<string, GraphNode>;
}): void {
  const guidRecords = input.evidence.filter(record => record.kind === 'unity-asset-guid' && unityAssetGuid(record.value));
  const guidTargets = new Map<string, Array<{ record: EvidenceRecord; assetPath: string; node: GraphNode | null }>>();

  for (const record of guidRecords) {
    const value = record.value as UnityAssetGuidValue;
    let asset = input.fileNodes.get(value.assetPath) ?? null;
    if (!asset && input.trackedPaths.has(value.assetPath)) {
      asset = fileNode({
        id: `repo:${value.assetPath}`,
        kind: 'repository-file',
        locator: value.assetPath,
        revision: input.revision,
        observedAt: input.createdAt,
        available: true,
      }, value.assetPath);
      input.fileNodes.set(value.assetPath, asset);
      input.nodes.push(asset);
    }
    const targets = guidTargets.get(value.guid) ?? [];
    targets.push({ record, assetPath: value.assetPath, node: asset });
    guidTargets.set(value.guid, targets);

    const meta = input.fileNodes.get(`${value.assetPath}.meta`);
    if (meta && asset) input.edges.push(resolution({
      from: meta.id,
      to: asset.id,
      kind: 'describes',
      strategy: 'unity-meta-companion',
      confidence: 1,
      status: 'resolved',
      evidence: [record.locator],
      evidenceIds: [record.id],
      layer: 'structural',
      checkpoint: false,
    }));
  }

  for (const record of input.evidence) {
    if (record.kind !== 'unity-guid-reference' || !unityGuidReference(record.value)) continue;
    const reference = record.value;
    const targets = (guidTargets.get(reference.guid) ?? []).filter(target => target.node);
    const target = targets.length === 1 ? targets[0]! : null;
    input.edges.push(resolution({
      from: reference.from,
      to: target?.node?.id ?? null,
      kind: reference.relationship,
      strategy: 'unity-guid',
      confidence: target ? 1 : null,
      status: target ? 'resolved' : 'unresolved',
      evidence: [
        `${record.locator}:${record.field ?? 'reference'}:guid=${reference.guid}:fileID=${reference.fileId}`,
        ...(targets.length > 1 ? [`ambiguous GUID has ${targets.length} tracked targets`] : targets.length === 0 ? ['GUID target unavailable in tracked source'] : []),
      ],
      evidenceIds: [record.id, ...(target ? [target.record.id] : [])],
      layer: 'structural',
      checkpoint: false,
    }));
  }
}

interface PolyglotSymbolValue {
  language: 'csharp' | 'java' | 'python' | 'go' | 'rust';
  qualifiedName?: string;
  signature?: string;
  baseTypes?: string[];
}

interface CSharpReferenceValue {
  language: 'csharp';
  referenceKind: 'call' | 'constructor';
  targetName: string;
  qualifier?: string | null;
  arity?: number | null;
  ownerQualifiedName?: string | null;
}

interface PolyglotImportValue {
  language: 'csharp' | 'java' | 'python' | 'go' | 'rust';
  module: string;
  imported: string;
  local: string;
  mode: 'module' | 'namespace' | 'symbol' | 'static';
  relative?: boolean;
}

function polyglotSymbolValue(value: unknown): value is PolyglotSymbolValue {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['csharp', 'java', 'python', 'go', 'rust'].includes(String(candidate.language))
    && (candidate.qualifiedName === undefined || typeof candidate.qualifiedName === 'string');
}

function csharpReferenceValue(value: unknown): value is CSharpReferenceValue {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.language === 'csharp'
    && ['call', 'constructor'].includes(String(candidate.referenceKind))
    && typeof candidate.targetName === 'string';
}

function polyglotImportValue(value: unknown): value is PolyglotImportValue {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['csharp', 'java', 'python', 'go', 'rust'].includes(String(candidate.language))
    && typeof candidate.module === 'string'
    && typeof candidate.imported === 'string'
    && typeof candidate.local === 'string'
    && ['module', 'namespace', 'symbol', 'static'].includes(String(candidate.mode));
}

function pythonModuleAliases(file: string): string[] {
  const withoutExtension = file.replace(/\.py$/u, '');
  const parts = withoutExtension.split('/');
  if (parts.at(-1) === '__init__') parts.pop();
  const aliases: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const alias = parts.slice(index).join('.');
    if (alias) aliases.push(alias);
  }
  return aliases;
}

function goModuleAliases(file: string): string[] {
  if (!file.endsWith('.go')) return [];
  const parts = file.split('/').slice(0, -1).filter(Boolean);
  const aliases: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const alias = parts.slice(index).join('/');
    if (alias) aliases.push(alias);
  }
  return aliases;
}

function rustModuleAliases(file: string): string[] {
  if (!file.endsWith('.rs')) return [];
  const parts = file.replace(/\.rs$/u, '').split('/').filter(Boolean);
  const srcIndex = parts.lastIndexOf('src');
  let moduleParts = srcIndex >= 0 ? parts.slice(srcIndex + 1) : parts;
  const leaf = moduleParts.at(-1);
  if (leaf === 'lib' || leaf === 'main' || leaf === 'mod') moduleParts = moduleParts.slice(0, -1);
  const aliases: string[] = [];
  for (let index = 0; index < moduleParts.length; index += 1) {
    const alias = moduleParts.slice(index).join('::');
    if (alias) aliases.push(alias);
  }
  return aliases;
}

function normalizeRustModule(module: string): string {
  return module
    .replace(/^::/u, '')
    .replace(/^(?:crate|self)::/u, '')
    .replace(/^(?:super::)+/u, '');
}

function relativePythonModule(fromFile: string, module: string): string | null {
  const dots = /^\.+/u.exec(module)?.[0].length ?? 0;
  if (!dots) return module;
  const suffix = module.slice(dots);
  const base = fromFile.replace(/\.py$/u, '').split('/');
  if (base.at(-1) === '__init__') base.pop();
  else base.pop();
  const keep = base.length - Math.max(0, dots - 1);
  if (keep < 0) return null;
  return [...base.slice(0, keep), ...suffix.split('.').filter(Boolean)].join('.');
}

function resolvePolyglotModules(input: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  fileNodes: Map<string, GraphNode>;
}): void {
  const moduleFiles = new Map<string, Set<string>>();
  const symbolsByQualifiedName = new Map<string, GraphNode[]>();
  const symbolsByFile = new Map<string, Map<string, GraphNode[]>>();
  const moduleNodes = new Map<string, GraphNode>();
  const declarationNodes: GraphNode[] = [];

  const addModuleFile = (language: string, module: string, file: string): void => {
    const key = `${language}:${module}`;
    const files = moduleFiles.get(key) ?? new Set<string>();
    files.add(file);
    moduleFiles.set(key, files);
  };

  for (const node of input.nodes) {
    if (!node.sourceId.startsWith('repo:') || !polyglotSymbolValue(node.value)) continue;
    const file = node.sourceId.slice('repo:'.length);
    const value = node.value;
    if ((node.kind === 'namespace' || node.kind === 'package') && value.qualifiedName) {
      addModuleFile(value.language, value.qualifiedName, file);
      declarationNodes.push(node);
    }
    if (node.name && value.qualifiedName && !['namespace', 'package', 'import-binding'].includes(node.kind)) {
      const qualifiedKey = `${value.language}:${value.qualifiedName}`;
      const qualified = symbolsByQualifiedName.get(qualifiedKey) ?? [];
      qualified.push(node);
      symbolsByQualifiedName.set(qualifiedKey, qualified);
      const byName = symbolsByFile.get(file) ?? new Map<string, GraphNode[]>();
      const named = byName.get(node.name) ?? [];
      named.push(node);
      byName.set(node.name, named);
      symbolsByFile.set(file, byName);
    }
  }

  for (const file of input.fileNodes.keys()) {
    if (!file.endsWith('.py')) continue;
    for (const alias of pythonModuleAliases(file)) addModuleFile('python', alias, file);
  }
  for (const file of input.fileNodes.keys()) {
    if (!file.endsWith('.go')) continue;
    for (const alias of goModuleAliases(file)) addModuleFile('go', alias, file);
  }
  for (const file of input.fileNodes.keys()) {
    if (!file.endsWith('.rs')) continue;
    for (const alias of rustModuleAliases(file)) addModuleFile('rust', alias, file);
  }

  const moduleNode = (language: string, module: string): GraphNode => {
    const key = `${language}:${module}`;
    const existing = moduleNodes.get(key);
    if (existing) return existing;
    const localFiles = [...(moduleFiles.get(key) ?? [])].sort();
    const created = observation({
      id: `module:${key}`,
      sourceId: 'repository',
      kind: 'module',
      locator: `${language}:${module}`,
      name: module,
      field: 'module',
      value: { language, module, localSource: localFiles.length > 0 },
      tags: [language, 'module', ...(localFiles.length ? ['local-source'] : ['source-unavailable'])],
      layer: 'structural',
      checkpoint: false,
    });
    moduleNodes.set(key, created);
    input.nodes.push(created);
    for (const file of localFiles) {
      const target = input.fileNodes.get(file);
      if (!target) continue;
      input.edges.push(resolution({
        from: created.id,
        to: target.id,
        kind: 'implemented-by',
        strategy: 'module-declaration',
        confidence: 1,
        status: 'resolved',
        evidence: [file],
        layer: 'structural',
        checkpoint: false,
      }));
    }
    return created;
  };

  for (const declaration of declarationNodes) {
    const value = declaration.value as PolyglotSymbolValue;
    if (!value.qualifiedName) continue;
    const module = moduleNode(value.language, value.qualifiedName);
    const file = input.fileNodes.get(declaration.sourceId.slice('repo:'.length));
    if (!file) continue;
    input.edges.push(resolution({
      from: file.id,
      to: module.id,
      kind: 'declares-module',
      strategy: 'syntax',
      confidence: 1,
      status: 'resolved',
      evidence: [declaration.locator],
      layer: 'structural',
      checkpoint: false,
    }));
  }

  for (const binding of input.nodes.filter(node => node.kind === 'import-binding' && polyglotImportValue(node.value))) {
    const value = binding.value as PolyglotImportValue;
    const fromFile = binding.sourceId.startsWith('repo:') ? binding.sourceId.slice('repo:'.length) : null;
    const from = fromFile ? input.fileNodes.get(fromFile) : null;
    if (!from || !fromFile) continue;

    let moduleName = value.module;
    let targetFiles: string[] = [];
    let exactCandidates: GraphNode[] = [];

    if (value.language === 'python') {
      const resolvedModule = value.relative ? relativePythonModule(fromFile, value.module) : value.module;
      if (resolvedModule) {
        moduleName = resolvedModule;
        targetFiles = [...(moduleFiles.get(`python:${resolvedModule}`) ?? [])].sort();
      }
      if (value.imported !== '*') {
        exactCandidates = targetFiles.flatMap(file => symbolsByFile.get(file)?.get(value.imported) ?? []);
      }
    } else if (value.language === 'java') {
      if (value.mode === 'static') {
        const member = symbolsByQualifiedName.get(`java:${value.module}.${value.imported}`) ?? [];
        const type = symbolsByQualifiedName.get(`java:${value.module}`) ?? [];
        exactCandidates = member.length ? member : type;
        moduleName = value.module.split('.').slice(0, -1).join('.') || value.module;
      } else if (value.imported !== '*') {
        exactCandidates = symbolsByQualifiedName.get(`java:${value.module}.${value.imported}`) ?? [];
      }
      targetFiles = [...(moduleFiles.get(`java:${moduleName}`) ?? [])].sort();
    } else if (value.language === 'go') {
      const parts = value.module.split('/').filter(Boolean);
      for (let index = 0; index < Math.max(0, parts.length - 1); index += 1) {
        const alias = parts.slice(index).join('/');
        const localFiles = [...(moduleFiles.get(`go:${alias}`) ?? [])].sort();
        if (!localFiles.length) continue;
        moduleName = alias;
        targetFiles = localFiles;
        break;
      }
    } else if (value.language === 'rust') {
      moduleName = normalizeRustModule(value.module);
      targetFiles = [...(moduleFiles.get(`rust:${moduleName}`) ?? [])].sort();
      if (value.imported !== '*' && targetFiles.length) {
        exactCandidates = targetFiles.flatMap(file => symbolsByFile.get(file)?.get(value.imported) ?? []);
      }
    } else {
      if (value.mode === 'symbol' || value.mode === 'static') {
        exactCandidates = symbolsByQualifiedName.get(`csharp:${value.module}`) ?? [];
        if (exactCandidates.length === 1) {
          const qualified = (exactCandidates[0]!.value as PolyglotSymbolValue).qualifiedName!;
          moduleName = qualified.split('.').slice(0, -1).join('.') || value.module;
        }
      }
      targetFiles = [...(moduleFiles.get(`csharp:${moduleName}`) ?? [])].sort();
    }

    const module = moduleNode(value.language, moduleName);
    for (const [source, kind] of [[from.id, 'imports'], [binding.id, 'targets-module']] as const) input.edges.push(resolution({
      from: source,
      to: module.id,
      kind,
      strategy: 'syntax',
      confidence: 1,
      status: 'resolved',
      evidence: [binding.locator],
      layer: 'structural',
      checkpoint: false,
    }));

    const directTargetFiles = exactCandidates.length === 1 && exactCandidates[0]!.sourceId.startsWith('repo:')
      ? [exactCandidates[0]!.sourceId.slice('repo:'.length)]
      : value.imported === '*' && targetFiles.length === 1
        ? targetFiles
        : [];
    for (const file of directTargetFiles) {
      const target = input.fileNodes.get(file);
      if (!target || target.id === from.id) continue;
      input.edges.push(resolution({
        from: from.id,
        to: target.id,
        kind: 'imports-file',
        strategy: 'module-resolution',
        confidence: 1,
        status: 'resolved',
        evidence: [binding.locator],
        layer: 'structural',
        checkpoint: false,
      }));
    }

    if (exactCandidates.length === 1) input.edges.push(resolution({
      from: binding.id,
      to: exactCandidates[0]!.id,
      kind: 'resolves_to',
      strategy: 'module-resolution',
      confidence: 1,
      status: 'resolved',
      evidence: [binding.locator],
      layer: 'structural',
      checkpoint: false,
    }));
    else if (exactCandidates.length > 1 || (targetFiles.length > 0 && value.imported !== '*')) input.edges.push(resolution({
      from: binding.id,
      to: null,
      kind: 'resolves_to',
      strategy: 'module-resolution',
      confidence: null,
      status: 'unresolved',
      evidence: [binding.locator, exactCandidates.length > 1 ? `ambiguous import has ${exactCandidates.length} declarations` : 'imported symbol is unavailable in resolved local module'],
      layer: 'structural',
      checkpoint: false,
    }));
  }
}

function resolveCSharpReferences(input: {
  nodes: GraphNode[];
  edges: GraphEdge[];
}): void {
  const typesByShort = new Map<string, GraphNode[]>();
  const typesByQualified = new Map<string, GraphNode[]>();
  const membersByOwner = new Map<string, GraphNode[]>();
  const namespaceImportsByFile = new Map<string, string[]>();
  const aliasesByFile = new Map<string, Map<string, GraphNode>>();

  for (const node of input.nodes) {
    if (!node.sourceId.startsWith('repo:') || !polyglotSymbolValue(node.value) || node.value.language !== 'csharp') continue;
    const value = node.value as PolyglotSymbolValue;
    if (!value.qualifiedName) continue;

    if (node.name && ['class', 'interface', 'struct', 'record'].includes(node.kind)) {
      const short = typesByShort.get(node.name) ?? [];
      short.push(node);
      typesByShort.set(node.name, short);

      const exact = typesByQualified.get(value.qualifiedName) ?? [];
      exact.push(node);
      typesByQualified.set(value.qualifiedName, exact);
    }

    if (['method', 'constructor', 'property', 'field'].includes(node.kind)) {
      const owner = value.qualifiedName.split('.').slice(0, -1).join('.');
      const members = membersByOwner.get(owner) ?? [];
      members.push(node);
      membersByOwner.set(owner, members);
    }
  }

  for (const binding of input.nodes.filter(node => node.kind === 'import-binding' && polyglotImportValue(node.value))) {
    const value = binding.value as PolyglotImportValue;
    if (value.language !== 'csharp' || !binding.sourceId.startsWith('repo:')) continue;
    const file = binding.sourceId.slice('repo:'.length);

    if (value.mode === 'namespace') {
      const namespaces = namespaceImportsByFile.get(file) ?? [];
      namespaces.push(value.module);
      namespaceImportsByFile.set(file, [...new Set(namespaces)].sort());
    } else if (value.mode === 'symbol') {
      const resolved = input.edges.find(edge => edge.from === binding.id && edge.kind === 'resolves_to' && edge.status === 'resolved' && edge.to);
      const target = resolved?.to ? input.nodes.find(node => node.id === resolved.to) : null;
      if (target) {
        const aliases = aliasesByFile.get(file) ?? new Map<string, GraphNode>();
        aliases.set(value.local, target);
        aliasesByFile.set(file, aliases);
      }
    }
  }

  const normalizeType = (raw: string): string => raw.replace(/^global::/u, '').replace(/<.*>$/u, '').trim();

  const typeCandidates = (file: string, raw: string, ownerQualifiedName?: string | null): GraphNode[] => {
    const normalized = normalizeType(raw);

    const alias = aliasesByFile.get(file)?.get(normalized);
    if (alias) return [alias];

    const exact = typesByQualified.get(normalized) ?? [];
    if (exact.length) return exact;
    if (normalized.includes('.')) return [];

    const ownerType = ownerQualifiedName?.split('.').slice(0, -1).join('.') ?? '';
    const ownerNamespace = ownerType ? ownerType.split('.').slice(0, -1).join('.') : '';
    const local = ownerNamespace ? typesByQualified.get(`${ownerNamespace}.${normalized}`) ?? [] : [];
    if (local.length) return local;

    const imported = (namespaceImportsByFile.get(file) ?? [])
      .flatMap(namespace => typesByQualified.get(`${namespace}.${normalized}`) ?? []);
    if (imported.length) return imported;

    return typesByShort.get(normalized) ?? [];
  };

  const arityOf = (node: GraphNode): number | null => {
    const value = node.value as PolyglotSymbolValue;
    if (!value.signature) return null;
    const body = /^\((.*)\)$/u.exec(value.signature)?.[1] ?? '';
    return body ? body.split(',').length : 0;
  };

  for (const type of input.nodes.filter(node =>
    node.sourceId.startsWith('repo:')
    && ['class', 'struct', 'record'].includes(node.kind)
    && polyglotSymbolValue(node.value)
    && node.value.language === 'csharp'
  )) {
    const value = type.value as PolyglotSymbolValue;
    const file = type.sourceId.slice('repo:'.length);

    for (const base of value.baseTypes ?? []) {
      const candidates = typeCandidates(file, base, value.qualifiedName)
        .filter(candidate => candidate.kind === 'interface');

      if (candidates.length === 1) {
        input.edges.push(resolution({
          from: candidates[0]!.id,
          to: type.id,
          kind: 'implemented-by',
          strategy: 'csharp-base-type',
          confidence: 1,
          status: 'resolved',
          evidence: [type.locator, `base type ${base}`],
          layer: 'structural',
          checkpoint: false,
        }));
      }
    }
  }

  for (const reference of input.nodes.filter(node =>
    ['call-reference', 'constructor-reference'].includes(node.kind)
    && csharpReferenceValue(node.value)
  )) {
    if (!reference.sourceId.startsWith('repo:')) continue;

    const file = reference.sourceId.slice('repo:'.length);
    const value = reference.value as CSharpReferenceValue;
    const owner = input.edges.find(edge =>
      edge.to === reference.id
      && edge.kind === 'invokes'
      && edge.status === 'resolved'
      && edge.from
    )?.from ?? null;

    let candidates: GraphNode[] = [];

    if (value.referenceKind === 'constructor') {
      const types = typeCandidates(file, value.targetName, value.ownerQualifiedName);
      if (types.length === 1) {
        const typeValue = types[0]!.value as PolyglotSymbolValue;
        const constructors = (membersByOwner.get(typeValue.qualifiedName ?? '') ?? [])
          .filter(member => member.kind === 'constructor');
        const arityMatched = value.arity == null
          ? constructors
          : constructors.filter(member => arityOf(member) === value.arity);

        candidates = arityMatched.length
          ? arityMatched
          : constructors.length
            ? constructors
            : [types[0]!];
      }
    } else if (value.qualifier !== 'base') {
      const ownerType = value.ownerQualifiedName?.split('.').slice(0, -1).join('.') ?? null;
      const qualifier = value.qualifier && value.qualifier !== 'this' ? value.qualifier : null;
      const types = qualifier
        ? typeCandidates(file, qualifier, value.ownerQualifiedName)
        : ownerType
          ? typesByQualified.get(ownerType) ?? []
          : [];

      if (types.length === 1) {
        const typeValue = types[0]!.value as PolyglotSymbolValue;
        const members = (membersByOwner.get(typeValue.qualifiedName ?? '') ?? [])
          .filter(member => member.kind === 'method' && member.name === value.targetName);

        candidates = value.arity == null
          ? members
          : members.filter(member => arityOf(member) === value.arity);
      }
    }

    if (candidates.length === 1) {
      input.edges.push(resolution({
        from: reference.id,
        to: candidates[0]!.id,
        kind: 'resolves_to',
        strategy: 'csharp-static-binding',
        confidence: 1,
        status: 'resolved',
        evidence: [reference.locator],
        layer: 'structural',
        checkpoint: false,
      }));

      if (owner && owner !== candidates[0]!.id) {
        input.edges.push(resolution({
          from: owner,
          to: candidates[0]!.id,
          kind: value.referenceKind === 'constructor' ? 'constructs' : 'calls',
          strategy: 'csharp-static-binding',
          confidence: 1,
          status: 'resolved',
          evidence: [reference.locator],
          layer: 'structural',
          checkpoint: false,
        }));
      }
    } else if (candidates.length > 1) {
      input.edges.push(resolution({
        from: reference.id,
        to: null,
        kind: 'resolves_to',
        strategy: 'csharp-static-binding',
        confidence: null,
        status: 'unresolved',
        evidence: [reference.locator, `ambiguous C# reference has ${candidates.length} matching declarations`],
        layer: 'structural',
        checkpoint: false,
      }));
    }
  }
}

function resolveUnityReverseUsage(input: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  fileNodes: Map<string, GraphNode>;
}): void {
  const additions: GraphEdge[] = [];

  for (const edge of input.edges) {
    if (edge.kind !== 'uses-script' || edge.status !== 'resolved' || !edge.from || !edge.to || !edge.to.startsWith('file:')) continue;

    const scriptPath = edge.to.slice('file:'.length);
    const source = input.nodes.find(node => node.id === edge.from);
    const assetPath = source?.sourceId.startsWith('repo:')
      ? source.sourceId.slice('repo:'.length)
      : null;

    const assetFile = assetPath ? input.fileNodes.get(assetPath) : null;
    const scriptFile = input.fileNodes.get(scriptPath);
    if (!assetFile || !scriptFile || assetFile.id === scriptFile.id) continue;

    additions.push(resolution({
      from: scriptFile.id,
      to: assetFile.id,
      kind: 'used-by-unity-asset',
      strategy: 'unity-guid-reverse',
      confidence: 1,
      status: 'resolved',
      evidence: edge.evidence,
      evidenceIds: edge.evidenceIds ?? [],
      layer: 'structural',
      checkpoint: false,
    }));

    const stem = path.basename(scriptPath, path.extname(scriptPath));
    const primaryTypes = input.nodes.filter(node =>
      node.sourceId === `repo:${scriptPath}`
      && node.kind === 'class'
      && node.name === stem
    );

    if (primaryTypes.length === 1) {
      additions.push(resolution({
        from: primaryTypes[0]!.id,
        to: assetFile.id,
        kind: 'used-by-unity-asset',
        strategy: 'unity-guid-reverse',
        confidence: 1,
        status: 'resolved',
        evidence: edge.evidence,
        evidenceIds: edge.evidenceIds ?? [],
        layer: 'structural',
        checkpoint: false,
      }));
    }
  }

  input.edges.push(...additions);
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
  graphEdges: GraphEdge[],
  fileNodes: Map<string, GraphNode>,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; moduleInfos: Map<string, ModuleInfo> }> {
  const options = loadCompilerOptions(root);
  const symbolsByFile = new Map<string, Map<string, GraphNode[]>>();
  const graphNodeById = new Map(graphNodes.map(node => [node.id, node]));
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

    const visitDynamicImports = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
        const module = node.arguments[0]!.text;
        importedSpecifiers.push(module);
        const targetFile = resolveTargetFile(relative, module);
        const targetFileNode = targetFile ? fileNodes.get(targetFile) : null;
        if (fromFile && targetFileNode) addedEdges.push(resolution({
          from: fromFile.id,
          to: targetFileNode.id,
          kind: 'imports',
          strategy: 'dynamic-module-resolution',
          confidence: 1,
          status: 'resolved',
          evidence: [relative + ':' + lineOf(node)],
          layer: 'structural',
          checkpoint: false,
        }));
      }
      ts.forEachChild(node, visitDynamicImports);
    };
    visitDynamicImports(sourceFile);
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

  const bindingNameContains = (name: ts.BindingName, value: string): boolean => ts.isIdentifier(name)
    ? name.text === value
    : name.elements.some(element => ts.isBindingElement(element) && bindingNameContains(element.name, value));
  const scopeDeclares = (scope: ts.Node, value: string): boolean => {
    if (ts.isFunctionLike(scope) && (scope.parameters.some(parameter => bindingNameContains(parameter.name, value))
      || (ts.isFunctionExpression(scope) && scope.name?.text === value))) return true;
    if (ts.isCatchClause(scope) && scope.variableDeclaration && bindingNameContains(scope.variableDeclaration.name, value)) return true;
    if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope))) {
      const initializer = scope.initializer;
      if (initializer && ts.isVariableDeclarationList(initializer)
        && initializer.declarations.some(declaration => bindingNameContains(declaration.name, value))) return true;
    }
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isCaseBlock(scope) && !ts.isModuleBlock(scope)) return false;
    const statements: readonly ts.Statement[] = ts.isCaseBlock(scope)
      ? scope.clauses.flatMap(clause => [...clause.statements])
      : scope.statements;
    return statements.some(statement => {
      if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(declaration => bindingNameContains(declaration.name, value));
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === value) return true;
      return false;
    });
  };
  const functionHasNestedVar = (scope: ts.SignatureDeclaration, value: string): boolean => {
    let found = false;
    const inspect = (node: ts.Node): void => {
      if (found || (ts.isFunctionLike(node) && node !== scope)) return;
      if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0
        && node.declarations.some(declaration => bindingNameContains(declaration.name, value))) found = true;
      ts.forEachChild(node, inspect);
    };
    if ('body' in scope && scope.body) inspect(scope.body);
    return found;
  };
  const isShadowed = (reference: ts.Identifier, value: string, stopAt: ts.Node): boolean => {
    let current: ts.Node | undefined = reference.parent;
    while (current && current !== stopAt) {
      if (scopeDeclares(current, value)) return true;
      if (ts.isFunctionLike(current) && functionHasNestedVar(current, value)) return true;
      current = current.parent;
    }
    return false;
  };

  const importedCallTarget = (info: ModuleInfo, expression: ts.LeftHandSideExpression): GraphNode | null => {
    if (ts.isIdentifier(expression)) {
      const binding = info.imports.get(expression.text);
      return binding?.targetFile && binding.imported !== '*' && !isShadowed(expression, expression.text, info.sourceFile)
        ? resolveExportedSymbol(binding.targetFile, binding.imported)
        : null;
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const binding = info.imports.get(expression.expression.text);
      return binding?.targetFile && binding.imported === '*' && !isShadowed(expression.expression, expression.expression.text, info.sourceFile)
        ? resolveExportedSymbol(binding.targetFile, expression.name.text)
        : null;
    }
    return null;
  };

  const staticPropertyName = (property: ts.ObjectLiteralElementLike): string | null => {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
    if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) return null;
    return ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name)
      ? property.name.text
      : null;
  };
  const spreadMayDefine = (expression: ts.Expression, name: string): boolean => {
    if (ts.isParenthesizedExpression(expression)) return spreadMayDefine(expression.expression, name);
    if (ts.isConditionalExpression(expression)) return spreadMayDefine(expression.whenTrue, name) || spreadMayDefine(expression.whenFalse, name);
    if (!ts.isObjectLiteralExpression(expression)) return true;
    return expression.properties.some(property => ts.isSpreadAssignment(property)
      ? spreadMayDefine(property.expression, name)
      : staticPropertyName(property) === name || staticPropertyName(property) === null);
  };
  const effectiveObjectProperties = (object: ts.ObjectLiteralExpression): Array<{ property: ts.ObjectLiteralElementLike; name: string; uncertain: boolean }> => {
    const result: Array<{ property: ts.ObjectLiteralElementLike; name: string; uncertain: boolean }> = [];
    for (let index = 0; index < object.properties.length; index += 1) {
      const property = object.properties[index]!;
      const name = staticPropertyName(property);
      if (!name) continue;
      const later = object.properties.slice(index + 1);
      if (later.some(candidate => staticPropertyName(candidate) === name)) continue;
      result.push({
        property,
        name,
        uncertain: later.some(candidate => ts.isSpreadAssignment(candidate)
          ? spreadMayDefine(candidate.expression, name)
          : staticPropertyName(candidate) === null),
      });
    }
    return result;
  };

  const resolvedCallsByOwnerAndEvidence = new Map<string, GraphNode[]>();
  for (const edge of graphEdges) {
    if (edge.kind !== 'calls' || edge.status !== 'resolved' || !edge.from || !edge.to) continue;
    const target = graphNodeById.get(edge.to);
    if (!target) continue;
    for (const evidence of edge.evidence ?? []) {
      const key = `${edge.from}\0${evidence}`;
      const targets = resolvedCallsByOwnerAndEvidence.get(key) ?? [];
      targets.push(target);
      resolvedCallsByOwnerAndEvidence.set(key, targets);
    }
  }

  const resolvedLocalCallTarget = (owner: GraphNode, expression: ts.LeftHandSideExpression, relative: string, line: number): GraphNode | null => {
    if (!ts.isIdentifier(expression)) return null;
    const candidates = (resolvedCallsByOwnerAndEvidence.get(`${owner.id}\0${relative}:${line}`) ?? [])
      .filter(node => node.name === expression.text);
    return candidates.length === 1 ? candidates[0]! : null;
  };

  const functionLikeCache = new Map<string, ts.FunctionLikeDeclaration | null>();
  const functionLikeFor = (target: GraphNode): ts.FunctionLikeDeclaration | null => {
    if (functionLikeCache.has(target.id)) return functionLikeCache.get(target.id)!;
    if (!target.sourceId.startsWith('repo:') || !target.name) return null;
    const file = target.sourceId.slice('repo:'.length);
    const info = moduleInfos.get(file);
    if (!info) return null;
    const targetLine = Number(/:(\d+)(?::|$)/u.exec(target.locator)?.[1] ?? -1);
    let match: ts.FunctionLikeDeclaration | null = null;
    const lineOf = (node: ts.Node) => info.sourceFile.getLineAndCharacterOfPosition(node.getStart(info.sourceFile)).line + 1;
    const inspect = (node: ts.Node): void => {
      if (match) return;
      if (ts.isFunctionDeclaration(node) && node.name?.text === target.name && lineOf(node) === targetLine) match = node;
      else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === target.name && lineOf(node) === targetLine) {
        const initializer = node.initializer;
        if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) match = initializer;
      }
      if (!match) ts.forEachChild(node, inspect);
    };
    inspect(info.sourceFile);
    functionLikeCache.set(target.id, match);
    return match;
  };

  type CallbackBehavior = 'invoked' | 'not-invoked' | 'unresolved';
  const callbackBehaviorCache = new Map<string, CallbackBehavior>();
  const callbackBehavior = (target: GraphNode, parameterIndex: number, property: string, seen = new Set<string>()): CallbackBehavior => {
    const key = `${target.id}:${parameterIndex}:${property}`;
    const cached = callbackBehaviorCache.get(key);
    if (cached) return cached;
    if (seen.has(key)) return 'unresolved';
    seen.add(key);
    const wrapper = functionLikeFor(target);
    if (!wrapper?.body || !target.sourceId.startsWith('repo:')) return 'unresolved';
    const parameter = wrapper.parameters[parameterIndex];
    if (!parameter || !ts.isObjectBindingPattern(parameter.name)) return 'unresolved';
    const computedMayAlias = parameter.name.elements.some(element => element.propertyName && ts.isComputedPropertyName(element.propertyName));
    if (computedMayAlias) return 'unresolved';
    const bindings = parameter.name.elements.filter(element => {
      const external = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName) || ts.isNumericLiteral(element.propertyName))
        ? element.propertyName.text
        : ts.isIdentifier(element.name) ? element.name.text : '';
      return external === property;
    });
    if (bindings.length !== 1) return 'unresolved';
    const bound = bindings[0]!;
    if (!ts.isIdentifier(bound.name) || bound.initializer) return 'unresolved';
    const local = bound.name.text;
    const file = target.sourceId.slice('repo:'.length);
    const info = moduleInfos.get(file)!;
    let directlyInvoked = false;
    let ambiguous = false;
    const forwarded: CallbackBehavior[] = [];
    const adapterBehavior = (adapter: ts.ArrowFunction | ts.FunctionExpression): CallbackBehavior => {
      let invoked = false;
      let uncertain = false;
      const initializerCaptures = (initializer: ts.Expression): boolean => {
        let captures = false;
        const inspectInitializer = (node: ts.Node): void => {
          if (captures) return;
          if (ts.isIdentifier(node) && node.text === local && !isShadowed(node, local, wrapper)) captures = true;
          ts.forEachChild(node, inspectInitializer);
        };
        inspectInitializer(initializer);
        return captures;
      };
      if (adapter.parameters.some(parameter => parameter.initializer && initializerCaptures(parameter.initializer))) uncertain = true;
      const inspectAdapter = (node: ts.Node): void => {
        if (ts.isFunctionLike(node) && node !== adapter) {
          let captures = false;
          const inspectCapture = (nested: ts.Node): void => {
            if (captures) return;
            if (ts.isIdentifier(nested) && nested.text === local && !isShadowed(nested, local, wrapper)) captures = true;
            ts.forEachChild(nested, inspectCapture);
          };
          const nestedBody = 'body' in node ? node.body as ts.ConciseBody | undefined : undefined;
          if (nestedBody) inspectCapture(nestedBody);
          if (captures) uncertain = true;
          return;
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === local
          && !isShadowed(node.expression, local, wrapper)) invoked = true;
        if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === local
          && !isShadowed(node.left, local, wrapper)
          && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) uncertain = true;
        if (ts.isIdentifier(node) && node.text === local
          && !isShadowed(node, local, wrapper)
          && !(ts.isCallExpression(node.parent) && node.parent.expression === node)
          && !(ts.isBinaryExpression(node.parent) && node.parent.left === node)) uncertain = true;
        ts.forEachChild(node, inspectAdapter);
      };
      inspectAdapter(adapter.body);
      return uncertain ? 'unresolved' : invoked ? 'invoked' : 'not-invoked';
    };
    const inspect = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && node !== wrapper) {
        const property = node.parent;
        const object = ts.isPropertyAssignment(property) && property.initializer === node && ts.isObjectLiteralExpression(property.parent)
          ? property.parent
          : null;
        const forwardingCall = object && ts.isCallExpression(object.parent) ? object.parent : null;
        const forwardingTarget = forwardingCall
          ? importedCallTarget(info, forwardingCall.expression)
            ?? resolvedLocalCallTarget(target, forwardingCall.expression, file, info.sourceFile.getLineAndCharacterOfPosition(forwardingCall.getStart(info.sourceFile)).line + 1)
          : null;
        if (forwardingTarget) return;
        let captures = false;
        const inspectCapture = (nested: ts.Node): void => {
          if (captures) return;
          if (ts.isIdentifier(nested) && nested.text === local && !isShadowed(nested, local, wrapper)) captures = true;
          ts.forEachChild(nested, inspectCapture);
        };
        const nestedBody = 'body' in node ? node.body as ts.ConciseBody | undefined : undefined;
        if (nestedBody) inspectCapture(nestedBody);
        if (captures) ambiguous = true;
        return;
      }
      const isPropertyName = (ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node;
      if (ts.isIdentifier(node) && node.text === local && node !== bound.name && !isPropertyName && !isShadowed(node, local, wrapper)) {
        const directCallee = ts.isCallExpression(node.parent) && node.parent.expression === node;
        const forwardedProperty = ((ts.isPropertyAssignment(node.parent) && node.parent.initializer === node)
          || (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node))
          && ts.isObjectLiteralExpression(node.parent.parent) && ts.isCallExpression(node.parent.parent.parent)
          && Boolean(importedCallTarget(info, node.parent.parent.parent.expression));
        if (!directCallee && !forwardedProperty) ambiguous = true;
      }
      if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === local
        && !isShadowed(node.left, local, wrapper)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ambiguous = true;
      if (ts.isReturnStatement(node) && node.expression && ts.isIdentifier(node.expression) && node.expression.text === local
        && !isShadowed(node.expression, local, wrapper)) ambiguous = true;
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.text === local && !isShadowed(node.expression, local, wrapper)) directlyInvoked = true;
        const forwardedTarget = importedCallTarget(info, node.expression)
          ?? resolvedLocalCallTarget(target, node.expression, file, info.sourceFile.getLineAndCharacterOfPosition(node.getStart(info.sourceFile)).line + 1);
        for (const [argumentIndex, argument] of node.arguments.entries()) {
          if (!ts.isObjectLiteralExpression(argument)) {
            if (ts.isIdentifier(argument) && argument.text === local && !isShadowed(argument, local, wrapper)) ambiguous = true;
            continue;
          }
          for (const { property: item, name: forwardedProperty, uncertain } of effectiveObjectProperties(argument)) {
            if (ts.isPropertyAssignment(item) && (ts.isArrowFunction(item.initializer) || ts.isFunctionExpression(item.initializer))) {
              const downstream = forwardedTarget
                ? callbackBehavior(forwardedTarget, argumentIndex, forwardedProperty, new Set(seen))
                : 'unresolved';
              const adapter = adapterBehavior(item.initializer);
              forwarded.push(uncertain ? 'unresolved' : downstream === 'invoked' ? adapter : downstream === 'unresolved' ? 'unresolved' : 'not-invoked');
              continue;
            }
            const forwardsLocal = ts.isPropertyAssignment(item) && ts.isIdentifier(item.initializer) && item.initializer.text === local
              && !isShadowed(item.initializer, local, wrapper)
              || ts.isShorthandPropertyAssignment(item) && item.name.text === local && !isShadowed(item.name, local, wrapper);
            if (!forwardsLocal) continue;
            if (uncertain || !forwardedTarget) ambiguous = true;
            else forwarded.push(callbackBehavior(forwardedTarget, argumentIndex, forwardedProperty, new Set(seen)));
          }
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(wrapper.body);
    const result = ambiguous || forwarded.includes('unresolved')
      ? 'unresolved'
      : directlyInvoked || forwarded.includes('invoked') ? 'invoked' : 'not-invoked';
    callbackBehaviorCache.set(key, result);
    return result;
  };

  const unwrapValue = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current) || ts.isAsExpression(current)
      || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
    return current;
  };
  const returnedExpression = (target: GraphNode): { info: ModuleInfo; expression: ts.Expression; wrapper: ts.FunctionLikeDeclaration } | null => {
    const wrapper = functionLikeFor(target);
    if (!wrapper?.body || !target.sourceId.startsWith('repo:')) return null;
    const info = moduleInfos.get(target.sourceId.slice('repo:'.length));
    if (!info) return null;
    if (!ts.isBlock(wrapper.body)) return { info, expression: wrapper.body, wrapper };
    const returns: ts.Expression[] = [];
    const inspect = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && node !== wrapper) return;
      if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
      ts.forEachChild(node, inspect);
    };
    inspect(wrapper.body);
    return returns.length === 1 && returns[0]!.parent.parent === wrapper.body ? { info, expression: returns[0]!, wrapper } : null;
  };
  const enclosingFunctionLike = (node: ts.Node): ts.FunctionLikeDeclaration | null => {
    let current: ts.Node | undefined = node;
    while (current && !ts.isSourceFile(current)) {
      if (ts.isFunctionLike(current) && 'body' in current) return current as ts.FunctionLikeDeclaration;
      current = current.parent;
    }
    return null;
  };
  const declarationsInScope = (scope: ts.Node, name: string): ts.Declaration[] => {
    const declarations: ts.Declaration[] = [];
    const addBinding = (declaration: ts.VariableDeclaration | ts.ParameterDeclaration): void => {
      if (bindingNameContains(declaration.name, name)) declarations.push(declaration);
    };
    if (ts.isFunctionLike(scope)) {
      scope.parameters.forEach(addBinding);
      if (ts.isFunctionExpression(scope) && scope.name?.text === name) declarations.push(scope);
      const inspectVar = (node: ts.Node): void => {
        if (node !== scope && ts.isFunctionLike(node)) return;
        if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) node.declarations.forEach(addBinding);
        ts.forEachChild(node, inspectVar);
      };
      if ('body' in scope && scope.body) inspectVar(scope.body);
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration) addBinding(scope.variableDeclaration);
    if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
      const initializer = scope.initializer;
      if (initializer && ts.isVariableDeclarationList(initializer)) initializer.declarations.forEach(addBinding);
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isCaseBlock(scope) || ts.isModuleBlock(scope)) {
      const statements: readonly ts.Statement[] = ts.isCaseBlock(scope) ? scope.clauses.flatMap(clause => [...clause.statements]) : scope.statements;
      for (const statement of statements) {
        if (ts.isVariableStatement(statement)) statement.declarationList.declarations.forEach(addBinding);
        else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) declarations.push(statement);
      }
    }
    return declarations;
  };
  const resolveLexicalDeclaration = (reference: ts.Identifier, stopAt: ts.Node): ts.Declaration | null => {
    let current: ts.Node | undefined = reference.parent;
    while (current) {
      const matches = declarationsInScope(current, reference.text);
      if (matches.length) return matches.length === 1 ? matches[0]! : null;
      if (current === stopAt) break;
      current = current.parent;
    }
    return null;
  };
  const bindingUseIsSafe = (
    info: ModuleInfo,
    declaration: ts.VariableDeclaration,
    finalValue: ts.Expression,
    path: string[],
    allowReturn: boolean,
    seen: Set<ts.VariableDeclaration>,
    separatedSiblings = new Set<string>(),
  ): boolean => {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer || seen.has(declaration)) return false;
    const declarationName = declaration.name.text;
    if (declaration.getStart(info.sourceFile) >= finalValue.getStart(info.sourceFile)) return false;
    seen.add(declaration);
    const root = enclosingFunctionLike(declaration) ?? info.sourceFile;
    let safe = true;
    const assignmentKind = (node: ts.Node): boolean => ts.isBinaryExpression(node.parent) && node.parent.left === node
      && node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    const mutationThrough = (node: ts.Expression): boolean => {
      let current: ts.Expression = node;
      while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) current = current.parent;
      return assignmentKind(current) || (ts.isPrefixUnaryExpression(current.parent) || ts.isPostfixUnaryExpression(current.parent)) && current.parent.operand === current;
    };
    const aliasDeclaration = (node: ts.Expression): ts.VariableDeclaration | null =>
      ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name) ? node.parent : null;
    const useSafe = (node: ts.Expression, remainingPath: string[]): boolean => {
      if (mutationThrough(node)) return false;
      if (node === finalValue) return true;
      const alias = aliasDeclaration(node);
      if (alias) return bindingUseIsSafe(info, alias, finalValue, remainingPath, allowReturn, seen, separatedSiblings);
      if (ts.isReturnStatement(node.parent) && node.parent.expression === node) return allowReturn && ts.isFunctionLike(root) && 'body' in root && node.parent.parent === root.body;
      if (ts.isCallExpression(node.parent) && node.parent.arguments.includes(node)) return false;
      return false;
    };
    const inspect = (node: ts.Node): void => {
      if (!safe) return;
      if (ts.isIdentifier(node) && node.text === declarationName && node !== declaration.name
        && resolveLexicalDeclaration(node, root) === declaration) {
        if (enclosingFunctionLike(node) !== enclosingFunctionLike(declaration)) { safe = false; return; }
        if (assignmentKind(node)) { safe = false; return; }
        if (!path.length) { if (!useSafe(node, [])) safe = false; return; }
        let value: ts.Expression = node;
        let matched = true;
        for (const segment of path) {
          if (!ts.isPropertyAccessExpression(value.parent) || value.parent.expression !== value || value.parent.name.text !== segment) { matched = false; break; }
          value = value.parent;
        }
        if (matched) { if (!useSafe(value, [])) safe = false; return; }
        if (ts.isCallExpression(node.parent) && node.parent.arguments.includes(node)) { safe = false; return; }
        if (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node || mutationThrough(node)) { safe = false; return; }
        const sibling = node.parent;
        if (!separatedSiblings.has(sibling.name.text)
          || !(ts.isVoidExpression(sibling.parent)
            || ts.isPropertyAssignment(sibling.parent) && sibling.parent.initializer === sibling)) safe = false;
      }
      ts.forEachChild(node, inspect);
    };
    inspect(root);
    return safe;
  };
  type Separation = 'separated' | 'concrete-interference' | 'unknown';
  const exactObjectSeparation = (info: ModuleInfo, object: ts.ObjectLiteralExpression, targetName: string): Map<string, Separation> => {
    const result = new Map<string, Separation>();
    const properties = object.properties;
    if (properties.some(property => ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)
      || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property) || ts.isMethodDeclaration(property))) return result;
    const named = properties.map(property => ({ property, name: staticPropertyName(property) }));
    if (named.some(item => !item.name || item.name === '__proto__') || new Set(named.map(item => item.name)).size !== named.length) return result;
    const target = named.find(item => item.name === targetName)?.property;
    if (!target || !ts.isPropertyAssignment(target)) return result;
    const targetValue = unwrapValue(target.initializer);
    const targetBinding = ts.isIdentifier(targetValue) ? resolveLexicalDeclaration(targetValue, enclosingFunctionLike(targetValue) ?? info.sourceFile) : null;
    for (const item of named) {
      if (item.name === targetName || !ts.isPropertyAssignment(item.property)) continue;
      const value = unwrapValue(item.property.initializer);
      const binding = ts.isIdentifier(value) ? resolveLexicalDeclaration(value, enclosingFunctionLike(value) ?? info.sourceFile) : null;
      if (binding && targetBinding && binding === targetBinding) result.set(item.name!, 'concrete-interference');
      else if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)
        || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword) result.set(item.name!, 'separated');
      else result.set(item.name!, 'unknown');
    }
    return result;
  };
  const freshArrayValue = (info: ModuleInfo, input: ts.Expression, seen = new Set<string>(), scope?: ts.Node): boolean => {
    const expression = unwrapValue(input);
    const key = `${info.sourceFile.fileName}:${expression.pos}:${expression.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (ts.isArrayLiteralExpression(expression)) return true;
    if (ts.isIdentifier(expression)) {
      const root = scope ?? enclosingFunctionLike(expression) ?? info.sourceFile;
      const declaration = resolveLexicalDeclaration(expression, root);
      if (!declaration || !ts.isVariableDeclaration(declaration) || !bindingUseIsSafe(info, declaration, expression, [], ts.isReturnStatement(expression.parent), new Set())) return false;
      return declaration.initializer ? freshArrayValue(info, declaration.initializer, seen, root) : false;
    }
    if (ts.isCallExpression(expression)) {
      const target = importedCallTarget(info, expression.expression);
      const returned = target ? returnedExpression(target) : null;
      return returned ? freshArrayValue(returned.info, returned.expression, seen, returned.wrapper) : false;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const object = unwrapValue(expression.expression);
      let objectInfo = info;
      let objectScope = scope;
      let objectValue: ts.Expression | null = object;
      let objectDeclaration: ts.VariableDeclaration | null = null;
      if (ts.isIdentifier(object)) {
        const root = scope ?? enclosingFunctionLike(object) ?? info.sourceFile;
        const declaration = resolveLexicalDeclaration(object, root);
        if (!declaration || !ts.isVariableDeclaration(declaration)) return false;
        objectDeclaration = declaration;
        objectValue = declaration.initializer ?? null;
      }
      if (objectValue) objectValue = unwrapValue(objectValue);
      if (objectValue && ts.isCallExpression(objectValue)) {
        const target = importedCallTarget(objectInfo, objectValue.expression);
        const returned = target ? returnedExpression(target) : null;
        if (!returned) return false;
        objectInfo = returned.info;
        objectScope = returned.wrapper;
        objectValue = unwrapValue(returned.expression);
      }
      if (!objectValue || !ts.isObjectLiteralExpression(objectValue)) return false;
      if (objectValue.properties.some(property => ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)
        || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property) || ts.isMethodDeclaration(property))) return false;
      const properties = objectValue.properties.filter(property => staticPropertyName(property) === expression.name.text);
      if (properties.length !== 1 || !ts.isPropertyAssignment(properties[0]!)) return false;
      const separation = exactObjectSeparation(objectInfo, objectValue, expression.name.text);
      const separatedSiblings = new Set([...separation].filter(([, status]) => status === 'separated').map(([name]) => name));
      if (objectDeclaration && !bindingUseIsSafe(info, objectDeclaration, expression, [expression.name.text], false, new Set(), separatedSiblings)) return false;
      return freshArrayValue(objectInfo, properties[0]!.initializer, seen, objectScope);
    }
    return false;
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
    const callbackOwnerFor = (node: ts.ArrowFunction | ts.FunctionExpression): GraphNode | null => {
      const isolated = graphNodeById.get(`symbol:${relative}#function:isolated-callback-${node.getStart(sourceFile)}`);
      if (isolated) return isolated;
      const invoked = graphNodeById.get(`symbol:${relative}#function:callback-${node.getStart(sourceFile)}`);
      if (invoked) return invoked;
      if (ts.isCallExpression(node.parent) && node.parent.arguments[2] === node && node.parent.expression.getText(sourceFile).endsWith('.registerTool')) {
        return graphNodeById.get(`symbol:${relative}#function:mcp-handler-${lineOf(node.parent)}-${node.parent.getStart(sourceFile)}`) ?? null;
      }
      return null;
    };
    const callbackValuesInArgument = (argument: ts.Expression): Array<ts.ArrowFunction | ts.FunctionExpression> => {
      const callbacks: Array<ts.ArrowFunction | ts.FunctionExpression> = [];
      const inspect = (node: ts.Node): void => {
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
          callbacks.push(node);
          return;
        }
        if (ts.isCallExpression(node)) return;
        ts.forEachChild(node, inspect);
      };
      inspect(argument);
      return callbacks;
    };
    const enclosingFunction = (node: ts.Node): ts.FunctionLikeDeclaration | undefined => {
      let current: ts.Node | undefined = node.parent;
      while (current && !ts.isSourceFile(current)) {
        if (ts.isFunctionLike(current) && 'body' in current) return current as ts.FunctionLikeDeclaration;
        current = current.parent;
      }
      return undefined;
    };
    const visit = (node: ts.Node): void => {
      let pushed = false;
      let owner: GraphNode | null = null;
      if (ts.isFunctionDeclaration(node) && node.name) owner = ownerFor(node.name.text, lineOf(node));
      else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) owner = ownerFor(node.name.text, lineOf(node));
      else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) owner = ownerFor(node.name.text, lineOf(node));
      else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node))
        && !(ts.isVariableDeclaration(node.parent) && node.parent.initializer === node)) owner = callbackOwnerFor(node);
      if (owner) { owners.push(owner); pushed = true; }

      if (ts.isCallExpression(node)) {
        const caller = owners.at(-1) ?? fromFile ?? null;
        const classifiedCallbacks = new Set<string>();
        const importedTarget = importedCallTarget(info, node.expression);
        const target = importedTarget ?? (caller ? resolvedLocalCallTarget(caller, node.expression, relative, lineOf(node)) : null);
        if (!target && caller && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map'
          && freshArrayValue(info, node.expression.expression, new Set(), enclosingFunction(node))) {
          const candidate = node.arguments[0];
          if (candidate && (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))) {
            const callback = callbackOwnerFor(candidate);
            if (callback) {
              classifiedCallbacks.add(callback.id);
              addedEdges.push(resolution({
                from: caller.id,
                to: callback.id,
                kind: 'invokes',
                strategy: 'fresh-array-callback-invocation',
                confidence: 1,
                status: 'resolved',
                evidence: [`${relative}:${lineOf(node)}`, 'may invoke through ordinary unmodified Array built-in map'],
                layer: 'structural',
                checkpoint: false,
              }));
            }
          }
        }
        if (target) {
          if (importedTarget && caller && caller.id !== target.id) addedEdges.push(resolution({
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

          const wrapper = functionLikeFor(target);
          if (caller) {
            for (const [argumentIndex, object] of node.arguments.entries()) {
              const parameter = wrapper?.parameters[argumentIndex];
              if (!ts.isObjectLiteralExpression(object)) continue;
              for (const item of object.properties) {
                if (!ts.isPropertyAssignment(item) || !(ts.isArrowFunction(item.initializer) || ts.isFunctionExpression(item.initializer))) continue;
                if (!staticPropertyName(item)) continue;
                const callback = callbackOwnerFor(item.initializer);
                if (callback) classifiedCallbacks.add(callback.id);
              }
              for (const { property: item, name: property, uncertain } of effectiveObjectProperties(object)) {
              if (!ts.isPropertyAssignment(item) || !(ts.isArrowFunction(item.initializer) || ts.isFunctionExpression(item.initializer))) continue;
              const callback = callbackOwnerFor(item.initializer);
              if (!callback) continue;
              const behavior = uncertain || !parameter || !ts.isObjectBindingPattern(parameter.name)
                ? 'unresolved'
                : callbackBehavior(target, argumentIndex, property);
              if (behavior === 'not-invoked') continue;
              addedEdges.push(resolution({
                from: caller.id,
                to: callback.id,
                kind: 'invokes',
                strategy: behavior === 'invoked' ? 'callback-parameter-invocation' : 'callback-transfer-unresolved',
                confidence: behavior === 'invoked' ? 1 : null,
                status: behavior === 'invoked' ? 'resolved' : 'unresolved',
                evidence: [`${relative}:${lineOf(node)}`, target.locator],
                layer: 'structural',
                checkpoint: false,
              }));
            }
            }
          }
        } else {
          const importedBinding = ts.isIdentifier(node.expression)
            ? info.imports.get(node.expression.text)
            : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
              ? info.imports.get(node.expression.expression.text)
              : null;
          if (caller) {
            for (const object of node.arguments) {
              if (!ts.isObjectLiteralExpression(object)) continue;
              for (const item of object.properties) {
                if (!ts.isPropertyAssignment(item) || !(ts.isArrowFunction(item.initializer) || ts.isFunctionExpression(item.initializer))) continue;
                if (!staticPropertyName(item)) continue;
                const callback = callbackOwnerFor(item.initializer);
                if (callback) classifiedCallbacks.add(callback.id);
              }
              for (const { property: item } of effectiveObjectProperties(object)) {
              if (!ts.isPropertyAssignment(item) || !(ts.isArrowFunction(item.initializer) || ts.isFunctionExpression(item.initializer))) continue;
              const callback = callbackOwnerFor(item.initializer);
              if (!callback) continue;
              classifiedCallbacks.add(callback.id);
              addedEdges.push(resolution({
                from: caller.id,
                to: callback.id,
                kind: 'invokes',
                strategy: 'callback-transfer-unresolved',
                confidence: null,
                status: 'unresolved',
                evidence: [`${relative}:${lineOf(node)}`, importedBinding?.module ?? node.expression.getText(sourceFile)],
                layer: 'structural',
                checkpoint: false,
              }));
            }
            }
          }
        }
        if (caller) {
          for (const argument of node.arguments) {
            for (const callbackNode of callbackValuesInArgument(argument)) {
              const callback = callbackOwnerFor(callbackNode);
              if (!callback || classifiedCallbacks.has(callback.id)) continue;
              classifiedCallbacks.add(callback.id);
              addedEdges.push(resolution({
                from: caller.id,
                to: callback.id,
                kind: 'invokes',
                strategy: 'callback-transfer-unresolved',
                confidence: null,
                status: 'unresolved',
                evidence: [`${relative}:${lineOf(node)}`, node.expression.getText(sourceFile)],
                layer: 'structural',
                checkpoint: false,
              }));
            }
          }
        }
      }

      ts.forEachChild(node, visit);
      if (pushed) owners.pop();
    };
    visit(sourceFile);
  }

  return { nodes: addedNodes, edges: dedupeEdges(addedEdges), moduleInfos };
}

export function stableNodeShape(node: GraphNode): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name ?? null,
    value: node.value,
    tags: [...new Set(node.tags ?? [])].filter(tag => tag !== 'referenced').sort(),
  };
}

export function stableEdgeShape(edge: GraphEdge): Record<string, unknown> {
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

export function semanticTopologyFingerprint(nodes: GraphNode[], edges: GraphEdge[]): string {
  const semanticNodes = nodes.filter(node => node.layer === 'semantic' && node.checkpoint !== false).sort((a, b) => a.id.localeCompare(b.id));
  const semanticIds = new Set(semanticNodes.map(node => node.id));
  const semanticEdges = edges.filter(edge => edge.layer === 'semantic' && edge.checkpoint !== false && (!edge.from || semanticIds.has(edge.from)) && (!edge.to || semanticIds.has(edge.to))).sort((a, b) => a.id.localeCompare(b.id));
  const topology = JSON.stringify({ nodes: semanticNodes.map(stableNodeShape), edges: semanticEdges.map(stableEdgeShape) });
  return createHash('sha256').update(topology).digest('hex');
}

function graphFingerprints(nodes: GraphNode[], edges: GraphEdge[], evidence: EvidenceRecord[]): { topologyFingerprint: string; evidenceFingerprint: string } {
  const semanticNodes = nodes.filter(node => node.layer === 'semantic' && node.checkpoint !== false).sort((a, b) => a.id.localeCompare(b.id));
  const semanticIds = new Set(semanticNodes.map(node => node.id));
  const semanticEdges = edges.filter(edge => edge.layer === 'semantic' && edge.checkpoint !== false && (!edge.from || semanticIds.has(edge.from)) && (!edge.to || semanticIds.has(edge.to))).sort((a, b) => a.id.localeCompare(b.id));
  const evidenceById = new Map(evidence.map(item => [item.id, item]));
  const evidenceIds = new Set<string>();
  for (const node of semanticNodes) for (const id of node.evidenceIds ?? []) evidenceIds.add(id);
  for (const edge of semanticEdges) for (const id of edge.evidenceIds ?? []) evidenceIds.add(id);
  const evidencePayload = [...evidenceIds].sort().map(id => evidenceById.get(id) ?? { id, unavailable: true });
  return {
    topologyFingerprint: semanticTopologyFingerprint(nodes, edges),
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

  for (const edge of input.edges) {
    if (edge.kind !== 'imports' || edge.status !== 'resolved' || !edge.from || !edge.to) continue;
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
      input.nodes.push(semanticEntity({ id: `provider:${provider.id}`, sourceId: proof.sourceId, kind: 'provider', locator: relative, name: provider.label, value: { provider: provider.id }, evidenceIds: [proof.id], tags: ['provider-observed', ...(provider.status === 'candidate' ? ['candidate-evidence'] : [])] }));
      for (const owner of owners) input.edges.push(semanticRelationship({
        from: owner,
        to: `provider:${provider.id}`,
        kind: 'integrates-with',
        evidence: [relative],
        evidenceIds: [proof.id],
        strategy: provider.reason,
        status: provider.status,
        confidence: provider.confidence,
      }));
    }
  }

  for (const node of input.nodes) {
    if (node.kind !== 'mcp-tool' || !node.name) continue;
    const toolName = node.name;
    const relative = node.sourceId.startsWith('repo:') ? node.sourceId.slice(5) : node.locator.split(':')[0]!;
    const proof = evidenceForFile(relative, `Observed MCP tool registration ${toolName}`);
    input.evidence.push(proof);
    const mcpId = `mcp:${toolName}`;
    input.nodes.push(semanticEntity({ id: mcpId, sourceId: proof.sourceId, kind: 'mcp', locator: node.locator, name: toolName, value: { tool: toolName }, evidenceIds: [proof.id], tags: ['protocol-observed'] }));
    input.edges.push(semanticRelationship({ from: mcpId, to: node.id, kind: 'registered-as', evidence: [node.locator], evidenceIds: [proof.id], strategy: 'protocol-registration' }));
    const feature = featureByFile.get(relative);
    if (feature) input.edges.push(semanticRelationship({ from: mcpId, to: `feature:${feature}`, kind: 'implemented-by', evidence: [node.locator], evidenceIds: [proof.id], strategy: 'protocol-registration' }));
    const route = routeByFile.get(relative);
    if (route) input.edges.push(semanticRelationship({ from: route.id, to: mcpId, kind: 'exposes', evidence: [node.locator], evidenceIds: [proof.id], strategy: 'protocol-registration' }));
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
      ...(edge.evidenceIds?.length ? { evidenceIds: edge.evidenceIds } : {}),
    }));
    ids.add(edge.to);
  }
  return additions;
}


const INCREMENTAL_GLOBAL_STRATEGIES = new Set([
  'exact-value',
  'exact-name',
  'identifier-match',
  'framework-route',
  'framework-route-method',
  'sql-rpc-name',
  'sql-qualified-name',
  'sql-short-name',
  'sql-name',
  'component-prop',
]);
const LOCAL_INCREMENTAL_EXTENSIONS = new Set(['.json', '.md', '.mdx', '.html', '.htm', '.css', '.sql']);

export interface RepositoryGraphAdvanceResult {
  graph: IntelligenceGraph | null;
  strategy: 'incremental' | 'fallback';
  reason?: string;
  changedFiles: number;
  affectedFiles: number;
}

function graphPathFromFileNode(id: string | null): string | null {
  return id?.startsWith('file:') ? id.slice('file:'.length) : null;
}

function isGraphMetadataPath(relative: string): boolean {
  return relative === GRAPH_DIRECTORY || relative.startsWith(`${GRAPH_DIRECTORY}/`);
}

function incrementalFrontier(previous: IntelligenceGraph, changes: RepositoryChangedFile[], maxFiles: number): { paths: Set<string>; reason?: string } {
  const paths = new Set<string>();
  for (const change of changes) {
    if (isGraphMetadataPath(change.path) && (!change.previousPath || isGraphMetadataPath(change.previousPath))) continue;
    paths.add(change.path);
    if (change.previousPath) paths.add(change.previousPath);
  }
  const codeSeeds = new Set([...paths].filter(relative => CODE_EXTENSIONS.has(path.extname(relative).toLowerCase())));
  if (!codeSeeds.size) return { paths };

  const adjacency = new Map<string, Set<string>>();
  const connect = (left: string, right: string): void => {
    const leftSet = adjacency.get(left) ?? new Set<string>();
    leftSet.add(right);
    adjacency.set(left, leftSet);
    const rightSet = adjacency.get(right) ?? new Set<string>();
    rightSet.add(left);
    adjacency.set(right, rightSet);
  };
  for (const edge of previous.edges) {
    if (edge.kind !== 'imports' || edge.status !== 'resolved') continue;
    const from = graphPathFromFileNode(edge.from);
    const to = graphPathFromFileNode(edge.to);
    if (from && to) connect(from, to);
  }

  const queue = [...codeSeeds];
  while (queue.length) {
    const current = queue.shift()!;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (paths.has(neighbor)) continue;
      paths.add(neighbor);
      queue.push(neighbor);
      if (paths.size > maxFiles) return { paths, reason: `dependency frontier exceeded ${maxFiles} files` };
    }
  }
  return { paths };
}

function coverageFromFiles(tracked: TrackedFile[], eligible: TrackedFile[], files: GraphCoverageFile[]): GraphCoverage {
  const completeFiles = files.filter(file => file.status === 'complete').length;
  const partialFiles = files.filter(file => file.status === 'partial').length;
  const failedFiles = files.filter(file => file.status === 'failed').length;
  const skippedFiles = files.filter(file => file.status === 'skipped').length;
  const unsupportedFiles = files.filter(file => file.status === 'unsupported').length;
  return {
    trackedFiles: tracked.length,
    eligibleFiles: eligible.length,
    analyzedFiles: completeFiles + partialFiles,
    completeFiles,
    partialFiles,
    unsupportedFiles,
    skippedFiles,
    failedFiles,
    skippedOversizedFiles: files.filter(file => file.status === 'skipped' && /exceeds .* bytes/u.test(file.reason ?? '')).length,
    skippedNonRegularFiles: files.filter(file => file.status === 'skipped' && /non-regular|escapes repository root/u.test(file.reason ?? '')).length,
    skippedFileLimitFiles: files.filter(file => file.status === 'skipped' && /^file limit /u.test(file.reason ?? '')).length,
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function pruneIncrementalGraph(previous: IntelligenceGraph, affectedPaths: Set<string>): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: EvidenceRecord[];
  fileNodes: Map<string, GraphNode>;
} {
  const affectedSources = new Set([...affectedPaths].map(relative => `repo:${relative}`));
  const removedEvidenceIds = new Set(previous.evidence.filter(item => affectedSources.has(item.sourceId)).map(item => item.id));
  const evidence = previous.evidence.filter(item => !removedEvidenceIds.has(item.id));
  const evidenceById = new Map(evidence.map(item => [item.id, item]));
  const removedNodeIds = new Set<string>();
  const nodes: GraphNode[] = [];

  for (const node of previous.nodes) {
    if (node.sourceId === 'semantic-reference') {
      removedNodeIds.add(node.id);
      continue;
    }
    const remainingEvidenceIds = (node.evidenceIds ?? []).filter(id => !removedEvidenceIds.has(id));
    if (affectedSources.has(node.sourceId)) {
      if (!remainingEvidenceIds.length) {
        removedNodeIds.add(node.id);
        continue;
      }
      const replacementSource = evidenceById.get(remainingEvidenceIds[0]!)?.sourceId;
      nodes.push({
        ...node,
        ...(replacementSource ? { sourceId: replacementSource } : {}),
        evidenceIds: remainingEvidenceIds,
      });
      continue;
    }
    nodes.push(node.evidenceIds ? { ...node, evidenceIds: remainingEvidenceIds } : node);
  }

  const pathNeedles = [...affectedPaths];
  const edges: GraphEdge[] = [];
  for (const edge of previous.edges) {
    if (INCREMENTAL_GLOBAL_STRATEGIES.has(edge.strategy)) continue;
    if ((edge.from && removedNodeIds.has(edge.from)) || (edge.to && removedNodeIds.has(edge.to))) continue;
    const originalEvidenceIds = edge.evidenceIds ?? [];
    const remainingEvidenceIds = originalEvidenceIds.filter(id => !removedEvidenceIds.has(id));
    if (originalEvidenceIds.length && !remainingEvidenceIds.length) continue;
    if ((edge.evidence ?? []).some(value => pathNeedles.some(relative => value.includes(relative)))) continue;
    edges.push(edge.evidenceIds ? { ...edge, evidenceIds: remainingEvidenceIds } : edge);
  }

  const fileNodes = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.kind === 'file' && node.sourceId.startsWith('repo:')) fileNodes.set(node.sourceId.slice('repo:'.length), node);
  }
  return { nodes, edges, evidence, fileNodes };
}

export async function advanceRepositoryGraph(input: {
  previous: IntelligenceGraph;
  project: string;
  repository: string;
  revision: string;
  root: string;
  changedFiles: RepositoryChangedFile[];
  role?: 'A' | 'W' | 'B';
}): Promise<RepositoryGraphAdvanceResult> {
  const maxChanged = Number(process.env.DEVINT_CANONICAL_INCREMENTAL_MAX_CHANGED_FILES ?? 32);
  const maxFrontier = Number(process.env.DEVINT_CANONICAL_INCREMENTAL_MAX_FRONTIER_FILES ?? 64);
  const sourceChanges = input.changedFiles.filter(change =>
    !isGraphMetadataPath(change.path) || Boolean(change.previousPath && !isGraphMetadataPath(change.previousPath)));
  if (sourceChanges.length > maxChanged) {
    return { graph: null, strategy: 'fallback', reason: `changed-file count exceeded ${maxChanged}`, changedFiles: sourceChanges.length, affectedFiles: sourceChanges.length };
  }
  if (input.previous.schemaVersion !== 2 || input.previous.analyzerVersion !== ANALYZER_VERSION) {
    return { graph: null, strategy: 'fallback', reason: 'previous canonical graph analyzer/schema is incompatible', changedFiles: sourceChanges.length, affectedFiles: sourceChanges.length };
  }
  if (!input.previous.coverage || input.previous.coverage.partialFiles || input.previous.coverage.failedFiles || input.previous.coverage.skippedFiles) {
    return { graph: null, strategy: 'fallback', reason: 'previous canonical graph coverage is incomplete', changedFiles: sourceChanges.length, affectedFiles: sourceChanges.length };
  }

  const frontier = incrementalFrontier(input.previous, sourceChanges, maxFrontier);
  if (frontier.reason) return { graph: null, strategy: 'fallback', reason: frontier.reason, changedFiles: sourceChanges.length, affectedFiles: frontier.paths.size };

  for (const relative of frontier.paths) {
    const ext = path.extname(relative).toLowerCase();
    if (POLYGLOT_EXTENSIONS.has(ext) || UNITY_SERIALIZED_EXTENSIONS.has(ext) || UNITY_JSON_EXTENSIONS.has(ext)) {
      return { graph: null, strategy: 'fallback', reason: `incremental frontier contains globally coupled ${ext || '(none)'} source`, changedFiles: sourceChanges.length, affectedFiles: frontier.paths.size };
    }
    if (ext && !CODE_EXTENSIONS.has(ext) && !LOCAL_INCREMENTAL_EXTENSIONS.has(ext) && supportsSourcePath(relative)) {
      return { graph: null, strategy: 'fallback', reason: `incremental frontier contains unsupported incremental extension ${ext}`, changedFiles: sourceChanges.length, affectedFiles: frontier.paths.size };
    }
  }

  const createdAt = new Date().toISOString();
  const tracked = await trackedFiles(input.root);
  const eligible = tracked.filter(file => supportsSourcePath(file.path));
  if (eligible.length > MAX_FILES) {
    return { graph: null, strategy: 'fallback', reason: `current eligible file count exceeds graph limit ${MAX_FILES}`, changedFiles: sourceChanges.length, affectedFiles: frontier.paths.size };
  }
  const trackedByPath = new Map(tracked.map(file => [file.path, file]));
  const pruned = pruneIncrementalGraph(input.previous, frontier.paths);
  let nodes = pruned.nodes;
  let edges = pruned.edges;
  let evidence = pruned.evidence;
  const fileNodes = pruned.fileNodes;
  const sourceTexts = new Map<string, string>();
  const refreshedCoverage: GraphCoverageFile[] = [];
  const warnings: string[] = [];

  for (const relative of [...frontier.paths].sort()) {
    const trackedFile = trackedByPath.get(relative);
    if (!trackedFile) continue;
    const ext = path.extname(relative).toLowerCase();
    if (!supportsSourcePath(relative)) {
      refreshedCoverage.push({ path: relative, status: 'unsupported', reason: `unsupported extension ${ext || '(none)'}` });
      continue;
    }
    const root = path.resolve(input.root);
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      refreshedCoverage.push({ path: relative, status: 'skipped', reason: 'path escapes repository root' });
      continue;
    }
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      refreshedCoverage.push({ path: relative, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      refreshedCoverage.push({ path: relative, status: 'skipped', reason: 'non-regular file or symlink' });
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      refreshedCoverage.push({ path: relative, status: 'skipped', reason: `file exceeds ${MAX_FILE_BYTES} bytes` });
      continue;
    }

    const fileSource: SourceDescriptor = {
      id: `repo:${relative}`,
      kind: 'repository-file',
      locator: relative,
      revision: input.revision,
      observedAt: createdAt,
      available: true,
    };
    const file = fileNode(fileSource, relative);
    fileNodes.set(relative, file);
    let textValue: string;
    try {
      textValue = await fs.readFile(absolute, 'utf8');
    } catch (error) {
      refreshedCoverage.push({ path: relative, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (CODE_EXTENSIONS.has(ext)) sourceTexts.set(relative, textValue);
    const result = analyzeByTechnology({ source: fileSource, text: textValue, locatorBase: relative });
    nodes.push(file, ...result.observations);
    edges.push(...result.resolutions, ...result.observations.filter(node => node.layer !== 'semantic').map(node => containsEdge(file, node, relative)));
    evidence.push(...(result.evidence ?? []));
    const analyzerFailure = result.resolutions.find(edge => edge.kind === 'analysis' && edge.status === 'unresolved' && !edge.from && !edge.to);
    if (analyzerFailure) refreshedCoverage.push({ path: relative, status: 'failed', reason: analyzerFailure.evidence.join('; ') || 'analyzer failure' });
    else if (result.coverage?.status === 'partial') refreshedCoverage.push({ path: relative, status: 'partial', reason: result.coverage.reason ?? 'analyzer reported partial coverage' });
    else refreshedCoverage.push({ path: relative, status: 'complete' });
  }

  if (refreshedCoverage.some(file => ['failed', 'partial', 'skipped'].includes(file.status))) {
    return { graph: null, strategy: 'fallback', reason: 'incremental frontier did not retain complete coverage', changedFiles: sourceChanges.length, affectedFiles: frontier.paths.size };
  }

  if (sourceTexts.size) {
    const crossFile = await crossFileTypeScriptGraph(input.root, sourceTexts, nodes, edges, fileNodes);
    nodes.push(...crossFile.nodes);
    edges.push(...crossFile.edges);
    const compiler = compilerTypeScriptReferences({
      root: input.root, sourceTexts, nodes, fileNodes, options: loadCompilerOptions(input.root),
    });
    nodes.push(...compiler.nodes);
    edges.push(...compiler.edges);
    addFrameworkSemantics({ sourceTexts, moduleInfos: crossFile.moduleInfos, fileNodes, nodes, edges, evidence });
  }

  nodes.push(...ensureSemanticTargets(nodes, edges));
  const merged = mergeNodes(nodes);
  nodes = merged.nodes;
  evidence = mergeEvidence(evidence);
  edges = edges.filter(edge => !INCREMENTAL_GLOBAL_STRATEGIES.has(edge.strategy));
  edges = resolveFrameworkSpine(nodes, edges);
  edges = dedupeEdges(resolveEvidenceSpine(nodes, resolveCrossSource(nodes, edges)));

  const currentTrackedPaths = new Set(tracked.map(file => file.path));
  const coverageFiles = [
    ...(input.previous.coverage?.files ?? []).filter(file => currentTrackedPaths.has(file.path) && !frontier.paths.has(file.path)),
    ...refreshedCoverage,
  ];
  for (const file of tracked) {
    const ext = path.extname(file.path).toLowerCase();
    if (!supportsSourcePath(file.path) && !coverageFiles.some(item => item.path === file.path)) {
      coverageFiles.push({ path: file.path, status: 'unsupported', reason: `unsupported extension ${ext || '(none)'}` });
    }
  }
  const coverage = coverageFromFiles(tracked, eligible, coverageFiles);
  if (coverage.partialFiles || coverage.failedFiles || coverage.skippedFiles || coverage.analyzedFiles !== coverage.eligibleFiles) {
    return { graph: null, strategy: 'fallback', reason: 'recomposed incremental coverage is incomplete', changedFiles: sourceChanges.length, affectedFiles: frontier.paths.size };
  }

  const fingerprint = await sourceFingerprint(input.root);
  const fingerprints = graphFingerprints(nodes, edges, evidence);
  const repositorySource: SourceDescriptor = {
    id: 'repository',
    kind: 'repository',
    locator: input.repository,
    revision: input.revision,
    observedAt: createdAt,
    available: true,
    ...(warnings.length ? { warnings } : {}),
  };
  const graph: IntelligenceGraph = {
    schemaVersion: 2,
    analyzerVersion: ANALYZER_VERSION,
    graphId: `repo-${input.revision}-${stableHash([fingerprint, ANALYZER_VERSION]).slice(0, 10)}`,
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
    explicitValueConflicts: merged.conflicts,
    unmatchedNodeIds: deriveUnmatched(nodes, edges),
    unavailableSourceIds: [],
    coverage,
  };
  return { graph, strategy: 'incremental', changedFiles: sourceChanges.length, affectedFiles: frontier.paths.size };
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
  const eligible = tracked.filter(file => supportsSourcePath(file.path));
  const selected = [...eligible]
    .sort((left, right) => {
      const leftMeta = path.extname(left.path).toLowerCase() === '.meta' ? 1 : 0;
      const rightMeta = path.extname(right.path).toLowerCase() === '.meta' ? 1 : 0;
      return leftMeta - rightMeta || left.path.localeCompare(right.path);
    })
    .slice(0, MAX_FILES);
  const selectedPaths = new Set(selected.map(file => file.path));
  const warnings: string[] = [];
  const coverageFiles: GraphCoverageFile[] = tracked
    .filter(file => !supportsSourcePath(file.path))
    .map(file => ({ path: file.path, status: 'unsupported', reason: `unsupported extension ${path.extname(file.path).toLowerCase() || '(none)'}` }));
  for (const file of eligible) if (!selectedPaths.has(file.path)) coverageFiles.push({ path: file.path, status: 'skipped', reason: `file limit ${MAX_FILES}` });
  if (selected.length < eligible.length) warnings.push(`Graph file limit reached: analyzed at most ${selected.length} of ${eligible.length} eligible tracked files.`);

  let skippedOversizedFiles = 0;
  let skippedNonRegularFiles = 0;
  let completeFiles = 0;
  let partialFiles = 0;
  let failedFiles = 0;
  let nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];
  let evidence: EvidenceRecord[] = [];
  const fileNodes = new Map<string, GraphNode>();
  const sourceTexts = new Map<string, string>();
  const trackedPaths = new Set(tracked.map(file => file.path));

  for (const trackedFile of selected) {
    const root = path.resolve(input.root);
    const absolute = path.resolve(root, trackedFile.path);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      warnings.push(`Skipped tracked path outside repository root: ${trackedFile.path}`);
      skippedNonRegularFiles += 1;
      coverageFiles.push({ path: trackedFile.path, status: 'skipped', reason: 'path escapes repository root' });
      continue;
    }
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      failedFiles += 1;
      coverageFiles.push({ path: trackedFile.path, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      warnings.push(`Skipped non-regular tracked file: ${trackedFile.path}`);
      skippedNonRegularFiles += 1;
      coverageFiles.push({ path: trackedFile.path, status: 'skipped', reason: 'non-regular file or symlink' });
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      skippedOversizedFiles += 1;
      coverageFiles.push({ path: trackedFile.path, status: 'skipped', reason: `file exceeds ${MAX_FILE_BYTES} bytes` });
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
    let text: string;
    try {
      text = await fs.readFile(absolute, 'utf8');
    } catch (error) {
      failedFiles += 1;
      coverageFiles.push({ path: trackedFile.path, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (CODE_EXTENSIONS.has(path.extname(trackedFile.path).toLowerCase())) sourceTexts.set(trackedFile.path, text);
    const result = analyzeByTechnology({ source: fileSource, text, locatorBase: trackedFile.path });
    nodes.push(file, ...result.observations);
    edges.push(...result.resolutions, ...result.observations.filter(node => node.layer !== 'semantic').map(node => containsEdge(file, node, trackedFile.path)));
    evidence.push(...(result.evidence ?? []));
    const analyzerFailure = result.resolutions.find(edge => edge.kind === 'analysis' && edge.status === 'unresolved' && !edge.from && !edge.to);
    if (analyzerFailure) {
      failedFiles += 1;
      coverageFiles.push({ path: trackedFile.path, status: 'failed', reason: analyzerFailure.evidence.join('; ') || 'analyzer failure' });
    } else if (result.coverage?.status === 'partial') {
      partialFiles += 1;
      coverageFiles.push({ path: trackedFile.path, status: 'partial', reason: result.coverage.reason ?? 'analyzer reported partial coverage' });
    } else {
      completeFiles += 1;
      coverageFiles.push({ path: trackedFile.path, status: 'complete' });
    }
  }

  if (skippedOversizedFiles > 0) warnings.push(`Skipped ${skippedOversizedFiles} tracked files larger than ${MAX_FILE_BYTES} bytes.`);
  if (failedFiles > 0) warnings.push(`${failedFiles} eligible tracked files failed analysis; negative/exhaustive claims must be qualified.`);
  const repositorySource: SourceDescriptor = {
    id: 'repository',
    kind: 'repository',
    locator: input.repository,
    revision: input.revision,
    observedAt: createdAt,
    available: true,
    ...(warnings.length ? { warnings } : {}),
  };

  resolveUnityGraph({
    revision: input.revision,
    createdAt,
    trackedPaths,
    nodes,
    edges,
    evidence,
    fileNodes,
  });
  resolvePolyglotModules({ nodes, edges, fileNodes });
  resolveCSharpReferences({ nodes, edges });
  resolveUnityReverseUsage({ nodes, edges, fileNodes });

  const crossFile = await crossFileTypeScriptGraph(input.root, sourceTexts, nodes, edges, fileNodes);
  nodes.push(...crossFile.nodes);
  edges.push(...crossFile.edges);
  const compiler = compilerTypeScriptReferences({
    root: input.root, sourceTexts, nodes, fileNodes, options: loadCompilerOptions(input.root),
  });
  nodes.push(...compiler.nodes);
  edges.push(...compiler.edges);
  addFrameworkSemantics({ sourceTexts, moduleInfos: crossFile.moduleInfos, fileNodes, nodes, edges, evidence });
  nodes.push(...ensureSemanticTargets(nodes, edges));
  const merged = mergeNodes(nodes);
  nodes = merged.nodes;
  evidence = mergeEvidence(evidence);
  edges = resolveFrameworkSpine(nodes, edges);
  edges = dedupeEdges(resolveEvidenceSpine(nodes, resolveCrossSource(nodes, edges)));

  const fingerprint = await sourceFingerprint(input.root);
  const fingerprints = graphFingerprints(nodes, edges, evidence);
  const skippedFileLimitFiles = Math.max(0, eligible.length - selected.length);
  const skippedFiles = skippedOversizedFiles + skippedNonRegularFiles + skippedFileLimitFiles;
  const coverage: GraphCoverage = {
    trackedFiles: tracked.length,
    eligibleFiles: eligible.length,
    analyzedFiles: completeFiles + partialFiles,
    completeFiles,
    partialFiles,
    unsupportedFiles: tracked.length - eligible.length,
    skippedFiles,
    failedFiles,
    skippedOversizedFiles,
    skippedNonRegularFiles,
    skippedFileLimitFiles,
    files: coverageFiles.sort((a, b) => a.path.localeCompare(b.path)),
  };
  return {
    schemaVersion: 2,
    analyzerVersion: ANALYZER_VERSION,
    graphId: `repo-${input.revision}-${stableHash([fingerprint, ANALYZER_VERSION]).slice(0, 10)}`,
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
    explicitValueConflicts: merged.conflicts,
    unmatchedNodeIds: deriveUnmatched(nodes, edges),
    unavailableSourceIds: [],
    coverage,
  };
}
