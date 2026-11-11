import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileCapturedCatalog } from '../src/intelligence/capturedCatalogReconciliation.js';
import type { IntelligenceGraph,TechnicalEvidenceEnvelope } from '../src/types.js';

const sha='a'.repeat(40), name='public.cardforge_set_pipeline_heart';
const signature='p_lineage_id uuid, p_account_id text, p_hearted boolean, p_viewer_access text, p_contributor boolean, p_owner boolean';
const migrations=[
 'supabase/migrations/20260829052228_pipeline_lineages_hearts_and_durable_votes.sql',
 'supabase/migrations/20260922193000_repair_pipeline_reaction_access.sql',
 'supabase/migrations/20260922194500_disambiguate_pipeline_heart_columns.sql',
];
const graph={project:'CardForge',graphId:'repo-'+sha,
 repositoryRevision:sha,analyzerVersion:'native-fixture',
 nodes:migrations.map((path,i)=>({
   id:'sql:'+i,sourceId:'repo:'+path,kind:'sql-function',name,
   value:{qualifiedName:name,signature},layer:'structural',raw:name,locator:path+':1',
 })),
 edges:[],coverage:{files:migrations.map(path=>({path,status:'complete'}))},
} as unknown as IntelligenceGraph;
const evidence={
 source:{id:'snapshot-fixture',label:'snapshot',type:'read-only-http',
   adapter:'database-schema',capability:'query',endpoint:'https://example.test'},
 snapshot:{id:'etag-fixture',sourceRevision:sha,
   observedAt:'2026-11-11T18:30:00Z',sourceObservedAt:'2026-11-11T18:25:00Z',
   freshness:'fresh',ageMs:300000},
 sanitization:{policy:'sanitized-v1',redactedFields:0,redactedValues:0},
 availability:{available:true,httpStatus:200},
 // Adapter recognition is not an exhaustive database routine census.
 coverage:{status:'complete',observed:1,expected:null},
 observations:[{id:'obs:sql',kind:'database-function',locator:'database-function:'+name,
   name,value:{schema:'public',name:'cardforge_set_pipeline_heart',qualifiedName:name,
     raw:{schema:'public',name:'cardforge_set_pipeline_heart',identity_arguments:signature}},
   observedAt:'2026-11-11T18:30:00Z',sourceRevision:sha}],
 relationships:[],correlations:[],correlationStatus:{attempted:false,available:false},
 raw:{sensitive:'fixture-value-not-to-return'},
} as unknown as TechnicalEvidenceEnvelope;

