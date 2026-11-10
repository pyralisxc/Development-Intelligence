import { createHash } from 'node:crypto';
import type { GraphNode, GraphEdge, IntelligenceGraph } from '../types.js';
import type { CapturedSystemIdentity, DerivedExecutionFact } from './capturedSystemComparison.js';

/** One ephemeral projection over DI's existing canonical graph, not a new store. */
export const CAPTURED_FACT_GRAPH_LENS = 'captured-proof-overlay.v1';
export interface GraphBoundExecutionFact extends DerivedExecutionFact {
  /** Exact callable ID returned by the canonical graph's own analyzer. */
  declarationId: string;
}
function sha(value:string) {
  return createHash('sha256').update(value).digest('hex');
}
export function projectCapturedExecutionFacts(input:{
  graph:IntelligenceGraph;capture:CapturedSystemIdentity;
  facts:readonly GraphBoundExecutionFact[];maxFacts?:number;
}):{
  canonicalGraphId:string; ephemeralGraphId:string;
  nodes:GraphNode[];edges:GraphEdge[];
  counts:{total:number;resolved:number;candidate:number;omitted:number};
  policy:{
    noCanonicalMutation:true;sourceProofRequiredForResolvedEdge:true;
    captureIsNotLiveObservation:true;noSecondGraphAuthority:true;
  };
} {
  const {graph,capture,facts}=input;
  if(graph.project!==capture.project || graph.repositoryRevision!==capture.revision
    || graph.graphId!==capture.graphId || graph.analyzerVersion!==capture.analyzerVersion) {
    throw new Error('Captured fact overlay requires exact canonical graph identity');
  }
  const limit=input.maxFacts??100;
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000||facts.length>10000) {
    throw new Error('Captured fact overlay requires bounded population');
  }
  const nodeById=new Map(graph.nodes.map(n=>[n.id,n]));
  const covered=new Set((graph.coverage?.files??[])
    .filter(f=>f.status==='complete').map(f=>f.path));
  const same=new Set<string>();
  const digest=sha(JSON.stringify([capture.project,capture.revision,capture.treeSha,
    capture.graphId,capture.database?.environmentId??null,
    capture.database?.catalogSha256??null]));
  const ephemeralGraphId='snapshot-'+digest.slice(0,32);
  const nodes:GraphNode[]=[];
  const edges:GraphEdge[]=[];
  let resolved=0,candidate=0;
  const sorted=[...facts].sort((a,b)=>a.id.localeCompare(b.id));
  for(const fact of sorted.slice(0,limit)){
    if(!fact.id||same.has(fact.id) || fact.revision!==capture.revision
      || fact.graphId!==capture.graphId) {
      throw new Error('Fact provenance differs from selected captured graph');
    }
    same.add(fact.id);
    const declaration=nodeById.get(fact.declarationId);
    const complete=Boolean(declaration && declaration.layer==='structural'
      && ['function','method'].includes(declaration.kind)
      && declaration.sourceId.startsWith('repo:')
      && covered.has(declaration.sourceId.slice('repo:'.length)));
    const databaseBound=Boolean(!fact.requiresDatabase
      || capture.database && capture.database.sourceBinding==='independently-attested'
      && capture.database.observedSourceRevision===capture.revision);
    const qualified=Boolean(complete&&databaseBound&&fact.dependenciesComplete
      && fact.proof==='established-conditional'&&fact.evidence.length>0);
    if(qualified) resolved++; else candidate++;
    const id='captured-execution-fact:'+sha([digest,fact.id].join(':'));
    nodes.push({
      id,sourceId:'capture:'+ephemeralGraphId,kind:'derived-execution-fact',
      locator:id,name:fact.id,layer:'semantic',checkpoint:false,
      value:{
        effect:fact.effect,sourceDeclarationId:fact.declarationId,
        executionContextSha256:fact.executionContextSha256,
        sourceProof:fact.proof,dependenciesComplete:fact.dependenciesComplete,
        sourceBound:complete,databaseBound,
        derivedFactStatus:qualified?'established-conditional':'candidate',
        sourceRevision:capture.revision,canonicalGraphId:graph.graphId,
      },raw:fact.id,
    });
    if(declaration){
      edges.push({
        id:'captured-proof-edge:'+sha([id,fact.declarationId].join(':')),
        from:id,to:declaration.id,kind:'derived-from-source',
        strategy:CAPTURED_FACT_GRAPH_LENS,confidence:null,
        status:qualified?'resolved':'candidate',layer:'semantic',
        evidence:fact.evidence.slice(0,64),
      });
    }
  }
  return{
    canonicalGraphId:graph.graphId,ephemeralGraphId,nodes,edges,
    counts:{total:facts.length,resolved,candidate,omitted:Math.max(0,facts.length-limit)},
    policy:{
      noCanonicalMutation:true,sourceProofRequiredForResolvedEdge:true,
      captureIsNotLiveObservation:true,noSecondGraphAuthority:true,
    },
  };
}
