import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildLocalGraph } from '../src/intelligence/local.js';
import { projectLocalScipEvidence, SCIP_EVIDENCE_STRATEGY } from '../src/intelligence/scipEvidence.js';
import { decodeScipIndex } from '../src/intelligence/scipWire.js';
import { run, runChecked } from '../src/util/process.js';

const api = 'export function handler() { return 1; }\n';
const consumer = "import { handler } from './api.js';\nexport function consumer() { return handler(); }\n";
const symbol = 'scip npm test-fixture 1.0.0 handler().';

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const current = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(current | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.from(bytes);
}
function scalar(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}
function message(field: number, value: Uint8Array): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
}
function text(field: number, value: string): Buffer {
  return message(field, Buffer.from(value, 'utf8'));
}
function occurrence(line: number, start: number, end: number, roles: number, variant: 'typed' | 'legacy' = 'typed'): Buffer {
  const range = variant === 'typed'
    ? message(8, Buffer.concat([scalar(1, line), scalar(2, start), scalar(3, end)]))
    : message(1, Buffer.concat([varint(line), varint(start), varint(end)]));
  return Buffer.concat([range, text(2, symbol), scalar(3, roles)]);
}
function document(file: string, items: Buffer[], encoding = 2): Buffer {
  return Buffer.concat([
    text(1, file), ...items.map(item => message(2, item)), scalar(6, encoding),
  ]);
}
function header(): Buffer {
  const tool = Buffer.concat([text(1, 'scip-fixture'), text(2, '1.0.0')]);
  return message(1, message(2, tool));
}
function scip(options: {
  refLine?: number;
  refStart?: number;
  file?: string;
  variant?: 'typed' | 'legacy';
  otherDefinition?: boolean;
  definitionFile?: string;
  encoding?: number;
  definitionEncoding?: number;
} = {}): Buffer {
  const name = 'handler';
  const definition = occurrence(0, api.indexOf(name), api.indexOf(name) + name.length, 1, options.variant);
  const consumerLine = consumer.split('\n')[1]!;
  const start = options.refStart ?? consumerLine.lastIndexOf(name);
  const reference = occurrence(options.refLine ?? 1, start, start + name.length, 0, options.variant);
  return Buffer.concat([
    header(),
    message(2, document(options.definitionFile ?? 'src/api.ts', [definition], options.definitionEncoding ?? 2)),
    ...(options.otherDefinition ? [message(2, document('src/other.ts', [definition]))] : []),
    message(2, document(options.file ?? 'src/consumer.ts', [reference], options.encoding)),
  ]);
}

async function fixture(extra = false, subproject = ''): Promise<{ root: string; graph: Awaited<ReturnType<typeof buildLocalGraph>> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-scip-fixture-'));
  const sourceRoot = path.join(root, subproject, 'src');
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'api.ts'), api);
  await fs.writeFile(path.join(sourceRoot, 'consumer.ts'), consumer);
  if (extra) await fs.writeFile(path.join(sourceRoot, 'other.ts'), api);
  await runChecked('git', ['init', '--initial-branch=main', root]);
  await runChecked('git', ['-C', root, 'add', '.']);
  await runChecked('git', ['-C', root, '-c', 'user.email=di@example.com', '-c', 'user.name=DI Fixture', 'commit', '-m', 'fixture']);
  return { root, graph: await buildLocalGraph(root, 'scip-fixture', 'W') };
}

async function writeIndex(root: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.join(root, 'scip-cache'), { recursive: true });
  await fs.writeFile(path.join(root, 'scip-cache', 'index.scip'), data);
}

