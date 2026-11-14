import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { AnalyzeResult } from './model.js';
import { evidenceRecord, observation, resolution } from './model.js';
import type { Observation } from '../types.js';
import { analyzeSourceConditionStatements } from './sourceConditionFacts.js';

/**
 * Adapt the ONE shared TypeScript source-control interpreter into canonical W
 * source facts. This stores AST occurrences; it makes no runtime assertion.
 * The graph owns source evidence, while this module owns only extraction.
 */
const proofRule = 'typescript-source-control-graph.v1';
const sourceDigest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export function buildSourceConditionGraphFacts(input: {
  parsed: ts.SourceFile; sourcePath: string; sourceText: string;
  sourceId: string; owner: Observation; statements: readonly ts.Statement[];
}): AnalyzeResult {
  const { parsed, sourcePath, sourceText, sourceId, owner, statements } = input;
  const parsedSource = parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
  if (parsedSource.parseDiagnostics?.length) return { observations: [], resolutions: [] };
  const lens = analyzeSourceConditionStatements(parsed, sourcePath, statements);
  const observations: Observation[] = [];
  const resolutions: ReturnType<typeof resolution>[] = [];
  const evidence: ReturnType<typeof evidenceRecord>[] = [];
  const analyzed = observation({
    identity: [sourceId, 'source-control-summary', owner.id],
    sourceId, kind: 'source-control-summary', locator: owner.locator,
    name: 'Source control analysis of ' + (owner.name ?? owner.id),
    value: {
      functionId: owner.id, sourceSha256: sourceDigest(sourceText),
      branchTotal: lens.branches.length, effectTotal: lens.effects.length,
      unknownConstructs: lens.unknownConstructs,
      boundedOut: lens.boundedOut,
      completeForSupportedStatements: lens.completeForSupportedStatements,
      sourceOnly: true, runtimeObserved: false,
      proofRule,
    }, layer: 'structural', checkpoint: false,
  });
  observations.push(analyzed);
  resolutions.push(resolution({
    from: owner.id, to: analyzed.id, kind: 'has-source-control',
    strategy: proofRule, status: 'resolved', confidence: 1,
    evidence: [owner.locator], layer: 'structural', checkpoint: false,
  }));
  const byCondition = new Map<string, Observation>();
  for (const branch of lens.branches) {
    const offset = branch.sourceOffset;
    if (typeof offset !== 'number') continue;
    const at = sourcePath + ':' + branch.sourceLine + ':condition-offset-' + offset;
    const proof = evidenceRecord({
      sourceId, kind: 'source-condition-syntax', locator: at,
      field: 'offset:' + offset,
      value: { functionId: owner.id, conditionId: branch.id,
        predicateSha256: branch.predicateSha256, sourceOnly: true,
        runtimeObserved: false },
      message: 'A source guard is syntactically present; predicate truth, execution and complete path feasibility are not proven.',
    });
    const node = observation({
      identity: [sourceId, owner.id, 'source-condition', offset],
      sourceId, kind: 'source-condition', locator: at,
      name: 'Condition in ' + (owner.name ?? owner.id),
      value: { ...branch, functionId: owner.id, sourceOnly: true,
        runtimeObserved: false, proofRule },
      layer: 'structural', checkpoint: false, evidenceIds: [proof.id],
    });
    evidence.push(proof);observations.push(node);byCondition.set(branch.id,node);
    resolutions.push(resolution({
      from: owner.id, to: node.id, kind: 'has-condition',
      strategy: proofRule, status: 'resolved', confidence: 1,
      evidence: [at], evidenceIds: [proof.id],
      layer: 'structural', checkpoint: false,
    }));
  }
  for (const effect of lens.effects) {
    const offset = effect.sourceOffset;
    if (typeof offset !== 'number') continue;
    const at = sourcePath + ':' + effect.sourceLine + ':effect-offset-' + offset;
    const proof = evidenceRecord({
      sourceId, kind: 'source-effect-syntax', locator: at,
      field: 'offset:' + offset,
      value: { functionId: owner.id, effectKind: effect.kind,
        expressionSha256: effect.expressionSha256, sourceOnly: true,
        runtimeObserved: false },
      message: 'An expression, return, throw or write occurs in source; execution, side effects and guard satisfiability are not proven.',
    });
    const node = observation({
      identity: [sourceId, owner.id, 'source-effect', offset, effect.kind],
      sourceId, kind: 'source-effect', locator: at,
      name: 'Source ' + effect.kind + ' in ' + (owner.name ?? owner.id),
      value: { ...effect, functionId: owner.id, sourceOnly: true,
        proofRule },
      layer: 'structural', checkpoint: false, evidenceIds: [proof.id],
    });
    evidence.push(proof);observations.push(node);
    resolutions.push(resolution({
      from: owner.id, to: node.id, kind: 'has-effect',
      strategy: proofRule, status: 'resolved', confidence: 1,
      evidence: [at], evidenceIds: [proof.id],
      layer: 'structural', checkpoint: false,
    }));
    for (const requirement of effect.requiredConditions) {
      const predicate = byCondition.get(requirement.conditionId);
      if (!predicate) continue;
      resolutions.push(resolution({
        from: node.id, to: predicate.id, kind: 'requires-condition',
        strategy: requirement.expectedTruth ? 'source-condition-true' : 'source-condition-false',
        status: 'resolved', confidence: 1, evidence: [at,predicate.locator],
        evidenceIds: [proof.id, ...(predicate.evidenceIds ?? [])],
        layer: 'structural', checkpoint: false,
      }));
    }
  }
  return { observations, resolutions, evidence };
}
