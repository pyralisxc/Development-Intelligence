import assert from 'node:assert/strict'; import { createHash } from 'node:crypto'; import { promises as fs } from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import test from 'node:test';
import { buildTestClaimDecisionRecord, generateTestClaimCatalog, normalizeTestClaimCatalog } from '../src/intelligence/testClaimInventory.js'; import type { IntelligenceGraph } from '../src/types.js';
const revision='a'.repeat(40); const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function graph(): IntelligenceGraph { return {schemaVersion:2,analyzerVersion:'inventory-test',graphId:'repo-test',project:'example/project',role:'W',createdAt:'2026-11-03T00:00:00Z',repositoryRevision:revision,sourceFingerprint:'source',topologyFingerprint:'topology',evidenceFingerprint:'evidence',sources:[],evidence:[],nodes:[{id:'mcp:tool_a',sourceId:'repo:src/owner.ts',kind:'mcp',locator:'tool_a',name:'tool_a',value:{},raw:'tool_a',layer:'semantic'},{id:'tool:tool_a',sourceId:'repo:src/owner.ts',kind:'mcp-tool',locator:'tool_a',name:'tool_a',value:{},raw:'tool_a',layer:'semantic'}],edges:[{id:'registration-a',from:'mcp:tool_a',to:'tool:tool_a',kind:'registered-as',strategy:'declared',confidence:1,status:'resolved',evidence:[],layer:'semantic'}],namingDivergences:[],explicitValueConflicts:[],unmatchedNodeIds:[],unavailableSourceIds:[],coverage:{trackedFiles:2,eligibleFiles:2,analyzedFiles:2,completeFiles:2,partialFiles:0,unsupportedFiles:0,skippedFiles:0,failedFiles:0,skippedOversizedFiles:0,skippedNonRegularFiles:0,skippedFileLimitFiles:0,files:[{path:'tests/example.test.ts',status:'complete'},{path:'src/owner.ts',status:'complete'}]}}; }

test('source-validated assertion can be equivalent while unrelated or forged mappings cannot', async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'di-claims-')); try { await fs.mkdir(path.join(root,'tests'));await fs.mkdir(path.join(root,'src'));await fs.writeFile(path.join(root,'src/owner.ts'),"registerTool('tool_a');\n"); const source=`import {readFileSync} from 'node:fs';\nimport {resolve} from 'node:path';\nimport {expect} from 'vitest';\nconst tools=readFileSync(resolve(process.cwd(),'src/owner.ts'),'utf8');\nexpect(tools).toContain("'tool_a'");\n`; await fs.writeFile(path.join(root,'tests/example.test.ts'),source); const expression=`expect(tools).toContain("'tool_a'")`; const start=source.indexOf(expression); const base={version:1,revision,analyzerVersion:'inventory-test',scope:{sourcePrefixes:['tests/'],sourceSuffixes:['.test.ts']},files:[{sourceId:'tests/example.test.ts',contentSha256:sha(source),declarationIds:[],assertionIds:['a'],disposition:'analyzed'}],declarations:[],assertions:[{id:'a',sourceId:'tests/example.test.ts',start,end:start+expression.length,spanSha256:sha(expression),dynamic:false}]};
 const predicate={id:'proof-a',type:'reachability',from:{ids:['mcp:tool_a']},to:{kinds:['mcp-tool'],sourceIds:['repo:src/owner.ts']},requirement:'required',quantifier:'any',direction:'outbound',relationshipKinds:['registered-as'],maxDepth:1,scopeSourceIds:['src/owner.ts']}; const catalog=normalizeTestClaimCatalog({...base,claims:[{id:'claim-a',originalClaim:'tool a registered',equivalenceRationale:'same registration obligation',assertionIds:['a'],parityClaimIds:['proof-a'],productionSourceIds:['src/owner.ts']}]}); const parity=[{id:'proof-a',status:'satisfied',qualified:true,replacementEligible:true,blockers:[],predicate,matched:{subjects:['mcp:tool_a'],targets:['tool:tool_a']}}]; const record=await buildTestClaimDecisionRecord(root,graph(),catalog,parity) as any; assert.equal(record.evaluatorVersion,'1.3.0');assert.match(record.inputFingerprint,/^[0-9a-f]{64}$/u);assert.equal(record.claims[0].outcome,'partial-overlap');assert.equal(record.claims[0].staticReplacementEquivalent,false);assert.equal(record.claims[0].maintainedCompositeEquivalent,true); assert.equal(record.population.supportedDiscoveryComplete,true);assert.equal(record.population.wholeLanguageComplete,false);assert.equal(record.nativeObligations[0].currentObservationOverlap,true,JSON.stringify(record.nativeObligations[0]));assert.equal(record.nativeObligations[0].directionalReplacementProven,false);assert.equal(record.nativeObligations[0].graphInterpretation.status,'satisfied');const nativeOnly=await buildTestClaimDecisionRecord(root,graph(),normalizeTestClaimCatalog({...base,claims:[]}),[]) as any;assert.equal(nativeOnly.claims.length,0);assert.equal(nativeOnly.nativeObligations[0].maintainedComposite.satisfied,true);
 const unrelated=normalizeTestClaimCatalog({...base,claims:[{id:'wrong',originalClaim:'tool a registered',equivalenceRationale:'forged mapping',assertionIds:['a'],parityClaimIds:['proof-b'],productionSourceIds:['src/owner.ts']}]}); const wrong=await buildTestClaimDecisionRecord(root,graph(),unrelated,[{...parity[0],id:'proof-b',predicate:{...predicate,id:'proof-b',from:{ids:['mcp:tool_b']}}}]) as any; assert.equal(wrong.claims[0].outcome,'unproven-equivalence'); assert.equal(wrong.claims[0].staticReplacementEquivalent,false);
 const forged=normalizeTestClaimCatalog({...base,assertions:[{...base.assertions[0],sourceId:'tests/missing.test.ts'}],claims:[{id:'forged',originalClaim:'tool a',equivalenceRationale:'forged source',assertionIds:['a'],parityClaimIds:['proof-a'],productionSourceIds:['src/owner.ts']}]}); const bad=await buildTestClaimDecisionRecord(root,graph(),forged,parity) as any; assert.equal(bad.claims[0].outcome,'unclassified');
 } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('population omissions, changed source, analyzer drift, and non-static protection stay explicit',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'di-claims-'));try{await fs.mkdir(path.join(root,'tests'));const source=`expect(runtime).toBe(true);`;await fs.writeFile(path.join(root,'tests/example.test.ts'),source);const catalog=normalizeTestClaimCatalog({version:1,revision,analyzerVersion:'old',scope:{sourcePrefixes:['tests/'],sourceSuffixes:['.test.ts']},files:[],declarations:[],assertions:[],claims:[]});const record=await buildTestClaimDecisionRecord(root,graph(),catalog,[]) as any;assert.equal(record.population.supportedDiscoveryComplete,false);assert.equal(record.population.wholeLanguageComplete,false);assert.deepEqual(record.population.missingFiles,['tests/example.test.ts']);assert.equal(record.catalog?.current,undefined);assert.throws(()=>normalizeTestClaimCatalog({...catalog,analyzerVersion:undefined}),/analyzerVersion/);}finally{await fs.rm(root,{recursive:true,force:true});}});