test('real-shaped CardForge capture compares three historical declarations without picking an active function',()=>{
 const r=reconcileCapturedCatalog({graph,evidence,qualifiedName:name});
 assert.equal(r.population.sourceCandidates,3);
 assert.equal(r.population.observedCandidates,1);
 assert.equal(r.population.total,3);
 assert.equal(r.rows.every(x=>x.comparison==='candidate-signature-agreement'),true);
 assert.equal(r.rows.every(x=>x.appliedFunctionProven===false),true);
 assert.equal(r.graphProjection.edges.length,3);
 assert.ok(r.graphProjection.edges.every(x=>x.status==='candidate'));
 assert.equal(r.capture.inventoryComplete,false);
 assert.equal(r.policy.noAppliedRoutineOrCommittedWriteProof,true);
 assert.equal(JSON.stringify(r).includes('fixture-value-not-to-return'),false);
 assert.equal(graph.nodes.length,3);
});
test('missing routine does not mean absent even when adapter recognized data',()=>{
 const partial={...evidence,observations:[]} as TechnicalEvidenceEnvelope;
 const r=reconcileCapturedCatalog({graph,evidence:partial,qualifiedName:name});
 assert.equal(r.population.observedCandidates,0);
 assert.equal(r.rows.every(x=>x.comparison==='source-without-observation'),true);
 assert.equal(r.policy.noNegativeAbsenceFromAdapterRecognition,true);
});
test('reported different schema signature is an unproved historical difference, not live drift',()=>{
 const invalid={...evidence,observations:[{
   ...evidence.observations[0]!,
   value:{qualifiedName:name,raw:{identity_arguments:'p_lineage_id uuid'}},
 }]} as TechnicalEvidenceEnvelope;
 const r=reconcileCapturedCatalog({graph,evidence:invalid,qualifiedName:name});
 assert.ok(r.rows.every(x=>x.comparison==='candidate-signature-difference'));
 assert.ok(r.rows.every(x=>!x.appliedFunctionProven));
});
test('revision mismatch, partial SQL coverage and missing capture identity all fail closed',()=>{
 const mismatch={...evidence,snapshot:{...evidence.snapshot,sourceRevision:'b'.repeat(40)}} as TechnicalEvidenceEnvelope;
 assert.ok(reconcileCapturedCatalog({graph,evidence:mismatch,qualifiedName:name}).rows.every(x=>x.comparison==='incomparable'));
 const partial={...graph,coverage:{files:migrations.map((path,i)=>({path,status:i===2?'partial':'complete'}))}} as unknown as IntelligenceGraph;
 assert.ok(reconcileCapturedCatalog({graph:partial,evidence,qualifiedName:name}).rows.every(x=>x.comparison==='incomparable'));
 const emptyId={...evidence,snapshot:{...evidence.snapshot,id:null}} as TechnicalEvidenceEnvelope;
 assert.ok(reconcileCapturedCatalog({graph,evidence:emptyId,qualifiedName:name}).rows.every(x=>x.comparison==='incomparable'));
});
test('stale snapshot is historically attributable and not declared invalid from age',()=>{
 const stale={...evidence,snapshot:{...evidence.snapshot,freshness:'stale',ageMs:86400000}} as TechnicalEvidenceEnvelope;
 const r=reconcileCapturedCatalog({graph,evidence:stale,qualifiedName:name});
 assert.equal(r.capture.freshness,'stale');
 assert.equal(r.capture.historicalCaptureExpiredByAge,false);
 assert.equal(r.capture.currentEnvironmentEstablished,false);
});
test('recover all candidates through exact digest-bound pages',()=>{
 const first=reconcileCapturedCatalog({graph,evidence,qualifiedName:name,limit:2});
 assert.equal(first.population.total,3);
 assert.equal(first.population.hasNext,true);
 const next=reconcileCapturedCatalog({graph,evidence,qualifiedName:name,offset:2,limit:2,
   expectedDigest:first.population.projectionDigest});
 assert.equal(next.rows.length,1);
 assert.equal(next.population.hasNext,false);
 assert.throws(()=>reconcileCapturedCatalog({graph,evidence,qualifiedName:name,
   offset:2,expectedDigest:'f'.repeat(64)}),/digest differs/);
});
test('unknown routine metadata cannot prove body or active Postgres overload',()=>{
 const invalid={...evidence,observations:[{
   ...evidence.observations[0]!,
   value:{qualifiedName:name,raw:{definition:'CREATE FUNCTION ... sensitive string'}},
 }]} as TechnicalEvidenceEnvelope;
 const r=reconcileCapturedCatalog({graph,evidence:invalid,qualifiedName:name});
 assert.ok(r.rows.every(x=>x.comparison==='candidate-name-only'));
 assert.equal(JSON.stringify(r).includes('sensitive string'),false);
 assert.equal(r.policy.exactSourceAndCatalogBodyEquivalenceNotEstablished,true);
});
test('overloaded routine identities remain distinct, duplicate missing signatures fail closed',()=>{
 const overloaded={...evidence,observations:[
  evidence.observations[0]!,
  {...evidence.observations[0]!,
    value:{qualifiedName:name,raw:{identity_arguments:'p_lineage_id uuid'}}},
 ]} as TechnicalEvidenceEnvelope;
 const result=reconcileCapturedCatalog({graph,evidence:overloaded,qualifiedName:name});
 assert.equal(result.population.observedCandidates,2);
 assert.equal(result.population.total,6);
 assert.equal(result.graphProjection.nodes.length,2);
 assert.equal(result.graphProjection.edges.length,3);
 assert.equal(result.coverage.ambiguousObservedRoutineIdentity,false);
 const ambiguous={...evidence,observations:[
   {...evidence.observations[0]!,value:{qualifiedName:name,raw:{}}},
   {...evidence.observations[0]!,value:{qualifiedName:name,raw:{}}},
 ]} as TechnicalEvidenceEnvelope;
 const unresolved=reconcileCapturedCatalog({graph,evidence:ambiguous,qualifiedName:name});
 assert.equal(unresolved.coverage.ambiguousObservedRoutineIdentity,true);
 assert.ok(unresolved.rows.every(x=>x.comparison==='incomparable'));
 assert.equal(unresolved.graphProjection.edges.length,0);
});

test('untrusted SQL identity text cannot leak arbitrary provider content',()=>{
 const injected={...evidence,observations:[{
   ...evidence.observations[0]!,
   value:{qualifiedName:name,
     raw:{identity_arguments:'p_lineage_id uuid; DROP TABLE secret_records'}},
 }]} as TechnicalEvidenceEnvelope;
 const result=reconcileCapturedCatalog({graph,evidence:injected,qualifiedName:name});
 assert.ok(result.rows.every(x=>x.comparison==='candidate-name-only'));
 assert.equal(JSON.stringify(result).includes('secret_records'),false);
});

test('provider snapshot id remains stable but private in projected evidence',()=>{
 const sensitive={...evidence,snapshot:{
  ...evidence.snapshot,id:'provider-opaque-possible-sensitive-value-123',
 }} as TechnicalEvidenceEnvelope;
 const r=reconcileCapturedCatalog({graph,evidence:sensitive,qualifiedName:name});
 assert.ok(r.capture.observationId?.startsWith('sha256:'));
 assert.equal(JSON.stringify(r).includes('provider-opaque-possible-sensitive-value-123'),false);
 assert.equal(reconcileCapturedCatalog({graph,evidence:sensitive,qualifiedName:name})
  .capture.observationId,r.capture.observationId);
});

test('invalid scope, provider adapter, or oversized population is refused',()=>{
 assert.throws(()=>reconcileCapturedCatalog({graph,evidence,qualifiedName:'heart'}),/schema-qualified/);
 assert.throws(()=>reconcileCapturedCatalog({graph,evidence:{...evidence,source:{...evidence.source,adapter:'generic-json'}} as TechnicalEvidenceEnvelope,
   qualifiedName:name}),/database-schema/);
 assert.throws(()=>reconcileCapturedCatalog({graph,evidence,qualifiedName:name,limit:1001}),/bounded page/);
});
