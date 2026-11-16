import type { GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';

type Pair<T> = { before: T; after: T };
type Delta<T> = { added: T[]; removed: T[]; changed: Pair<T>[]; moved: Pair<T>[]; provenanceChanged: Pair<T>[]; analysisAdded: T[]; analysisRemoved: T[]; analysisChanged: Pair<T>[]; ambiguousAdded: T[]; ambiguousRemoved: T[] };

const positionFields = new Set(['line', 'sourceLine', 'sourceOffset', 'sourceSha256', 'start', 'end', 'sourceRange']);
// These are graph relationship strategies emitted by the producer adapters.
const producerStrategies = new Set(['scip-source-correlated.v2', 'joern-slice-source-correlated.v1']);

function conditionNames(nodes: GraphNode[]): Map<string, string> {
  const result = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind !== 'source-condition' || !node.value || typeof node.value !== 'object') continue;
    const value = node.value as Record<string, unknown>;
    if (typeof value.id === 'string') {
      const key = JSON.stringify([node.sourceId, value.functionId, value.predicateSha256, value.predicate]);
      result.set(value.id, key); counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  for (const [id, key] of result) if ((counts.get(key) ?? 0) > 1) result.delete(id);
  return result;
}

function normalizeSourceValue(value: unknown, conditions: Map<string, string>, key = ''): unknown {
  if (Array.isArray(value)) return value.map(item => normalizeSourceValue(item, conditions));
  if (!value || typeof value !== 'object') {
    if ((key === 'id' || key === 'conditionId') && typeof value === 'string') return conditions.get(value) ?? value;
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value)) {
    if (positionFields.has(field)) continue;
    result[field] = normalizeSourceValue(item, conditions, field);
  }
  return result;
}

function nodeShape(node: GraphNode, conditions: Map<string, string>): unknown {
  if (node.layer === 'semantic') return { id: node.id, kind: node.kind, name: node.name ?? null, value: node.value,
    tags: [...new Set(node.tags ?? [])].filter(tag => tag !== 'referenced').sort() };
  const sourceControl = node.kind === 'source-condition' || node.kind === 'source-effect' || node.kind === 'source-control-summary';
  const scipOccurrence = node.kind === 'source-reference' || (node.kind === 'declaration' && node.field === 'scip-symbol');
  return { sourceId: node.sourceId, kind: node.kind, field: node.field ?? null, name: node.name ?? null,
    value: sourceControl || scipOccurrence ? normalizeSourceValue(node.value, conditions) : node.value,
    raw: node.raw, tags: node.tags ?? [], layer: node.layer ?? 'structural', checkpoint: node.checkpoint ?? null };
}

function canReconcile(node: GraphNode): boolean {
  return node.sourceId.startsWith('repo:') && node.layer !== 'semantic' && node.kind !== 'file'
    && (node.kind !== 'declaration' || node.field === 'scip-symbol' || Boolean(node.name));
}

function producerNode(node: GraphNode): boolean {
  if (!node.value || typeof node.value !== 'object') return false;
  const producer = (node.value as Record<string, unknown>).producer;
  return Boolean(producer && typeof producer === 'object' && typeof (producer as Record<string, unknown>).name === 'string');
}

function evidenceChanged<T>(a: T, b: T): boolean { return JSON.stringify(a) !== JSON.stringify(b); }