test('each obligation needs its own precise proof and omitted assertions keep population incomplete', async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'di-claims-'));try{await fs.mkdir(path.join(root,'tests'));await fs.mkdir(path.join(root,'src'));await fs.writeFile(path.join(root,'src/owner.ts'),"registerTool('tool_a'); registerTool('tool_b');\n");
 const source=`import {readFileSync} from 'node:fs';\nimport {expect} from 'vitest';\nconst tools=readFileSync('src/owner.ts','utf8');\nexpect(tools).toContain("'tool_a'");\nexpect(tools).toContain("'tool_b'");\n`;await fs.writeFile(path.join(root,'tests/example.test.ts'),source);
 const expressions=[`expect(tools).toContain("'tool_a'")`,`expect(tools).toContain("'tool_b'")`];const assertions=expressions.map((expression,index)=>{const start=source.indexOf(expression);return{id:`a${index}`,sourceId:'tests/example.test.ts',start,end:start+expression.length,spanSha256:sha(expression),dynamic:false};});
 const base={version:1,revision,analyzerVersion:'inventory-test',scope:{sourcePrefixes:['tests/'],sourceSuffixes:['.test.ts']},files:[{sourceId:'tests/example.test.ts',contentSha256:sha(source),declarationIds:[],assertionIds:['a0','a1'],disposition:'analyzed'}],declarations:[],assertions};
 const predicate={id:'proof-a',type:'reachability',from:{ids:['mcp:tool_a']},to:{kinds:['mcp-tool'],sourceIds:['repo:src/owner.ts']},requirement:'required',quantifier:'any',direction:'outbound',relationshipKinds:['registered-as'],maxDepth:1,scopeSourceIds:['src/owner.ts']};const parity=[{id:'proof-a',status:'satisfied',qualified:true,replacementEligible:true,blockers:[],predicate,matched:{subjects:['mcp:tool_a'],targets:['tool:tool_a']}}];
 const catalog=normalizeTestClaimCatalog({...base,claims:[{id:'both',originalClaim:'both registrations',equivalenceRationale:'each registration must be proven',assertionIds:['a0','a1'],parityClaimIds:['proof-a'],productionSourceIds:['src/owner.ts']}]});const record=await buildTestClaimDecisionRecord(root,graph(),catalog,parity) as any;assert.equal(record.claims[0].outcome,'unproven-equivalence');
 const omitted=normalizeTestClaimCatalog({...base,files:[{...base.files[0],assertionIds:['a0']}],assertions:[assertions[0]],claims:[{id:'one',originalClaim:'one',equivalenceRationale:'one',assertionIds:['a0'],parityClaimIds:['proof-a'],productionSourceIds:['src/owner.ts']}]});const omittedRecord=await buildTestClaimDecisionRecord(root,graph(),omitted,parity) as any;assert.equal(omittedRecord.population.supportedDiscoveryComplete,false);assert.match(omittedRecord.population.problems.join('\n'),/omits assertion/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('fake or shadowed source readers and wrong relationships cannot self-certify',async()=>{
 const cases=[
  `import {expect} from 'vitest';\nconst tools=fake.readFileSync('src/owner.ts','utf8');\nexpect(tools).toContain("'tool_a'");`,
  `import {expect} from 'vitest';\nimport {readFileSync} from 'node:fs';\nfunction check(readFileSync:any){const tools=readFileSync('src/owner.ts','utf8');expect(tools).toContain("'tool_a'");}`,
  `import {expect} from 'vitest';\nimport {readFileSync} from 'node:fs';\nconst tools=(readFileSync('src/owner.ts','utf8'),'different');\nexpect(tools).toContain("'tool_a'");`,
  `import {expect} from 'vitest';\nimport {readFileSync} from 'node:fs';\nconst tools=readFileSync(selectOtherPath('src/owner.ts'),'utf8');\nexpect(tools).toContain("'tool_a'");`,
  `import {expect} from 'vitest';\nimport {readFileSync} from 'node:fs';\ntry{}catch(readFileSync){const tools=readFileSync('src/owner.ts','utf8');expect(tools).toContain("'tool_a'");}`,
  `import {expect} from 'vitest';\nimport {readFileSync} from 'node:fs';\nfor(const readFileSync of readers){const tools=readFileSync('src/owner.ts','utf8');expect(tools).toContain("'tool_a'");}`,
  `import {expect} from 'vitest';\nimport {readFileSync} from 'node:fs';\nconst tools=readFileSync('src/owner.ts','utf8');\nfunction check(expect:any){expect(tools).toContain("'tool_a'");}`,
  `import {expect} from './custom-checker';\nimport {readFileSync} from 'node:fs';\nconst tools=readFileSync('src/owner.ts','utf8');\nexpect(tools).toContain("'tool_a'");`,
  `import {expect} from 'vitest';\nimport {readFileSync} from 'node:fs';\nconst tools=readFileSync('src/owner.ts','hex');\nexpect(tools).toContain("'tool_a'");`
 ];
 for(const source of cases){const root=await fs.mkdtemp(path.join(os.tmpdir(),'di-claims-'));try{await fs.mkdir(path.join(root,'tests'));await fs.mkdir(path.join(root,'src'));await fs.writeFile(path.join(root,'src/owner.ts'),"registerTool('tool_a');\n");await fs.writeFile(path.join(root,'tests/example.test.ts'),source);const expression=`expect(tools).toContain("'tool_a'")`;const start=source.indexOf(expression);const catalog=normalizeTestClaimCatalog({version:1,revision,analyzerVersion:'inventory-test',scope:{sourcePrefixes:['tests/'],sourceSuffixes:['.test.ts']},files:[{sourceId:'tests/example.test.ts',contentSha256:sha(source),declarationIds:[],assertionIds:['a'],disposition:'analyzed'}],declarations:[],assertions:[{id:'a',sourceId:'tests/example.test.ts',start,end:start+expression.length,spanSha256:sha(expression),dynamic:false}],claims:[{id:'claim',originalClaim:'registration',equivalenceRationale:'must have proven source origin',assertionIds:['a'],parityClaimIds:['proof'],productionSourceIds:['src/owner.ts']}]});const predicate={id:'proof',type:'reachability',from:{ids:['mcp:tool_a']},to:{kinds:['mcp-tool'],sourceIds:['repo:src/owner.ts']},requirement:'required',quantifier:'any',direction:'outbound',relationshipKinds:['registered-as'],maxDepth:1,scopeSourceIds:['src/owner.ts']};const parity=[{id:'proof',status:'satisfied',qualified:true,replacementEligible:true,predicate,matched:{subjects:['mcp:tool_a'],targets:['tool:tool_a']}}];const record=await buildTestClaimDecisionRecord(root,graph(),catalog,parity) as any;assert.notEqual(record.claims[0].outcome,'equivalent');
 const wrong=await buildTestClaimDecisionRecord(root,graph(),catalog,[{...parity[0],predicate:{...predicate,relationshipKinds:['calls']}}]) as any;assert.notEqual(wrong.claims[0].outcome,'equivalent');}finally{await fs.rm(root,{recursive:true,force:true});}}
});

test('lexical modality hints stay non-factual and dynamic inventory is explicit',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'di-claims-'));try{await fs.mkdir(path.join(root,'tests'));const source=`import {expect,test} from 'vitest';\ntest.skip('runs',async()=>{expect('fetch concurrency browser').toBeTruthy();});`;await fs.writeFile(path.join(root,'tests/example.test.ts'),source);const assertion=`expect('fetch concurrency browser').toBeTruthy()`;const assertionStart=source.indexOf(assertion);const declarationStart=source.indexOf(`test.skip`);const declarationEnd=source.lastIndexOf(')')+1;const input={version:1,revision,analyzerVersion:'inventory-test',scope:{sourcePrefixes:['tests/'],sourceSuffixes:['.test.ts']},files:[{sourceId:'tests/example.test.ts',contentSha256:sha(source),declarationIds:['d'],assertionIds:['a'],disposition:'analyzed'}],declarations:[{id:'d',sourceId:'tests/example.test.ts',start:declarationStart,end:declarationEnd,spanSha256:sha(source.slice(declarationStart,declarationEnd)),dynamic:true}],assertions:[{id:'a',sourceId:'tests/example.test.ts',start:assertionStart,end:assertionStart+assertion.length,spanSha256:sha(assertion),dynamic:true}],claims:[{id:'runtime',originalClaim:'health request executes',equivalenceRationale:'text alone cannot prove runtime protection',assertionIds:['a'],parityClaimIds:[],productionSourceIds:['src/owner.ts']}]};const catalog=normalizeTestClaimCatalog(input);const record=await buildTestClaimDecisionRecord(root,graph(),catalog,[]) as any;assert.equal(record.population.supportedDiscoveryComplete,true,JSON.stringify(record.population));assert.equal(record.population.wholeLanguageComplete,false);assert.equal(record.assertions[0].modality,'unknown');assert.equal(record.assertions[0].modalityHint,'execution');assert.equal(record.assertions[0].modalityHintProvenance,'lexical-text-heuristic');assert.equal(record.claims[0].outcome,'unclassified');const unsupported=normalizeTestClaimCatalog({...input,files:[{...input.files[0],disposition:'unsupported',reason:'dynamic syntax is not classified'}]});const unsupportedRecord=await buildTestClaimDecisionRecord(root,graph(),unsupported,[]) as any;assert.equal(unsupportedRecord.population.supportedDiscoveryComplete,false);assert.deepEqual(unsupportedRecord.population.unsupportedFiles,['tests/example.test.ts']);}finally{await fs.rm(root,{recursive:true,force:true});}});