test('SCIP binary occurrence evidence joins existing DI symbols without acquiring authority', async () => {
  const { root, graph } = await fixture();
  try {
    await writeIndex(root, scip());
    const first = await projectLocalScipEvidence({ root, indexPath: 'scip-cache/index.scip', graph });
    const second = await projectLocalScipEvidence({ root, indexPath: 'scip-cache/index.scip', graph });
    const edges = first.graph.edges.filter(item => item.strategy === SCIP_EVIDENCE_STRATEGY);
    assert.equal(first.counts.sourceDocumentsMatched, 2);
    assert.equal(first.counts.definitionsMatched, 1);
    assert.equal(first.counts.candidateEdges, 0);
    assert.equal(first.counts.resolvedEdges, 1);
    assert.equal(first.counts.compilerCorroboratedOccurrences, 1);
    assert.equal(first.counts.compilerVerification, 'completed');
    assert.equal(first.counts.referencedSymbolsMatched, 1);
    assert.equal(edges.length, 1);
    assert.equal(edges[0]?.kind, 'references-symbol');
    assert.equal(edges[0]?.status, 'resolved', 'independent source TypeChecker proof is a resolved technical fact');
    assert.equal(edges[0]?.confidence, 1);
    assert.match(edges[0]?.evidence.join('\n') ?? '', /Independent TypeScript TypeChecker/);
    assert.equal(edges[0]?.from, 'file:src/consumer.ts');
    assert.match(edges[0]?.to ?? '', /src\/api\.ts#function:handler/u);
    assert.match(edges[0]?.evidence.join('\n') ?? '', /SCIP index [a-f0-9]{64}/u);
    assert.equal(first.index.producer.name, 'scip-fixture');
    assert.equal(first.policy.canonicalAuthorityUnaffected, true);
    assert.equal(first.policy.negativeCoverageNotEstablished, true);
    assert.equal(first.policy.independentlyCompilerProvenTechnicalEdgesAreResolved, true);
    assert.equal(first.policy.externallySuppliedIndexNotAttested, true);
    assert.equal(first.policy.runtimeExecutionNotProven, true);
    assert.notEqual(first.graph.graphId, graph.graphId);
    assert.equal(graph.edges.some(item => item.strategy === SCIP_EVIDENCE_STRATEGY), false);
    assert.deepEqual(edges, second.graph.edges.filter(item => item.strategy === SCIP_EVIDENCE_STRATEGY));
    assert.equal(first.graph.graphId, second.graph.graphId);

    const cli = path.resolve('dist/src/graphCli.js');
    const executed = await run(process.execPath, [
      cli, 'scip-evidence', '--repo-path', root, '--project', 'scip-fixture',
      '--scip-index', 'scip-cache/index.scip',
    ]);
    assert.equal(executed.code, 0, executed.stderr);
    const receipt = JSON.parse(executed.stdout);
    assert.equal(receipt.mode, 'ephemeral-scip-evidence');
    assert.equal(receipt.counts.candidateEdges, 0);
    assert.equal(receipt.counts.resolvedEdges, 1);
    assert.equal(receipt.policy.stored, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('SCIP reader accepts historical packed ranges and typed single-line ranges', async () => {
  const index = decodeScipIndex(scip({ variant: 'legacy' }));
  assert.equal(index.producer.name, 'scip-fixture');
  assert.equal(index.documents.length, 2);
  assert.equal(index.occurrenceCount, 2);
  assert.deepEqual(index.documents[0]?.occurrences[0]?.range,
    { line: 0, start: api.indexOf('handler'), end: api.indexOf('handler') + 7 });
  assert.equal(decodeScipIndex(scip()).documents[1]?.occurrences[0]?.range?.line, 1);
});

test('SCIP refuses invented symbol certainty, duplicate definitions and unsupported position precision', async () => {
  const { root, graph } = await fixture(true);
  try {
    await writeIndex(root, scip({ refStart: 500 }));
    const outOfBounds = await projectLocalScipEvidence({ root, indexPath: 'scip-cache/index.scip', graph });
    assert.equal(outOfBounds.counts.candidateEdges, 0);
    assert.ok(outOfBounds.counts.unresolvedOrUnsafeOccurrences > 0);

    await writeIndex(root, scip({ otherDefinition: true }));
    const duplicated = await projectLocalScipEvidence({ root, indexPath: 'scip-cache/index.scip', graph });
    assert.equal(duplicated.counts.candidateEdges, 0);
    assert.equal(duplicated.counts.resolvedEdges, 0);
    assert.equal(duplicated.counts.ambiguousDefinitions, 1);

    // A forged SCIP symbol can name a real source definition that is not the
    // one TypeScript actually binds at this callsite. Its source match is
    // inspectable, but must never become resolved graph truth.
    await writeIndex(root, scip({ definitionFile: 'src/other.ts' }));
    const forged = await projectLocalScipEvidence({ root, indexPath: 'scip-cache/index.scip', graph });
    assert.equal(forged.counts.candidateEdges, 1);
    assert.equal(forged.counts.resolvedEdges, 0);
    assert.equal(forged.counts.compilerCorroboratedOccurrences, 0);
    const candidate = forged.graph.edges.find(item => item.strategy === SCIP_EVIDENCE_STRATEGY);
    assert.equal(candidate?.status, 'candidate');
    assert.match(candidate?.to ?? '', /other\.ts/u);

    await writeIndex(root, scip({ encoding: 0 }));
    const unsupported = await projectLocalScipEvidence({ root, indexPath: 'scip-cache/index.scip', graph });
    assert.equal(unsupported.counts.sourceDocumentsSkipped, 1);
    assert.equal(unsupported.counts.candidateEdges, 0);
    assert.equal(unsupported.counts.resolvedEdges, 0);
    assert.equal(unsupported.policy.negativeCoverageNotEstablished, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('SCIP indexes never traverse paths or upgrade malformed, dirty, or stale evidence', async () => {
  const { root, graph } = await fixture();
  try {
    await writeIndex(root, scip({ file: '../escape.ts' }));
    await assert.rejects(
      projectLocalScipEvidence({ root, indexPath: 'scip-cache/index.scip', graph }),
      /not canonical or would escape/u,
    );
    await writeIndex(root, scip());
    await assert.rejects(
      projectLocalScipEvidence({ root, indexPath: '../elsewhere.scip', graph }),
      /escapes the checkout root/u,
    );
    const valid = scip();
    assert.throws(() => decodeScipIndex(valid.subarray(0, valid.length - 1)), /truncated|length is invalid/u);
    assert.throws(() => decodeScipIndex(Buffer.concat([header(), header()])), /duplicate metadata/u);
    assert.throws(() => decodeScipIndex(Buffer.concat([message(2, document('src/api.ts', [])), header()])),
      /metadata must be the first/u);
    await fs.writeFile(path.join(root, 'src', 'api.ts'), api + '// changed\n');
    await assert.rejects(
      projectLocalScipEvidence({ root, indexPath: 'scip-cache/index.scip', graph }),
      /tracked source identical/u,
    );
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('SCIP occurrence offsets preserve UTF-8, UTF-16 and UTF-32 compiler cross-checks', async () => {
  const { root, graph } = await fixture();
  try {
    for (const encoding of [1, 2, 3]) {
      await writeIndex(root, scip({ encoding }));
      const corroborated = await projectLocalScipEvidence({ root, indexPath: 'scip-cache/index.scip', graph });
      assert.equal(corroborated.counts.resolvedEdges, 1, 'source proof should be encoding-neutral for supported offsets');
      assert.equal(corroborated.counts.compilerCorroboratedOccurrences, 1);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a project-rooted SCIP index is mapped only through an explicit canonical subproject prefix', async () => {
  const prefix = 'packages/studio';
  const { root, graph } = await fixture(false, prefix);
  try {
    await writeIndex(root, scip());
    const direct = await projectLocalScipEvidence({ root, indexPath: 'scip-cache/index.scip', graph });
    assert.equal(direct.counts.sourceDocumentsMatched, 0);
    assert.equal(direct.counts.sourceDocumentsSkipped, 2);
    assert.equal(direct.counts.resolvedEdges, 0);

    const scoped = await projectLocalScipEvidence({ root, indexPath: 'scip-cache/index.scip',
      graph, projectPrefix: prefix });
    assert.equal(scoped.index.projectPrefix, prefix);
    assert.equal(scoped.counts.sourceDocumentsMatched, 2);
    assert.equal(scoped.counts.resolvedEdges, 1);
    assert.equal(scoped.counts.compilerCorroboratedOccurrences, 1);
    const edge = scoped.graph.edges.find(item => item.strategy === SCIP_EVIDENCE_STRATEGY);
    assert.equal(edge?.from, 'file:packages/studio/src/consumer.ts');
    assert.match(edge?.to ?? '', /packages\/studio\/src\/api\.ts#function:handler/u);
    assert.notEqual(scoped.graph.graphId, direct.graph.graphId,
      'different index project roots must never share a graph identity');
    assert.deepEqual((await projectLocalScipEvidence({
      root, indexPath: 'scip-cache/index.scip', graph, projectPrefix: prefix,
    })).graph.edges.filter(item => item.strategy === SCIP_EVIDENCE_STRATEGY),
    scoped.graph.edges.filter(item => item.strategy === SCIP_EVIDENCE_STRATEGY));

    const wrongButTracked = await projectLocalScipEvidence({
      root, indexPath: 'scip-cache/index.scip', graph, projectPrefix: 'packages',
    });
    assert.equal(wrongButTracked.counts.sourceDocumentsSkipped, 2);
    assert.equal(wrongButTracked.counts.resolvedEdges, 0);
    assert.notEqual(wrongButTracked.graph.graphId, scoped.graph.graphId);

    const cli = await run(process.execPath, [
      path.resolve('dist/src/graphCli.js'), 'scip-evidence',
      '--repo-path', root, '--project', 'scip-scoped',
      '--scip-index', 'scip-cache/index.scip', '--scip-project-prefix', prefix,
    ]);
    assert.equal(cli.code, 0, cli.stderr);
    const output = JSON.parse(cli.stdout);
    assert.equal(output.index.projectPrefix, prefix);
    assert.equal(output.counts.resolvedEdges, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('SCIP project roots are not inferred from untrusted metadata or escaping paths', async () => {
  const prefix = 'packages/studio';
  const { root, graph } = await fixture(false, prefix);
  try {
    await writeIndex(root, scip());
    for (const malformed of ['../packages/studio', '/packages/studio', 'packages//studio',
      'packages/./studio', 'packages\\studio', 'C:/packages/studio']) {
      await assert.rejects(
        projectLocalScipEvidence({ root, indexPath: 'scip-cache/index.scip', graph,
          projectPrefix: malformed }),
        /project prefix must be a canonical repository-relative path/u,
        malformed,
      );
    }
    await assert.rejects(projectLocalScipEvidence({ root, indexPath: 'scip-cache/index.scip',
      graph, projectPrefix: 'not-a-tracked-package' }),
    /project prefix has no tracked source files/u);
    await writeIndex(root, scip({ file: '../escape.ts' }));
    await assert.rejects(projectLocalScipEvidence({
      root, indexPath: 'scip-cache/index.scip', graph, projectPrefix: prefix,
    }), /document path is not canonical or would escape/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('actual producer-style unspecified SCIP offsets need explicit compatibility and compiler confirmation', async () => {
  const { root, graph } = await fixture();
  try {
    await writeIndex(root, scip({ encoding: 0, definitionEncoding: 0 }));
    const excluded = await projectLocalScipEvidence({ root, graph, indexPath: 'scip-cache/index.scip' });
    assert.equal(excluded.counts.sourceDocumentsMatched, 0, 'unspecified encoding must not silently select a unit');
    assert.equal(excluded.counts.resolvedEdges, 0);
    assert.equal(excluded.index.assumedPositionEncodingDocuments, 0);

    const compatible = await projectLocalScipEvidence({
      root, graph, indexPath: 'scip-cache/index.scip', legacyPositionEncoding: 'utf16',
    });
    assert.equal(compatible.counts.sourceDocumentsMatched, 2);
    assert.equal(compatible.index.assumedPositionEncodingDocuments, 2);
    assert.equal(compatible.index.legacyPositionEncoding, 'utf16');
    assert.equal(compatible.counts.resolvedEdges, 1, 'only independently compiler-verified relationships become truth');
    assert.equal(compatible.policy.assumedLegacyPositionEncodingIsNotIndependentProof, true);
    assert.equal(compatible.policy.externallySuppliedIndexNotAttested, true);
    assert.notEqual(compatible.graph.graphId, excluded.graph.graphId, 'interpretation policy belongs in graph identity');
    const again = await projectLocalScipEvidence({
      root, graph, indexPath: 'scip-cache/index.scip', legacyPositionEncoding: 'utf16',
    });
    assert.equal(again.graph.graphId, compatible.graph.graphId);
    assert.deepEqual(again.graph.edges.filter(e => e.strategy === SCIP_EVIDENCE_STRATEGY),
      compatible.graph.edges.filter(e => e.strategy === SCIP_EVIDENCE_STRATEGY));

    const cli = await run(process.execPath, [
      path.resolve('dist/src/graphCli.js'), 'scip-evidence',
      '--repo-path', root, '--project', 'scip-legacy', '--scip-index', 'scip-cache/index.scip',
      '--scip-legacy-position-encoding', 'utf16',
    ]);
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).counts.resolvedEdges, 1);
    const invalid = await run(process.execPath, [
      path.resolve('dist/src/graphCli.js'), 'scip-evidence',
      '--repo-path', root, '--project', 'scip-legacy', '--scip-index', 'scip-cache/index.scip',
      '--scip-legacy-position-encoding', 'untrusted',
    ]);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /requires utf8, utf16 or utf32/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