/** Reconcile only uniquely identified, source-equivalent occurrences within the same owner/file. */
export function compareGraphRecords(leftGraph: IntelligenceGraph, rightGraph: IntelligenceGraph, leftNodes: GraphNode[], rightNodes: GraphNode[], leftEdges: GraphEdge[], rightEdges: GraphEdge[]): { nodes: Delta<GraphNode>; edges: Delta<GraphEdge> } {
  const empty = <T>(): Delta<T> => ({ added: [], removed: [], changed: [], moved: [], provenanceChanged: [], analysisAdded: [], analysisRemoved: [], analysisChanged: [], ambiguousAdded: [], ambiguousRemoved: [] });
  const nodes = empty<GraphNode>(), edges = empty<GraphEdge>();
  const sourceHashes = (graph: IntelligenceGraph, records: GraphNode[]) => {
    const values = new Map<string, string>();
    for (const item of graph.coverage?.files ?? []) if (item.contentSha256) values.set('repo:' + item.path, item.contentSha256);
    for (const node of records) if (node.kind === 'source-control-summary' && node.value && typeof node.value === 'object') {
      const hash = (node.value as Record<string, unknown>).sourceSha256;
      if (typeof hash === 'string' && !values.has(node.sourceId)) values.set(node.sourceId, hash);
    }
    return values;
  };
  const leftHashes = sourceHashes(leftGraph, leftNodes), rightHashes = sourceHashes(rightGraph, rightNodes);
  const unchangedSource = (sourceId: string) => Boolean(sourceId.startsWith('repo:') && leftHashes.has(sourceId) && leftHashes.get(sourceId) === rightHashes.get(sourceId));
  const leftPaths = new Set((leftGraph.coverage?.files ?? []).map(file => `repo:${file.path}`));
  const rightPaths = new Set((rightGraph.coverage?.files ?? []).map(file => `repo:${file.path}`));
  const sourceAdded = (sourceId: string) => Boolean(leftGraph.coverage && sourceId.startsWith('repo:') && !leftPaths.has(sourceId) && rightPaths.has(sourceId));
  const sourceRemoved = (sourceId: string) => Boolean(rightGraph.coverage && sourceId.startsWith('repo:') && leftPaths.has(sourceId) && !rightPaths.has(sourceId));
  const leftConditions = conditionNames(leftNodes), rightConditions = conditionNames(rightNodes);
  const leftById = new Map(leftNodes.map(node => [node.id, node]));
  const leftKeys = new Map<string, GraphNode[]>(), rightKeys = new Map<string, GraphNode[]>();
  const group = (map: Map<string, GraphNode[]>, node: GraphNode, conditions: Map<string, string>) => {
    if (!canReconcile(node)) return;
    const key = JSON.stringify(nodeShape(node, conditions));
    const values = map.get(key) ?? []; values.push(node); map.set(key, values);
  };
  for (const node of leftNodes) group(leftKeys, node, leftConditions);
  for (const node of rightNodes) group(rightKeys, node, rightConditions);
  const usedLeft = new Set<string>(), usedRight = new Set<string>(), newToOld = new Map<string, string>();
  const pairNode = (before: GraphNode, after: GraphNode) => {
    usedLeft.add(before.id); usedRight.add(after.id); newToOld.set(after.id, before.id);
    if (JSON.stringify(nodeShape(before, leftConditions)) !== JSON.stringify(nodeShape(after, rightConditions))) (unchangedSource(before.sourceId) || producerNode(before) || producerNode(after) ? nodes.analysisChanged : nodes.changed).push({ before, after });
    else if (before.id !== after.id || before.locator !== after.locator) (unchangedSource(before.sourceId) || producerNode(before) || producerNode(after) ? nodes.analysisChanged : nodes.moved).push({ before, after });
    else if (evidenceChanged(before, after)) nodes.provenanceChanged.push({ before, after });
  };
  // Equal source content and equal locations identify the same occurrence even
  // when different dependency resolution changes SCIP's symbol identifier.
  const locationGroups = new Map<string, GraphNode[]>();
  const locationKey = (node: GraphNode) => JSON.stringify([node.sourceId, node.kind, node.locator, node.name, node.raw]);
  for (const node of leftNodes) if (!usedLeft.has(node.id) && canReconcile(node) && unchangedSource(node.sourceId)) {
    const key = locationKey(node), group = locationGroups.get(key) ?? []; group.push(node); locationGroups.set(key, group);
  }
  for (const node of rightNodes) if (!usedRight.has(node.id) && canReconcile(node) && unchangedSource(node.sourceId)) {
    const group = locationGroups.get(locationKey(node));
    if (group?.length === 1 && !usedLeft.has(group[0]!.id)) pairNode(group[0]!, node);
  }
  for (const [key, before] of leftKeys) {
    const after = rightKeys.get(key);
    if (before.length === 1 && after?.length === 1 && !usedLeft.has(before[0]!.id) && !usedRight.has(after[0]!.id)) pairNode(before[0]!, after[0]!);
  }
  for (const after of rightNodes) {
    if (usedRight.has(after.id)) continue;
    const before = leftById.get(after.id);
    if (before && !usedLeft.has(before.id)) pairNode(before, after);
  }
  const leftAmbiguous = new Set<string>(), rightAmbiguous = new Set<string>();
  for (const [key, before] of leftKeys) {
    const after = rightKeys.get(key);
    if (!after) continue;
    const remainingLeft = before.filter(node => !usedLeft.has(node.id));
    const remainingRight = after.filter(node => !usedRight.has(node.id));
    if (!remainingLeft.length || !remainingRight.length) continue;
    for (const node of remainingLeft) leftAmbiguous.add(node.id);
    for (const node of remainingRight) rightAmbiguous.add(node.id);
  }
  for (const after of rightNodes) if (!usedRight.has(after.id)) (unchangedSource(after.sourceId) || producerNode(after) && !sourceAdded(after.sourceId) ? nodes.analysisAdded : rightAmbiguous.has(after.id) ? nodes.ambiguousAdded : nodes.added).push(after);
  for (const before of leftNodes) if (!usedLeft.has(before.id)) (unchangedSource(before.sourceId) || producerNode(before) && !sourceRemoved(before.sourceId) ? nodes.analysisRemoved : leftAmbiguous.has(before.id) ? nodes.ambiguousRemoved : nodes.removed).push(before);

  const edgeKey = (edge: GraphEdge, remap: boolean) => JSON.stringify([
    remap && edge.from ? newToOld.get(edge.from) ?? edge.from : edge.from,
    remap && edge.to ? newToOld.get(edge.to) ?? edge.to : edge.to,
    edge.kind, edge.strategy, edge.layer ?? 'structural',
  ]);
  const leftGroups = new Map<string, GraphEdge[]>(), rightGroups = new Map<string, GraphEdge[]>();
  const groupEdge = (map: Map<string, GraphEdge[]>, edge: GraphEdge, remap: boolean) => {
    const key = edgeKey(edge, remap), values = map.get(key) ?? []; values.push(edge); map.set(key, values);
  };
  for (const edge of leftEdges) groupEdge(leftGroups, edge, false);
  for (const edge of rightEdges) groupEdge(rightGroups, edge, true);
  const pairedLeft = new Set<string>(), pairedRight = new Set<string>();
  const leftNodeIndex = new Map(leftNodes.map(node => [node.id, node]));
  const rightNodeIndex = new Map(rightNodes.map(node => [node.id, node]));
  const edgeSource = (edge: GraphEdge, index: Map<string, GraphNode>) => {
    const from = edge.from ? index.get(edge.from)?.sourceId : undefined;
    if (from?.startsWith('repo:')) return from;
    const to = edge.to ? index.get(edge.to)?.sourceId : undefined;
    return to ?? '';
  };
  const edgeUnchangedSource = (edge: GraphEdge, index: Map<string, GraphNode>) => unchangedSource(edgeSource(edge, index));
  const producerEdge = (edge: GraphEdge, index: Map<string, GraphNode>) => producerStrategies.has(edge.strategy) || Boolean((edge.from && index.get(edge.from) && producerNode(index.get(edge.from)!)) || (edge.to && index.get(edge.to) && producerNode(index.get(edge.to)!)));
  const pairEdge = (before: GraphEdge, after: GraphEdge) => {
    pairedLeft.add(before.id); pairedRight.add(after.id);
    if (before.status !== after.status || before.confidence !== after.confidence || before.checkpoint !== after.checkpoint) (edgeUnchangedSource(before, leftNodeIndex) || producerEdge(before, leftNodeIndex) || producerEdge(after, rightNodeIndex) ? edges.analysisChanged : edges.changed).push({ before, after });
    else if (before.from !== after.from || before.to !== after.to) (edgeUnchangedSource(before, leftNodeIndex) || producerEdge(before, leftNodeIndex) || producerEdge(after, rightNodeIndex) ? edges.analysisChanged : edges.moved).push({ before, after });
    else if (evidenceChanged([before.evidence, before.evidenceIds], [after.evidence, after.evidenceIds])) edges.provenanceChanged.push({ before, after });
  };
  for (const [key, before] of leftGroups) {
    const after = rightGroups.get(key);
    if (before.length === 1 && after?.length === 1) pairEdge(before[0]!, after[0]!);
  }
  const leftEdgeIds = new Map(leftEdges.map(edge => [edge.id, edge]));
  for (const after of rightEdges) {
    if (pairedRight.has(after.id)) continue;
    const before = leftEdgeIds.get(after.id);
    if (before && !pairedLeft.has(before.id) && edgeKey(before, false) === edgeKey(after, true)) pairEdge(before, after);
    else (edgeUnchangedSource(after, rightNodeIndex) || producerEdge(after, rightNodeIndex) && !sourceAdded(edgeSource(after, rightNodeIndex)) ? edges.analysisAdded : (after.from && rightAmbiguous.has(after.from)) || (after.to && rightAmbiguous.has(after.to)) ? edges.ambiguousAdded : edges.added).push(after);
  }
  for (const before of leftEdges) if (!pairedLeft.has(before.id)) (edgeUnchangedSource(before, leftNodeIndex) || producerEdge(before, leftNodeIndex) && !sourceRemoved(edgeSource(before, leftNodeIndex)) ? edges.analysisRemoved : (before.from && leftAmbiguous.has(before.from)) || (before.to && leftAmbiguous.has(before.to)) ? edges.ambiguousRemoved : edges.removed).push(before);
  return { nodes, edges };
}