test('native discovery separates cases, hooks, matcher constructors, and bound node assertions',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'di-claims-'));try{await fs.mkdir(path.join(root,'tests'));const declaration=`test.each([1])('case',(n)=>{expect(n).toEqual(expect.objectContaining({value:n}));assert(n);})`;const expectation=`expect(n).toEqual(expect.objectContaining({value:n}))`;const directAssert=`assert(n)`;const source=`import assert from 'node:assert/strict';\nimport {expect,test} from 'vitest';\ntest.describe('suite',()=>{});test.beforeEach(()=>{});test.info();\n${declaration};`;await fs.writeFile(path.join(root,'tests/example.test.ts'),source);const declarationStart=source.indexOf(declaration);const expectationStart=source.indexOf(expectation);const assertStart=source.indexOf(directAssert);const catalog=normalizeTestClaimCatalog({version:1,revision,analyzerVersion:'inventory-test',scope:{sourcePrefixes:['tests/'],sourceSuffixes:['.test.ts']},files:[{sourceId:'tests/example.test.ts',contentSha256:sha(source),declarationIds:['d'],assertionIds:['expect','assert'],disposition:'analyzed'}],declarations:[{id:'d',sourceId:'tests/example.test.ts',start:declarationStart,end:declarationStart+declaration.length,spanSha256:sha(declaration),dynamic:true}],assertions:[{id:'expect',sourceId:'tests/example.test.ts',start:expectationStart,end:expectationStart+expectation.length,spanSha256:sha(expectation),dynamic:false},{id:'assert',sourceId:'tests/example.test.ts',start:assertStart,end:assertStart+directAssert.length,spanSha256:sha(directAssert),dynamic:false}],claims:[]});const record=await buildTestClaimDecisionRecord(root,graph(),catalog,[]) as any;assert.equal(record.population.supportedDiscoveryComplete,true,JSON.stringify(record.population));assert.deepEqual(record.population.problems,[]);assert.equal(record.assertions.length,2);}finally{await fs.rm(root,{recursive:true,force:true});}});

