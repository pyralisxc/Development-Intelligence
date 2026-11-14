import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { graphContext } from './service.js';
import { withResolvedProjectCheckout } from '../source/git.js';
import { runChecked } from '../util/process.js';
import { evaluateCapturedBooleanChain, verifyGuardedEarlyReturn } from './conditionalCallComposition.js';
import { projectCapturedExecutionFacts } from './capturedFactGraph.js';
import { compareCapturedExecution, type CapturedSystemIdentity } from './capturedSystemComparison.js';
import type { GraphBoundExecutionFact } from './capturedFactGraph.js';

const FULL = /^commit:([a-f0-9]{40})$/iu;
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
const MAX_FILE = 1_000_000;
type Primitive = string | boolean | null;

function validPath(relative: string): boolean {
  return relative.length > 0 && relative.length < 250
    && !relative.startsWith('/') && !relative.includes('\\')
    && !relative.split('/').some(part=>!part || part==='.' || part==='..')
    && /\.ts$/iu.test(relative);
}

/**
 * Read-only normal-execution proof for one compiler/graph-bound route guard
 * whose authorization call composes through one resolved source callee.
 *
 * The caller supplies hypothetical configuration. This method never reads a
 * running environment and never asserts a downstream write or HTTP outcome.
 */
export async function deriveCapturedBooleanGuard(input: {
  project: string;
  ref: string;
  rootId: string;
  calleeId: string;
  routePath: string;
  guardLine: number;
  bindings: Readonly<Record<string, Primitive>>;
}) {
  const exact=FULL.exec(input.ref)?.[1]?.toLowerCase();
  if(!exact) throw new Error('Captured boolean guard requires exact commit:<sha>');
  if(!validPath(input.routePath)) throw new Error('Route source path must be a regular tracked .ts path');
  if(!Number.isSafeInteger(input.guardLine)||input.guardLine<1||input.guardLine>50000) {
    throw new Error('Guard source line must be bounded and positive');
  }
  const inputs=Object.entries(input.bindings);
  if(inputs.length<1||inputs.length>24) throw new Error('Require 1-24 bounded hypothetical bindings');
  for(const [key,value] of inputs){
    if(key.length>128||!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:\(\))?$/u.test(key)
      ||!(value===null||typeof value==='boolean'||typeof value==='string'&&value.length<=64)) {
      throw new Error('Unbounded or invalid hypothetical binding');
    }
    if(typeof value==='string'&&/(?:secret|token|password|credential|api.?key)/iu.test(key)) {
      throw new Error('Sensitive binding values must not be supplied as strings');
    }
  }
  const {graph,revision}=await graphContext(input.project,{ref:input.ref});
  if(graph.repositoryRevision!==exact||revision.sha!==exact) {
    throw new Error('Canonical graph and exact Git revision differ');
  }
  const root=graph.nodes.find(n=>n.id===input.rootId);
  const callee=graph.nodes.find(n=>n.id===input.calleeId);
  if(!root||!callee||root.layer!=='structural'||callee.layer!=='structural'
    ||root.kind!=='function'||callee.kind!=='function'
    ||root.sourceId!==callee.sourceId||!root.sourceId.startsWith('repo:')) {
    throw new Error('Two-hop callables must be exact same-file structural functions');
  }
  const authPath=root.sourceId.slice(5);
  if(!validPath(authPath)||!graph.coverage?.files?.some(f=>f.path===authPath&&f.status==='complete')
    ||!graph.coverage?.files?.some(f=>f.path===input.routePath&&f.status==='complete')) {
    throw new Error('Both captured source files must be completely analyzed');
  }
  return await withResolvedProjectCheckout(revision,async checkout=>{
    const read=async(relative:string):Promise<string>=>{
      const full=path.resolve(checkout.root,relative);
      if(path.relative(checkout.root,full).split(path.sep).join('/')!==relative) {
        throw new Error('Captured source escaped exact checkout');
      }
      const stat=await fs.lstat(full);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE) {
        throw new Error('Captured source must be a bounded regular file');
      }
      const value=await fs.readFile(full,'utf8');
      if(value.includes('\0'))throw new Error('Captured source is not regular UTF-8 text');
      return value;
    };
    const [authSource,routeSource,tree]=await Promise.all([
      read(authPath),read(input.routePath),
      runChecked('git',['-C',checkout.root,'rev-parse','HEAD^{tree}']),
    ]);
    const treeSha=tree.stdout.trim();
    if(!/^[a-f0-9]{40}$/iu.test(treeSha)) throw new Error('Exact Git tree identity was unavailable');
    const capture:CapturedSystemIdentity={
      project:graph.project,revision:exact,treeSha,
      graphId:graph.graphId,analyzerVersion:graph.analyzerVersion,
    };
    const chain=evaluateCapturedBooleanChain({
      graph,sourcePath:authPath,source:authSource,
      rootId:input.rootId,calleeId:input.calleeId,bindings:input.bindings,
    });
    if(chain.status!=='established-normal-path'||chain.value===null){
      return {status:'unproven' as const,reason:chain.reason,capture,
        chain,guard:null,graphProjection:null,comparison:null};
    }
    const guard=verifyGuardedEarlyReturn({
      graph,source:routeSource,sourcePath:input.routePath,
      guardLine:input.guardLine,callableId:input.rootId,authorizationResult:chain.value,
    });
    if(guard.status!=='established-normal-path'||guard.earlyReturn===null){
      return {status:'unproven' as const,reason:guard.reason,capture,
        chain,guard,graphProjection:null,comparison:null};
    }
    const contextSha=hash(JSON.stringify(inputs.sort((a,b)=>a[0].localeCompare(b[0]))));
    const fact:GraphBoundExecutionFact={
      id:'conditional-route-guard:'+hash(JSON.stringify([
        root.id,callee.id,input.routePath,input.guardLine,contextSha,guard.earlyReturn])),
      declarationId:root.id,revision:exact,graphId:graph.graphId,
      executionContextSha256:contextSha,
      evidence:[
        ...chain.guards.map(x=>x.file+':'+x.line+':'+x.expressionDigest),
        ...chain.returns.map(x=>x.file+':'+x.line+':'+x.expressionDigest),
        ...guard.evidence],
      proof:'established-conditional',dependenciesComplete:true,
      effect:guard.earlyReturn?'occurs':'does-not-occur',
      mockedDependencies:[],
    };
    return {
      status:'established-conditional-guard' as const,
      reason:'exact-Git-two-hop-boolean-chain-and-compiler-bound-guard',
      capture,chain,guard,
      graphProjection:projectCapturedExecutionFacts({graph,capture,facts:[fact]}),
      comparison:compareCapturedExecution(capture,[fact],[]),
      proof:{
        exactGitSourceInspected:true,
        externalConfigurationHypothetical:true,
        guardedEarlyReturnIsSourceOnly:true,
        downstreamWriteProven:false,
        HTTPResponseRuntimeObserved:false,
        noLiveProviderAccess:true,
      },
    };
  });
}
