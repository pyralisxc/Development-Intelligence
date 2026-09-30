import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntelligenceGraph, SourceDescriptor } from '../src/types.js';
import { analyzeByTechnology, supportsSourcePath } from '../src/intelligence/analyzers/index.js';
import { bootstrapSemanticCandidates } from '../src/intelligence/semanticBootstrap.js';

function source(locator: string): SourceDescriptor {
  return { id: `repo:${locator}`, kind: 'repository-file', locator, revision: 'a'.repeat(40), observedAt: '2026-09-30T00:00:00Z', available: true };
}

test('operational/config paths are supported generically without accepting arbitrary extensionless files', () => {
  for (const file of [
    '.github/workflows/verify.yml',
    'action.yml',
    'Dockerfile',
    'Dockerfile.vercel',
    '.env.example',
    '.env.sample',
    '.gitignore',
    '.dockerignore',
  ]) assert.equal(supportsSourcePath(file), true, file);
  assert.equal(supportsSourcePath('random-extensionless-file'), false);
  assert.equal(supportsSourcePath('.env'), false, 'real env files are not automatically ingested as config examples');
});

test('workflow/action YAML yields bounded operational structure and redacts secret-bearing commands', () => {
  const locator='action.yml';
  const yamlText=[
    'name: Example',
    'on:',
    '  push:',
    'jobs:',
    '  verify:',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '      - name: Test',
    '        run: npm test',
    '      - run: echo "${{ secrets.API_TOKEN }}"',
    'inputs:',
    '  project:',
    '    description: Project',
    'outputs:',
    '  digest:',
    '    description: Digest',
  ].join('\n');
  const result=analyzeByTechnology({source:source(locator),locatorBase:locator,text:yamlText});
  const kinds=new Set(result.observations.map(item=>item.kind));
  assert.ok(kinds.has('workflow-trigger'));
  assert.ok(kinds.has('workflow-job'));
  assert.ok(kinds.has('workflow-step'));
  assert.ok(kinds.has('action-reference'));
  assert.ok(kinds.has('script-command'));
  assert.ok(kinds.has('action-input'));
  assert.ok(kinds.has('action-output'));
  assert.ok(result.observations.every(item=>item.tags?.includes('operational')));
  const serialized=JSON.stringify(result.observations);
  assert.equal(serialized.includes('secrets.API_TOKEN'),false);
});

test('environment examples preserve names but never persist example values', () => {
  const locator='.env.example';
  const result=analyzeByTechnology({source:source(locator),locatorBase:locator,text:'API_TOKEN=super-secret-value\nPUBLIC_URL=https://example.test\n'});
  assert.deepEqual(result.observations.map(item=>item.name),['API_TOKEN','PUBLIC_URL']);
  const serialized=JSON.stringify(result.observations);
  assert.equal(serialized.includes('super-secret-value'),false);
  assert.equal(serialized.includes('https://example.test'),false);
  assert.ok(result.observations.every(item=>item.raw.endsWith('=<declared>')));
});

test('Dockerfile analysis records build structure while redacting declared values and secret-bearing commands', () => {
  const locator='Dockerfile.vercel';
  const result=analyzeByTechnology({source:source(locator),locatorBase:locator,text:`
FROM node:22 AS build
ARG API_TOKEN
ENV PASSWORD=bad-value
RUN echo "$API_TOKEN"
COPY . /app
ENTRYPOINT ["node","dist/server.js"]
`});
  const kinds=new Set(result.observations.map(item=>item.kind));
  assert.ok(kinds.has('docker-stage'));
  assert.ok(kinds.has('docker-env'));
  assert.ok(kinds.has('docker-run'));
  assert.ok(kinds.has('docker-copy'));
  assert.ok(kinds.has('docker-entrypoint'));
  const serialized=JSON.stringify(result.observations);
  assert.equal(serialized.includes('bad-value'),false);
  const run=result.observations.find(item=>item.kind==='docker-run');
  assert.equal(run?.raw,'<redacted>');
});

test('ignore files contribute source-boundary patterns as operational evidence', () => {
  const locator='.dockerignore';
  const result=analyzeByTechnology({source:source(locator),locatorBase:locator,text:'# comment\nnode_modules\n!.keep\n'});
  assert.equal(result.observations.length,2);
  assert.deepEqual(result.observations.map(item=>item.kind),['ignore-pattern','ignore-pattern']);
  assert.deepEqual(result.observations.map(item=>(item.value as any).negated),[false,true]);
});

test('operational nodes are excluded from semantic bootstrap candidate derivation', () => {
  const graph:IntelligenceGraph={
    schemaVersion:2,
    analyzerVersion:'test',
    graphId:'graph-test',
    project:'test/project',
    role:'W',
    createdAt:'2026-09-30T00:00:00Z',
    repositoryRevision:'a'.repeat(40),
    sourceFingerprint:'source',
    topologyFingerprint:'topology',
    evidenceFingerprint:'evidence',
    sources:[source('.github/workflows/verify.yml')],
    evidence:[],
    nodes:[
      {id:'file:.github/workflows/verify.yml',sourceId:'repo:.github/workflows/verify.yml',kind:'file',locator:'.github/workflows/verify.yml',name:'.github/workflows/verify.yml',field:'path',value:'.github/workflows/verify.yml',raw:'.github/workflows/verify.yml',tags:['repository','operational'],layer:'structural',checkpoint:false},
      {id:'job',sourceId:'repo:.github/workflows/verify.yml',kind:'workflow-job',locator:'.github/workflows/verify.yml:5',name:'verify',value:{job:'verify'},raw:'verify',tags:['operational'],layer:'structural',checkpoint:false},
    ],
    edges:[],
    namingDivergences:[],
    explicitValueConflicts:[],
    unmatchedNodeIds:[],
    unavailableSourceIds:[],
    coverage:{trackedFiles:1,eligibleFiles:1,analyzedFiles:1,completeFiles:1,partialFiles:0,unsupportedFiles:0,skippedFiles:0,failedFiles:0,skippedOversizedFiles:0,skippedNonRegularFiles:0,skippedFileLimitFiles:0,files:[{path:'.github/workflows/verify.yml',status:'complete'}]},
  };
  const bootstrap=bootstrapSemanticCandidates(graph,{limit:20});
  assert.equal(bootstrap.candidates.length,0);
  assert.equal(bootstrap.capacity.eligibleCandidateCount,0);
});