test('extension-aware parsing accepts TS generics and TSX while malformed recovery stays untrusted',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'di-claims-'));try{await fs.mkdir(path.join(root,'tests'));const evaluate=async(sourceId:string,source:string,declaration:string,assertion:string)=>{await fs.writeFile(path.join(root,...sourceId.split('/')),source);const g=graph();g.coverage!.files[0]!.path=sourceId;const declarationStart=source.indexOf(declaration);const assertionStart=source.indexOf(assertion);const catalog=normalizeTestClaimCatalog({version:1,revision,analyzerVersion:'inventory-test',scope:{sourcePrefixes:['tests/'],sourceSuffixes:[path.extname(sourceId)]},files:[{sourceId,contentSha256:sha(source),declarationIds:['d'],assertionIds:['a'],disposition:'analyzed'}],declarations:[{id:'d',sourceId,start:declarationStart,end:declarationStart+declaration.length,spanSha256:sha(declaration),dynamic:false}],assertions:[{id:'a',sourceId,start:assertionStart,end:assertionStart+assertion.length,spanSha256:sha(assertion),dynamic:false}],claims:[]});return buildTestClaimDecisionRecord(root,g,catalog,[]) as any;};const tsDeclaration=`test('generic',()=>{expect(deferred<number>()).toBe(1);})`;const tsAssertion=`expect(deferred<number>()).toBe(1)`;const tsSource=`import {expect,test} from 'vitest';const deferred=<T>()=>1;${tsDeclaration};`;const tsRecord=await evaluate('tests/example.test.ts',tsSource,tsDeclaration,tsAssertion);assert.deepEqual(tsRecord.population.problems,[]);assert.equal(tsRecord.nativeObligations.length,1);const tsxDeclaration=`test('tsx',()=>{expect(<div/>).toBeTruthy();})`;const tsxAssertion=`expect(<div/>).toBeTruthy()`;const tsxSource=`import {expect,test} from 'vitest';const deferred=<T,>()=>1;${tsxDeclaration};`;const tsxRecord=await evaluate('tests/example.test.tsx',tsxSource,tsxDeclaration,tsxAssertion);assert.deepEqual(tsxRecord.population.problems,[]);assert.equal(tsxRecord.nativeObligations.length,1);const malformed=`import {expect,test} from 'vitest';test('broken',()=>{expect(1).toBe(1);`;await fs.writeFile(path.join(root,'tests/example.test.ts'),malformed);const g=graph();const malformedCatalog=normalizeTestClaimCatalog({version:1,revision,analyzerVersion:'inventory-test',scope:{sourcePrefixes:['tests/'],sourceSuffixes:['.test.ts']},files:[{sourceId:'tests/example.test.ts',contentSha256:sha(malformed),declarationIds:[],assertionIds:[],disposition:'analyzed'}],declarations:[],assertions:[],claims:[]});const malformedRecord=await buildTestClaimDecisionRecord(root,g,malformedCatalog,[]) as any;assert.match(malformedRecord.population.problems.join('\n'),/parse diagnostics; recovered AST inventory is not trusted/u);assert.equal(malformedRecord.population.supportedDiscoveryComplete,false);assert.equal(malformedRecord.nativeObligations.length,0);}finally{await fs.rm(root,{recursive:true,force:true});}});

