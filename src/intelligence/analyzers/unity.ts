import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { evidenceRecord, observation, resolution } from '../model.js';
import type { EvidenceRecord, GraphNode, Resolution } from '../../types.js';

const UNITY_HEADER = /^--- !u!(\d+) &(-?\d+)(?: stripped)?\s*$/u;
const UNITY_ROOT = /^([A-Za-z_][A-Za-z0-9_]*):\s*$/u;
const GUID = /^[0-9a-f]{32}$/u;
const BUILTIN_GUID = /^0{16}[0-9a-f]{16}$/u;

interface UnityDocument {
  classId: string;
  fileId: string;
  headerLine: number;
  lines: Array<{ text: string; line: number }>;
}

interface UnityReference {
  from: string;
  field: string;
  fileId: string;
  guid?: string;
  type?: string;
  line: number;
}

function unityObjectId(file: string, fileId: string): string {
  return `unity-object:${file}#${fileId}`;
}

function parseReference(value: string): { fileId: string; guid?: string; type?: string } | null {
  const fileId = /(?:^|,)\s*fileID:\s*(-?\d+)/u.exec(value)?.[1];
  if (!fileId) return null;
  const guid = /(?:^|,)\s*guid:\s*([0-9a-f]{32})/u.exec(value)?.[1];
  const type = /(?:^|,)\s*type:\s*(-?\d+)/u.exec(value)?.[1];
  return { fileId, ...(guid ? { guid } : {}), ...(type ? { type } : {}) };
}

function relationFor(field: string): string {
  if (field === 'component') return 'has-component';
  if (field === 'm_GameObject') return 'attached-to';
  if (field === 'm_Father') return 'child-of';
  if (field === 'm_Script') return 'uses-script';
  return 'references';
}

function referencesFor(document: UnityDocument, objectId: string): UnityReference[] {
  const references: UnityReference[] = [];
  for (const { text, line } of document.lines) {
    const mapping = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*):\s*\{([^{}]+)\}/gu;
    let match: RegExpExecArray | null;
    while ((match = mapping.exec(text))) {
      const parsed = parseReference(match[2]!);
      if (parsed) references.push({ from: objectId, field: match[1]!, line, ...parsed });
    }
    if (!mapping.lastIndex && /^\s*-\s*\{[^{}]+\}\s*$/u.test(text)) {
      const body = /\{([^{}]+)\}/u.exec(text)?.[1];
      const parsed = body ? parseReference(body) : null;
      if (parsed) references.push({ from: objectId, field: 'item', line, ...parsed });
    }
  }
  return references;
}

export function analyzeUnityMeta(context: AnalyzeContext): AnalyzeResult {
  const match = /^guid:\s*([0-9a-f]{32})\s*$/imu.exec(context.text);
  if (!match || !GUID.test(match[1]!.toLowerCase())) {
    return {
      observations: [],
      resolutions: [],
      coverage: { status: 'partial', reason: 'Unity metadata has no valid 32-character asset GUID' },
    };
  }
  const guid = match[1]!.toLowerCase();
  const assetPath = context.locatorBase.slice(0, -'.meta'.length);
  const line = context.text.slice(0, match.index).split(/\r?\n/u).length;
  const assetGuid = observation({
    id: `unity-guid:${assetPath}`,
    sourceId: context.source.id,
    kind: 'unity-asset-guid',
    locator: `${context.locatorBase}:${line}`,
    name: guid,
    field: 'guid',
    value: { guid, assetPath },
    tags: ['unity', 'asset-identity'],
    layer: 'structural',
    checkpoint: false,
  });
  const proof = evidenceRecord({
    sourceId: context.source.id,
    kind: 'unity-asset-guid',
    locator: `${context.locatorBase}:${line}`,
    field: 'guid',
    value: { guid, assetPath },
  });
  return { observations: [assetGuid], resolutions: [], evidence: [proof], coverage: { status: 'complete' } };
}

