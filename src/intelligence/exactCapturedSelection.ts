import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { graphContext } from './service.js';
import { withResolvedProjectCheckout } from '../source/git.js';
import { runChecked } from '../util/process.js';
import { selectCapturedReturnCall } from './conditionalReturnSelector.js';
import { projectCapturedExecutionFacts } from './capturedFactGraph.js';
import { compareCapturedExecution } from './capturedSystemComparison.js';
import type { CapturedSystemIdentity } from './capturedSystemComparison.js';
import type { GraphBoundExecutionFact } from './capturedFactGraph.js';

/** Read-only exact-Git capture of one bounded conditional source selection. */
export const EXACT_CAPTURED_SELECTOR = 'exact-git-captured-selector.v1';
const FULL = /^commit:([a-f0-9]{40})$/iu;
const MAX_SOURCE=1_000_000;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

export async function deriveCapturedSourceSelection(input:{
  project:string;
  ref:string;
  callableId:string;
  bindings:Readonly<Record<string,string|boolean|null>>;
  mockedDependencies?:readonly string[];
}) {
  const exact=FULL.exec(input.ref)?.[1]?.toLowerCase();
  if(!exact) throw new Error('Captured source selection requires exact commit:<sha>');
  const {graph,revision}=await graphContext(input.project,{ref:input.ref});
  if(graph.repositoryRevision!==exact || revision.sha!==exact) {
    throw new Error('Graph and selected Git revision are inconsistent');
  }
  const callable=graph.nodes.find(node=>node.id===input.callableId);
  if(!callable || callable.layer!=='structural'
    || !['function','method'].includes(callable.kind)
    || !callable.name || !callable.sourceId.startsWith('repo:')) {
    throw new Error('Captured callable must be one exact canonical structural node');
  }
  const relative=callable.sourceId.slice('repo:'.length);
  if(!relative.endsWith('.ts') || relative.includes('..') || relative.startsWith('/')
    || !graph.coverage?.files.some(file=>file.path===relative && file.status==='complete')) {
    throw new Error('Captured callable must have complete regular TypeScript source');
  }
  const mocks=[...new Set(input.mockedDependencies??[])].sort();
  if(mocks.some(value=>!value || value.length>250)||mocks.length>100) {
    throw new Error('Mock dependency inventory is invalid');
  }
  return await withResolvedProjectCheckout(revision,async checkout=>{
    const filename=path.resolve(checkout.root,relative);
    const resolved=path.relative(checkout.root,filename).split(path.sep).join('/');
    if(resolved!==relative) throw new Error('Source path escapes exact checkout');
    const stat=await fs.lstat(filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_SOURCE) {
      throw new Error('Source is not bounded regular file');
    }
    const [source,tree]=await Promise.all([
      fs.readFile(filename,'utf8'),
      runChecked('git',['-C',checkout.root,'rev-parse','HEAD^{tree}']),
    ]);
    if(source.includes('\0')) throw new Error('Source is not UTF-8 code');
    const treeSha=tree.stdout.trim();
    if(!/^[a-f0-9]{40}$/iu.test(treeSha)) throw new Error('Exact Git tree identity unavailable');
    const capture:CapturedSystemIdentity={
      project:graph.project,revision:exact,treeSha,graphId:graph.graphId,
      analyzerVersion:graph.analyzerVersion,
    };
    const selection=selectCapturedReturnCall({
      sourcePath:relative,source,callable:callable.name!,bindings:input.bindings,
    });
    if(selection.status!=='established-conditional-selection' || !selection.selectedCall) {
      return {status:'unproven' as const,reason:selection.reason,
        capture,selection,graphProjection:null,comparison:null};
    }
    const contextSha=digest(JSON.stringify([
      ...Object.entries(input.bindings).sort((a,b)=>a[0].localeCompare(b[0])),
      ['mocks',mocks],
    ]));
    const selectedLine=selection.selectedLine!;
    const fact:GraphBoundExecutionFact={
      id:'return-call-selected:'+digest(JSON.stringify([callable.id,contextSha,
        selection.selectedCall,selection.sourceSha256,selectedLine])),
      declarationId:callable.id,revision:exact,graphId:graph.graphId,
      executionContextSha256:contextSha,
      evidence:[relative+':'+selectedLine,
        ...selection.checkedPredicates.map(item=>relative+':'+item.line+':'+item.sourceSha256)],
      proof:'established-conditional',dependenciesComplete:true,
      effect:'occurs',mockedDependencies:mocks,
    };
    return {status:'established-conditional-selection' as const,
      reason:'exact-Git-source-bounded-return-call',
      capture,
      selection,
      graphProjection:projectCapturedExecutionFacts({graph,capture,facts:[fact]}),
      comparison:compareCapturedExecution(capture,[fact],[]),
      proof:{
        factsDerivedFromVerifiedGitSource:true,
        sourceSelectionOnlyNotCalleeResult:true,
        configBindingsAreCallerSupplied:true,
        noLiveDatabaseOrRuntimeEvidence:true,
      },
    };
  });
}