test('local assert-like guards remain explicit unsupported candidates',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'di-claims-'));try{await fs.mkdir(path.join(root,'tests'));const guard=`assert(value,'local guard')`;const source=`const assert=(condition,message)=>{if(!condition)throw new Error(message);};\nconst value=true;${guard};`;await fs.writeFile(path.join(root,'tests/example.test.ts'),source);const start=source.indexOf(guard);const catalog=normalizeTestClaimCatalog({version:1,revision,analyzerVersion:'inventory-test',scope:{sourcePrefixes:['tests/'],sourceSuffixes:['.test.ts']},files:[{sourceId:'tests/example.test.ts',contentSha256:sha(source),declarationIds:[],assertionIds:['guard'],disposition:'analyzed'}],declarations:[],assertions:[{id:'guard',sourceId:'tests/example.test.ts',start,end:start+guard.length,spanSha256:sha(guard),dynamic:false}],claims:[]});const record=await buildTestClaimDecisionRecord(root,graph(),catalog,[]) as any;assert.equal(record.nativeObligations.length,0);assert.equal(record.assertions[0].discovered,true);assert.equal(record.assertions[0].established,false);assert.match(record.assertions[0].blocker,/custom local assert guard/u);assert.deepEqual(record.population.problems,[]);assert.equal(record.population.supportedDiscoveryComplete,true);const missingCatalog=normalizeTestClaimCatalog({version:1,revision,analyzerVersion:'inventory-test',scope:{sourcePrefixes:['tests/'],sourceSuffixes:['.test.ts']},files:[{sourceId:'tests/example.test.ts',contentSha256:sha(source),declarationIds:[],assertionIds:[],disposition:'analyzed'}],declarations:[],assertions:[],claims:[]});const missingRecord=await buildTestClaimDecisionRecord(root,graph(),missingCatalog,[]) as any;assert.match(missingRecord.population.problems.join('\n'),/omits unsupported assertion site/u);assert.equal(missingRecord.population.supportedDiscoveryComplete,false);}finally{await fs.rm(root,{recursive:true,force:true});}});