export function analyzeUnitySerialized(context: AnalyzeContext): AnalyzeResult {
  const lines = context.text.split(/\r?\n/u);
  const documents: UnityDocument[] = [];
  let current: UnityDocument | null = null;
  let malformedHeaders = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!;
    if (text.startsWith('---')) {
      const match = UNITY_HEADER.exec(text);
      if (!match) {
        malformedHeaders += 1;
        current = null;
        continue;
      }
      current = { classId: match[1]!, fileId: match[2]!, headerLine: index + 1, lines: [] };
      documents.push(current);
      continue;
    }
    current?.lines.push({ text, line: index + 1 });
  }

  const observations: GraphNode[] = [];
  const resolutions: Resolution[] = [];
  const evidence: EvidenceRecord[] = [];
  const objectIds = new Map<string, string>();
  const references: UnityReference[] = [];
  let missingRoots = 0;
  let duplicateFileIds = 0;

  for (const document of documents) {
    const root = document.lines.find(item => UNITY_ROOT.test(item.text.trim()));
    const type = root ? UNITY_ROOT.exec(root.text.trim())?.[1] : null;
    if (!type) missingRoots += 1;
    if (objectIds.has(document.fileId)) duplicateFileIds += 1;
    const id = unityObjectId(context.locatorBase, document.fileId);
    objectIds.set(document.fileId, id);
    const nameLine = document.lines.find(item => /^\s*m_Name:\s*/u.test(item.text));
    const serializedName = nameLine?.text.replace(/^\s*m_Name:\s*/u, '').trim().replace(/^(["'])(.*)\1$/u, '$2');
    const objectType = type ?? `UnityClass${document.classId}`;
    observations.push(observation({
      id,
      sourceId: context.source.id,
      kind: 'unity-object',
      locator: `${context.locatorBase}:${document.headerLine}`,
      name: serializedName || objectType,
      field: 'object',
      value: {
        classId: document.classId,
        fileId: document.fileId,
        type: objectType,
        ...(serializedName ? { serializedName } : {}),
      },
      tags: ['unity', 'unity-yaml', objectType.toLowerCase()],
      layer: 'structural',
      checkpoint: false,
    }));
    references.push(...referencesFor(document, id));
  }

  for (const reference of references) {
    if (reference.fileId === '0') continue;
    const relationship = relationFor(reference.field);
    if (reference.guid) {
      if (BUILTIN_GUID.test(reference.guid)) continue;
      evidence.push(evidenceRecord({
        sourceId: context.source.id,
        kind: 'unity-guid-reference',
        locator: `${context.locatorBase}:${reference.line}`,
        field: reference.field,
        value: {
          from: reference.from,
          relationship,
          guid: reference.guid,
          fileId: reference.fileId,
          ...(reference.type ? { type: reference.type } : {}),
        },
      }));
      continue;
    }
    const target = objectIds.get(reference.fileId);
    resolutions.push(resolution({
      from: reference.from,
      to: target ?? null,
      kind: relationship,
      strategy: 'unity-file-id',
      confidence: target ? 1 : null,
      status: target ? 'resolved' : 'unresolved',
      evidence: [`${context.locatorBase}:${reference.line}:${reference.field}:fileID=${reference.fileId}`],
      layer: 'structural',
      checkpoint: false,
    }));
  }

  const problems = [
    ...(documents.length === 0 ? ['no Unity object documents found'] : []),
    ...(malformedHeaders ? [`${malformedHeaders} malformed object header${malformedHeaders === 1 ? '' : 's'}`] : []),
    ...(missingRoots ? [`${missingRoots} object${missingRoots === 1 ? '' : 's'} missing a serialized root`] : []),
    ...(duplicateFileIds ? [`${duplicateFileIds} duplicate file ID${duplicateFileIds === 1 ? '' : 's'}`] : []),
  ];
  return {
    observations,
    resolutions,
    evidence,
    coverage: problems.length ? { status: 'partial', reason: problems.join('; ') } : { status: 'complete' },
  };
}
