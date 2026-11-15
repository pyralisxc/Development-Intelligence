import assert from 'node:assert/strict';
import test from 'node:test';
import { planInvestigationQuestion } from '../src/intelligence/workbench.js';

test('actual engineering audit and self bottleneck questions use repository audit',()=>{
  for(const text of [
    'Audit CardForge: what areas need a developer to investigate and why?',
    'Audit Development Intelligence and tell me which areas need developer attention and why',
    'Where is DI struggling with code understanding?',
    'What are the biggest analyzer bottlenecks in this repo?',
  ]) assert.equal(planInvestigationQuestion({text}).lane,'repository-audit',text);
});
test('specific code/test questions do not get hijacked by a broad audit',()=>{
  for(const text of [
    'Which tests cover cardforgeMiddleware?',
    'Under what conditions does authorizeOwnerWrite call authorize?',
    'What does buildRepositoryGraph do?',
  ]) assert.notEqual(planInvestigationQuestion({text}).lane,'repository-audit',text);
});