test('Playwright browser-shaped subjects remain heuristic without binding evidence',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'di-claims-'));try{await fs.mkdir(path.join(root,'tests'));const declaration=`test('opens',async({page})=>{test.skip(!process.env.PROOF,'local only');await expect(page.getByRole('main')).toBeVisible();expect(1).toBe(1);})`;const fakeAssertion=`expect(page).toBe(1)`;const browserAssertion=`expect(page.getByRole('main')).toBeVisible()`;const valueAssertion=`expect(1).toBe(1)`;const source=`import {expect,test} from '@playwright/test';\nconst page=1;${fakeAssertion};\ntest.describe('browser',()=>{});test.beforeEach(async()=>{});\n${declaration};`;await fs.writeFile(path.join(root,'tests/example.test.ts'),source);const declarationStart=source.indexOf(declaration);const browserStart=source.indexOf(browserAssertion);const valueStart=source.indexOf(valueAssertion);const fakeStart=source.indexOf(fakeAssertion);const catalog=normalizeTestClaimCatalog({version:1,revision,analyzerVersion:'inventory-test',scope:{sourcePrefixes:['tests/'],sourceSuffixes:['.test.ts']},files:[{sourceId:'tests/example.test.ts',contentSha256:sha(source),declarationIds:['d'],assertionIds:['browser','value','fake'],disposition:'analyzed'}],declarations:[{id:'d',sourceId:'tests/example.test.ts',start:declarationStart,end:declarationStart+declaration.length,spanSha256:sha(declaration),dynamic:false}],assertions:[{id:'browser',sourceId:'tests/example.test.ts',start:browserStart,end:browserStart+browserAssertion.length,spanSha256:sha(browserAssertion),dynamic:false},{id:'value',sourceId:'tests/example.test.ts',start:valueStart,end:valueStart+valueAssertion.length,spanSha256:sha(valueAssertion),dynamic:false},{id:'fake',sourceId:'tests/example.test.ts',start:fakeStart,end:fakeStart+fakeAssertion.length,spanSha256:sha(fakeAssertion),dynamic:false}],claims:[]});const record=await buildTestClaimDecisionRecord(root,graph(),catalog,[]) as any;assert.equal(record.population.supportedDiscoveryComplete,true,JSON.stringify(record.population));assert.equal(record.nativeObligations[0].provider,'@playwright/test');assert.equal(record.nativeObligations.find((item:any)=>item.assertionId==='browser').observationKind,'runtime-value');assert.equal(record.nativeObligations.find((item:any)=>item.assertionId==='browser').observationKindHint,'browser-interaction');assert.equal(record.nativeObligations.find((item:any)=>item.assertionId==='value').observationKind,'runtime-value');assert.equal(record.nativeObligations.find((item:any)=>item.assertionId==='value').observationKindHint,undefined);assert.equal(record.nativeObligations.find((item:any)=>item.assertionId==='fake').observationKind,'runtime-value');assert.equal(record.nativeObligations.find((item:any)=>item.assertionId==='fake').observationKindHint,'browser-interaction');assert.equal(record.nativeObligations[0].executionObserved,false);}finally{await fs.rm(root,{recursive:true,force:true});}});

test('native redundancy preserves exact source-string semantics and trusted provenance',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'di-claims-'));try{await fs.mkdir(path.join(root,'tests'));await fs.mkdir(path.join(root,'src'));const owner="registerTool('tool_a'); // unrelated note: 'tool_x'\n";await fs.writeFile(path.join(root,'src/owner.ts'),owner);const makeInput=(expression:string,analyzerVersion='inventory-test')=>{const source=`import {readFileSync} from 'node:fs';\nimport {expect} from 'vitest';\nconst tools=readFileSync('src/owner.ts','utf8');\n${expression};`;return{source,input:{version:1,revision,analyzerVersion,scope:{sourcePrefixes:['tests/'],sourceSuffixes:['.test.ts']},files:[{sourceId:'tests/example.test.ts',contentSha256:sha(source),declarationIds:[],assertionIds:['a'],disposition:'analyzed'}],declarations:[],assertions:[{id:'a',sourceId:'tests/example.test.ts',start:source.indexOf(expression),end:source.indexOf(expression)+expression.length,spanSha256:sha(expression),dynamic:false}],claims:[]}};};const g=graph();g.nodes.push({id:'mcp:tool_x',sourceId:'repo:src/elsewhere.ts',kind:'mcp',locator:'tool_x',name:'tool_x',value:{},raw:'tool_x',layer:'semantic'},{id:'tool:tool_x',sourceId:'repo:src/elsewhere.ts',kind:'mcp-tool',locator:'tool_x',name:'tool_x',value:{},raw:'tool_x',layer:'semantic'});g.edges.push({id:'registration-x',from:'mcp:tool_x',to:'tool:tool_x',kind:'registered-as',strategy:'declared',confidence:1,status:'resolved',evidence:[],layer:'semantic'});
 const forbidden=makeInput(`expect(tools).not.toContain("'tool_x'")`);await fs.writeFile(path.join(root,'tests/example.test.ts'),forbidden.source);const forbiddenRecord=await buildTestClaimDecisionRecord(root,g,normalizeTestClaimCatalog(forbidden.input),[]) as any;assert.equal(forbiddenRecord.nativeObligations[0].sourceCondition.satisfied,false);assert.equal(forbiddenRecord.nativeObligations[0].currentObservationOverlap,false);
 const quoteMismatch=makeInput(`expect(tools).toContain('"tool_a"')`);await fs.writeFile(path.join(root,'tests/example.test.ts'),quoteMismatch.source);const quoteCatalog=normalizeTestClaimCatalog({...quoteMismatch.input,claims:[{id:'quote',originalClaim:'exact double-quoted spelling',equivalenceRationale:'registration is only an interpretation',assertionIds:['a'],parityClaimIds:['proof-a'],productionSourceIds:['src/owner.ts']}]});const quoteRecord=await buildTestClaimDecisionRecord(root,g,quoteCatalog,[{id:'proof-a',status:'satisfied',qualified:true,replacementEligible:true,predicate:{id:'proof-a',type:'reachability',from:{ids:['mcp:tool_a']},to:{kinds:['mcp-tool'],sourceIds:['repo:src/owner.ts']},requirement:'required',quantifier:'any',direction:'outbound',relationshipKinds:['registered-as'],maxDepth:1,scopeSourceIds:['src/owner.ts']},matched:{subjects:['mcp:tool_a'],targets:['tool:tool_a']}}]) as any;assert.equal(quoteRecord.nativeObligations[0].sourceCondition.satisfied,false);assert.equal(quoteRecord.nativeObligations[0].currentObservationOverlap,false);assert.equal(quoteRecord.claims[0].staticReplacementEquivalent,false);assert.equal(quoteRecord.claims[0].maintainedCompositeEquivalent,false);
 const drift=makeInput(`expect(tools).toContain("'tool_a'")`,'old-analyzer');await fs.writeFile(path.join(root,'tests/example.test.ts'),drift.source);const driftRecord=await buildTestClaimDecisionRecord(root,g,normalizeTestClaimCatalog(drift.input),[]) as any;assert.equal(driftRecord.nativeObligations[0].sourceCondition.satisfied,true);assert.equal(driftRecord.nativeObligations[0].currentObservationOverlap,false);
 const tampered=makeInput(`expect(tools).toContain("'tool_a'")`);await fs.writeFile(path.join(root,'tests/example.test.ts'),tampered.source);tampered.input.assertions[0]!.spanSha256='0'.repeat(64);const tamperedRecord=await buildTestClaimDecisionRecord(root,g,normalizeTestClaimCatalog(tampered.input),[]) as any;assert.equal(tamperedRecord.nativeObligations.length,0);
 }finally{await fs.rm(root,{recursive:true,force:true});}});

