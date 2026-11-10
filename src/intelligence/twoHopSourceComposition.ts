import type { IntelligenceGraph } from '../types.js';
import type { SourceCondition, SourceEffect } from './sourceConditionEffects.js';

/**
 * Exact graph-backed composition of two already captured source-effect lenses.
 * The result is a conditional SOURCE path, not an execution observation or a
 * guarantee of normal completion. It never infers predicate satisfiability.
 */
export const TWO_HOP_SOURCE_COMPOSITION = 'exact-two-hop-source-conditions.v1';
interface Lens {
  status: string;
  identity: {
    project:string;graphId:string;sourceRevision:string;analyzerVersion:string;
    functionId:string;sourcePath:string;
  };
  coverage:{
    completeForSupportedStatements:boolean;presentationTruncated:boolean;
  };
  branches:SourceCondition[];
  effects:SourceEffect[];
}
interface Selection {effectLine:number;effectSha256:string}
function lens(value:unknown):Lens|null {
  if(!value||typeof value!=='object')return null;
  const x=value as Partial<Lens>;
  if(x.status!=='supported'||!x.identity||!x.coverage
    ||!Array.isArray(x.branches)||!Array.isArray(x.effects))return null;
  return x as Lens;
}
export function composeTwoHopSourceEffects(input:{
  graph:IntelligenceGraph;
  caller:unknown;callee:unknown;
  call:Selection;calleeReturn:Selection;
  /** Explicit predicate assumptions, never treated as observed configuration. */
  callerAssumptions:Record<string,boolean>;
  calleeAssumptions:Record<string,boolean>;
}) {
  const {graph}=input;
  const no=(reason:string)=>({
    status:'unproven' as const,reason,sourceOnly:true as const,
    runtimeObserved:false as const,calleeReturnValueProven:false as const,
    requiredConditions:[] as Array<{functionId:string;conditionId:string;truth:boolean;predicateSha256:string}>,
    sourceWitnesses:[] as string[],graphId:graph.graphId,revision:graph.repositoryRevision,
  });
  const caller=lens(input.caller),callee=lens(input.callee);
  if(!caller||!callee)return no('source-lens-unavailable');
  for(const item of [caller,callee]){
    if(item.identity.project!==graph.project||item.identity.graphId!==graph.graphId
      ||item.identity.sourceRevision!==graph.repositoryRevision
      ||item.identity.analyzerVersion!==graph.analyzerVersion
      ||!item.coverage.completeForSupportedStatements
      ||item.coverage.presentationTruncated) return no('source-identity-or-coverage-incomplete');
  }
  const covered=new Set((graph.coverage?.files??[]).filter(x=>x.status==='complete').map(x=>x.path));
  if(!covered.has(caller.identity.sourcePath)||!covered.has(callee.identity.sourcePath))
    return no('source-files-not-completely-covered');
  const nodes=new Set(graph.nodes.filter(x=>x.layer==='structural'
    && ['function','method'].includes(x.kind)).map(x=>x.id));
  if(!nodes.has(caller.identity.functionId)||!nodes.has(callee.identity.functionId))
    return no('callable-identity-not-canonical');
  const from=caller.effects.filter(x=>x.kind==='return-call'
    && x.sourceLine===input.call.effectLine && x.expressionSha256===input.call.effectSha256);
  const to=callee.effects.filter(x=>x.kind==='return'
    && x.sourceLine===input.calleeReturn.effectLine
    && x.expressionSha256===input.calleeReturn.effectSha256);
  if(from.length!==1||to.length!==1)return no('effect-witness-not-unique');
  const edge=graph.edges.filter(x=>x.kind==='calls'&&x.status==='resolved'
    && x.layer==='structural'&&x.from===caller.identity.functionId
    && x.to===callee.identity.functionId
    && x.evidence.some(e=>e===caller.identity.sourcePath+':'+input.call.effectLine));
  if(edge.length!==1)return no('exact-resolved-callsite-edge-missing');
  const requirements:Array<{functionId:string;conditionId:string;truth:boolean;predicateSha256:string}>=[];
  for(const [item,effect,assumptions] of [
    [caller,from[0]!,input.callerAssumptions],
    [callee,to[0]!,input.calleeAssumptions],
  ] as const){
    const branches=new Map(item.branches.map(b=>[b.id,b]));
    for(const required of effect.requiredConditions){
      const branch=branches.get(required.conditionId);
      if(!branch||!branch.predicateSha256||!Object.prototype.hasOwnProperty.call(assumptions,required.conditionId)
        ||assumptions[required.conditionId]!==required.expectedTruth)
        return no('predicate-assumption-not-established');
      requirements.push({
        functionId:item.identity.functionId,conditionId:required.conditionId,
        truth:required.expectedTruth,predicateSha256:branch.predicateSha256,
      });
    }
  }
  return {
    status:'established-conditional-source-path' as const,
    reason:'exact-resolved-call-and-two-complete-source-effects',
    sourceOnly:true as const,runtimeObserved:false as const,
    calleeReturnValueProven:false as const,
    /** This is a source selection, not a proof of callee normal completion. */
    selectedCalleeReturnExpression:to[0]!.expression,
    requiredConditions:requirements,
    sourceWitnesses:[
      caller.identity.sourcePath+':'+from[0]!.sourceLine,
      callee.identity.sourcePath+':'+to[0]!.sourceLine,
      edge[0]!.id,
    ],
    graphId:graph.graphId,revision:graph.repositoryRevision,
    proof:{
      predicateSatisfiabilityProven:false as const,
      argumentMappingProven:false as const,
      exceptionalOrAsyncCompletionProven:false as const,
      testRunAttested:false as const,
    },
  };
}