test('native node:test and bound node:assert methods are discovered without accepting shadowed assertions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-node-claims-'));
  try {
    await fs.mkdir(path.join(root, 'tests'));
    const source = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('node assertion inventory', async () => {",
      "  assert.equal(1, 1);",
      "  await assert.rejects(Promise.reject(new Error('expected')));",
      "});",
      "function shadow(assert: { equal(a: number, b: number): void }) { assert.equal(2, 2); }",
      "",
    ].join('\n');
    await fs.writeFile(path.join(root, 'tests', 'example.test.ts'), source);
    const catalog = await generateTestClaimCatalog(root, graph(), { sourcePrefixes: ['tests/'], sourceSuffixes: ['.test.ts'] });
    assert.equal(catalog.declarations.length, 1);
    assert.equal(catalog.assertions.length, 3, 'two bound assertions and one explicit unsupported shadow');
    const report = await buildTestClaimDecisionRecord(root, graph(), catalog, []) as any;
    assert.equal(report.population.supportedDiscoveryComplete, true);
    assert.equal(report.counts.nativeObligations, 2);
    assert.deepEqual(report.nativeObligations.map((item: any) => item.matcher).sort(), ['equal', 'rejects']);
    assert.equal(report.nativeObligations.find((item: any) => item.matcher === 'rejects').observationKind, 'error-behavior');
    assert.equal(report.nativeObligations.every((item: any) => item.executionObserved === false), true);
    assert.equal(report.assertions.filter((item: any) => item.established !== true).length >= 1, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('named imported Node assert aliases remain bound while local lookalikes stay unsupported', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-node-alias-'));
  try {
    await fs.mkdir(path.join(root, 'tests'));
    const source = [
      "import { test as check } from 'node:test';",
      "import { equal as same } from 'node:assert/strict';",
      "import * as verification from 'node:assert/strict';",
      "check('bound aliases', () => { same(3, 3); verification.deepEqual([1], [1]); });",
      "function lookalike(assert: { equal(a: number, b: number): void }) { assert.equal(4, 4); }",
      "",
    ].join('\n');
    await fs.writeFile(path.join(root, 'tests', 'example.test.ts'), source);
    const catalog = await generateTestClaimCatalog(root, graph(), { sourcePrefixes: ['tests/'], sourceSuffixes: ['.test.ts'] });
    assert.equal(catalog.declarations.length, 1);
    assert.equal(catalog.assertions.length, 3);
    const record = await buildTestClaimDecisionRecord(root, graph(), catalog, []) as any;
    assert.deepEqual(record.nativeObligations.map((item: any) => item.matcher).sort(), ['deepEqual', 'equal']);
    assert.equal(record.nativeObligations.every((item: any) => item.executionObserved === false), true);
    assert.equal(record.population.supportedDiscoveryComplete, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('shadowed imported Node assertion aliases cannot become native obligations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-node-shadow-'));
  try {
    await fs.mkdir(path.join(root, 'tests'));
    const source = [
      "import { equal as same } from 'node:assert/strict';",
      "function shadow(same: (a: number, b: number) => void) { same(4, 4); }",
      "",
    ].join('\n');
    await fs.writeFile(path.join(root, 'tests', 'example.test.ts'), source);
    const catalog = await generateTestClaimCatalog(root, graph(), { sourcePrefixes: ['tests/'], sourceSuffixes: ['.test.ts'] });
    assert.equal(catalog.assertions.length, 1);
    const record = await buildTestClaimDecisionRecord(root, graph(), catalog, []) as any;
    assert.equal(record.counts.nativeObligations, 0);
    assert.equal(record.population.supportedDiscoveryComplete, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bare switch CaseBlock declarations shadow imported Node assertions and aliases', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-node-case-'));
  try {
    await fs.mkdir(path.join(root, 'tests'));
    const source = [
      "import assert from 'node:assert/strict';",
      "import { equal as same } from 'node:assert/strict';",
      "switch (kind) {",
      "  case 1:",
      "    const assert = { equal() {} };",
      "    assert.equal(1, 2);",
      "    break;",
      "  case 2:",
      "    const same = (a: number, b: number) => {};",
      "    same(1, 2);",
      "    break;",
      "}",
      "",
    ].join('\n');
    await fs.writeFile(path.join(root, 'tests/example.test.ts'), source);
    const catalog = await generateTestClaimCatalog(root, graph(), { sourcePrefixes: ['tests/'], sourceSuffixes: ['.test.ts'] });
    const report = await buildTestClaimDecisionRecord(root, graph(), catalog, []) as any;
    assert.equal(report.counts.nativeObligations, 0);
    assert.equal(report.population.supportedDiscoveryComplete, true);
    assert.equal(catalog.assertions.length, 2, 'bare switch shadow sites remain explicitly unsupported');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('type-only Node imports never become executable provider identities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-node-type-'));
  try {
    await fs.mkdir(path.join(root, 'tests'));
    const source = [
      "import type assert from 'node:assert/strict';",
      "import { type equal as same } from 'node:assert/strict';",
      "import type * as namespace from 'node:assert/strict';",
      "import type test from 'node:test';",
      "assert.equal(1, 2);",
      "same(1, 2);",
      "namespace.equal(1, 2);",
      "test('erased', () => {});",
      "",
    ].join('\n');
    await fs.writeFile(path.join(root, 'tests/example.test.ts'), source);
    const catalog = await generateTestClaimCatalog(root, graph(), { sourcePrefixes: ['tests/'], sourceSuffixes: ['.test.ts'] });
    const report = await buildTestClaimDecisionRecord(root, graph(), catalog, []) as any;
    assert.equal(catalog.declarations.length, 0);
    assert.equal(report.counts.nativeObligations, 0);
    assert.equal(catalog.assertions.length, 3, 'erased assert call sites remain explicitly unsupported');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('namespace object Node assert supports member calls but not direct invocation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-node-namespace-'));
  try {
    await fs.mkdir(path.join(root, 'tests'));
    const source = [
      "import * as verification from 'node:assert/strict';",
      "verification.equal(1, 1);",
      "verification(1);",
      "",
    ].join('\n');
    await fs.writeFile(path.join(root, 'tests/example.test.ts'), source);
    const catalog = await generateTestClaimCatalog(root, graph(), { sourcePrefixes: ['tests/'], sourceSuffixes: ['.test.ts'] });
    const report = await buildTestClaimDecisionRecord(root, graph(), catalog, []) as any;
    assert.deepEqual(report.nativeObligations.map((item: any) => item.matcher), ['equal']);
    assert.equal(catalog.assertions.length, 2, 'direct namespace invocation remains an unsupported site');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Node loose and strict comparison providers survive native claim output, including strict aliases', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-node-comparison-'));
  try {
    await fs.mkdir(path.join(root, 'tests'));
    const source = [
      "import loose from 'node:assert';",
      "import strict from 'node:assert/strict';",
      "import { strict as strictAlias, equal as looseEqual } from 'node:assert';",
      "import { equal as strictEqualAlias } from 'node:assert/strict';",
      "import * as strictNamespace from 'node:assert/strict';",
      "loose.equal(1, '1');",
      "strict.equal(1, '1');",
      "strictAlias.deepEqual({a:1}, {a:'1'});",
      "looseEqual(1, '1');",
      "strictEqualAlias(1, '1');",
      "strictNamespace.deepEqual({a:1}, {a:'1'});",
      "loose.strictEqual(1, '1');",
      "",
    ].join('\n');
    await fs.writeFile(path.join(root, 'tests', 'example.test.ts'), source);
    const catalog = await generateTestClaimCatalog(root, graph(), { sourcePrefixes: ['tests/'], sourceSuffixes: ['.test.ts'] });
    const report = await buildTestClaimDecisionRecord(root, graph(), catalog, []) as any;
    assert.equal(report.evaluatorVersion, '1.3.0');
    assert.equal(report.counts.nativeObligations, 7);
    const byExpression = new Map(report.nativeObligations.map((obligation: any) => {
      const assertion = catalog.assertions.find(item => item.id === obligation.assertionId)!;
      return [source.slice(assertion.start, assertion.end), obligation];
    })) as Map<string, any>;
    for (const [expression, expectedProvider, expectedSemantics] of [
      ["loose.equal(1, '1')", 'node:assert', 'loose'],
      ["strict.equal(1, '1')", 'node:assert/strict', 'strict'],
      ["strictAlias.deepEqual({a:1}, {a:'1'})", 'node:assert/strict', 'strict'],
      ["looseEqual(1, '1')", 'node:assert', 'loose'],
      ["strictEqualAlias(1, '1')", 'node:assert/strict', 'strict'],
      ["strictNamespace.deepEqual({a:1}, {a:'1'})", 'node:assert/strict', 'strict'],
      ["loose.strictEqual(1, '1')", 'node:assert', 'strict'],
    ]) {
      const observation = byExpression.get(expression);
      assert.ok(observation, expression);
      assert.equal(observation.provider, expectedProvider, expression);
      assert.equal(observation.comparisonSemantics, expectedSemantics, expression);
      assert.equal(observation.executionObserved, false, expression);
    }
    assert.equal(report.population.supportedDiscoveryComplete, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
