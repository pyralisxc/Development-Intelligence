import { createHash } from 'node:crypto';
import type { IntelligenceGraph } from '../types.js';

export type TestClaimModality = 'static-source' | 'execution' | 'browser' | 'concurrency' | 'package-bytes' | 'rendered-artifact' | 'unknown';
export type TestClaimOutcome = 'equivalent' | 'partial-overlap' | 'distinct-protection' | 'unproven-equivalence' | 'unclassified';
interface TestDeclarationInput { id: string; sourceId: string; line: number; title?: string; dynamic: boolean }
interface AssertionInput { id: string; sourceId: string; line: number; column?: number; assertionKind?: string; expression?: string; contextSignals: string[]; dynamic: boolean }
interface ClaimInput { id: string; originalClaim: string; equivalenceRationale: string; assertionIds: string[]; parityClaimIds: string[]; protectionSignals: string[] }
export interface TestClaimCatalog { version: 1; revision: string; analyzerVersion?: string; name?: string; inventory: { declarations: TestDeclarationInput[]; assertions: AssertionInput[] }; claims: ClaimInput[] }
const MAX_RECORDS = 10000; const MAX_TEXT = 2000;

function text(value: unknown, field: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && !value.trim())) throw new Error(`${field} must be a non-empty string`);
  const cleaned = value.trim(); if (cleaned.length > MAX_TEXT) throw new Error(`${field} exceeds ${MAX_TEXT} characters`); return cleaned || undefined;
}
function positiveInteger(value: unknown, field: string): number { if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer`); return Number(value); }
function stringList(value: unknown, field: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0)) throw new Error(`${field} must be ${required ? 'a non-empty' : 'an'} array`);
  return [...new Set(value.map((item, index) => text(item, `${field}[${index}]`, true)!))];
}
function recordList(value: unknown, field: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) throw new Error(`${field} must be an array with at most ${MAX_RECORDS} entries`);
  return value.map((item, index) => { if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${field}[${index}] must be an object`); return item as Record<string, unknown>; });
}
function uniqueIds(records: Array<{ id: string }>, field: string): void { if (new Set(records.map(record => record.id)).size !== records.length) throw new Error(`${field} contains duplicate IDs`); }

export function normalizeTestClaimCatalog(value: unknown): TestClaimCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('test claim catalog must be an object');
  const root = value as Record<string, unknown>; if (root.version !== 1) throw new Error('test claim catalog.version must be 1');
  const revision = text(root.revision, 'test claim catalog.revision', true)!; if (!/^[a-f0-9]{40}$/i.test(revision)) throw new Error('test claim catalog.revision must be an exact 40-character Git SHA');
  if (!root.inventory || typeof root.inventory !== 'object' || Array.isArray(root.inventory)) throw new Error('test claim catalog.inventory must be an object');
  const inventory = root.inventory as Record<string, unknown>;
  const declarations = recordList(inventory.declarations, 'test claim catalog.inventory.declarations').map((item, index): TestDeclarationInput => {
    const title = text(item.title, `test claim catalog.inventory.declarations[${index}].title`);
    return { id: text(item.id, `test claim catalog.inventory.declarations[${index}].id`, true)!, sourceId: text(item.sourceId, `test claim catalog.inventory.declarations[${index}].sourceId`, true)!, line: positiveInteger(item.line, `test claim catalog.inventory.declarations[${index}].line`), ...(title ? { title } : {}), dynamic: item.dynamic === true };
  });
  const assertions = recordList(inventory.assertions, 'test claim catalog.inventory.assertions').map((item, index): AssertionInput => {
    const assertionKind = text(item.assertionKind, `test claim catalog.inventory.assertions[${index}].assertionKind`); const expression = text(item.expression, `test claim catalog.inventory.assertions[${index}].expression`);
    return { id: text(item.id, `test claim catalog.inventory.assertions[${index}].id`, true)!, sourceId: text(item.sourceId, `test claim catalog.inventory.assertions[${index}].sourceId`, true)!, line: positiveInteger(item.line, `test claim catalog.inventory.assertions[${index}].line`), ...(item.column === undefined ? {} : { column: positiveInteger(item.column, `test claim catalog.inventory.assertions[${index}].column`) }), ...(assertionKind ? { assertionKind } : {}), ...(expression ? { expression } : {}), contextSignals: stringList(item.contextSignals, `test claim catalog.inventory.assertions[${index}].contextSignals`), dynamic: item.dynamic === true };
  });
  const claims = recordList(root.claims, 'test claim catalog.claims').map((item, index): ClaimInput => ({ id: text(item.id, `test claim catalog.claims[${index}].id`, true)!, originalClaim: text(item.originalClaim, `test claim catalog.claims[${index}].originalClaim`, true)!, equivalenceRationale: text(item.equivalenceRationale, `test claim catalog.claims[${index}].equivalenceRationale`, true)!, assertionIds: stringList(item.assertionIds, `test claim catalog.claims[${index}].assertionIds`, true), parityClaimIds: stringList(item.parityClaimIds, `test claim catalog.claims[${index}].parityClaimIds`), protectionSignals: stringList(item.protectionSignals, `test claim catalog.claims[${index}].protectionSignals`) }));
  uniqueIds(declarations, 'test claim catalog.inventory.declarations'); uniqueIds(assertions, 'test claim catalog.inventory.assertions'); uniqueIds(claims, 'test claim catalog.claims');
  const analyzerVersion = text(root.analyzerVersion, 'test claim catalog.analyzerVersion'); const name = text(root.name, 'test claim catalog.name');
  return { version: 1, revision: revision.toLowerCase(), ...(analyzerVersion ? { analyzerVersion } : {}), ...(name ? { name } : {}), inventory: { declarations, assertions }, claims };
}

function classify(assertion: AssertionInput): { modality: TestClaimModality; modalitySignals: string[] } {
  if (assertion.dynamic) return { modality: 'unknown', modalitySignals: ['dynamic-or-unclassified'] };
  const observed = `${assertion.expression ?? ''} ${assertion.contextSignals.join(' ')}`;
  const rules: Array<[TestClaimModality, RegExp, string]> = [
    ['browser', /\b(page|locator|browser|playwright|click|drag|keyboard|mouse|browser-interaction)\b/i, 'browser-interaction'],
    ['rendered-artifact', /\b(screenshot|pixel|rendered|snapshot|pdf|rendered-artifact)\b/i, 'rendered-artifact'],
    ['package-bytes', /\b(zip|archive|package|bytes|sha256|hash|buffer|package-bytes)\b/i, 'package-bytes'],
    ['concurrency', /\b(worker|thread|concurrent|race|mutex|lock|concurrency)\b/i, 'concurrency'],
    ['execution', /\b(spawn|exec|fetch|request|invoke|run|execution|workflow-execution)\b/i, 'execution'],
    ['static-source', /\b(source|workflow-source|configuration|registration|static-source)\b/i, 'static-source'],
  ];
  for (const [modality, pattern, signal] of rules) if (pattern.test(observed)) return { modality, modalitySignals: [...new Set([...assertion.contextSignals, signal])] };
  return { modality: 'unknown', modalitySignals: assertion.contextSignals };
}

export function buildTestClaimDecisionRecord(graph: IntelligenceGraph, catalog: TestClaimCatalog, parityClaims: Array<Record<string, any>>): Record<string, unknown> {
  if (!graph.repositoryRevision) throw new Error('test claim inventory requires an exact repository revision');
  if (catalog.revision !== graph.repositoryRevision.toLowerCase()) throw new Error(`test claim catalog revision ${catalog.revision} does not match analyzed revision ${graph.repositoryRevision}`);
  const analyzerCurrent = !catalog.analyzerVersion || catalog.analyzerVersion === graph.analyzerVersion;
  const parityById = new Map(parityClaims.map(claim => [String(claim.id), claim])); const assertionById = new Map(catalog.inventory.assertions.map(assertion => [assertion.id, assertion])); const referenced = new Set<string>();
  const assertions = catalog.inventory.assertions.map(assertion => ({ ...assertion, ...classify(assertion) })); const interpretedById = new Map(assertions.map(assertion => [assertion.id, assertion]));
  const claims = catalog.claims.map(claim => {
    claim.assertionIds.forEach(id => referenced.add(id));
    const matched = claim.assertionIds.map(id => interpretedById.get(id)).filter(Boolean) as typeof assertions; const missingAssertionIds = claim.assertionIds.filter(id => !assertionById.has(id));
    const parity = claim.parityClaimIds.map(id => parityById.get(id)).filter(Boolean) as Array<Record<string, any>>; const missingParityIds = claim.parityClaimIds.filter(id => !parityById.has(id));
    const modalities = [...new Set(matched.map(assertion => assertion.modality))]; const unknown = missingAssertionIds.length > 0 || modalities.includes('unknown');
    const distinct = claim.protectionSignals.length > 0 || modalities.some(modality => modality !== 'static-source' && modality !== 'unknown');
    const parityEquivalent = claim.parityClaimIds.length > 0 && missingParityIds.length === 0 && parity.every(result => result.status === 'satisfied' && result.qualified === true && result.replacementEligible === true);
    let outcome: TestClaimOutcome; if (unknown) outcome = 'unclassified'; else if (distinct && modalities.every(modality => modality !== 'static-source')) outcome = 'distinct-protection'; else if (distinct) outcome = 'partial-overlap'; else if (parityEquivalent && analyzerCurrent) outcome = 'equivalent'; else outcome = 'unproven-equivalence';
    const blockers = [...missingAssertionIds.map(id => `Catalog claim references an unknown assertion: ${id}.`), ...missingParityIds.map(id => `Mapped parity claim was not evaluated: ${id}.`), ...parity.flatMap(result => Array.isArray(result.blockers) ? result.blockers : []), ...(!analyzerCurrent ? [`Catalog analyzer ${catalog.analyzerVersion} does not match ${graph.analyzerVersion}; refresh the claim review.`] : []), ...(modalities.includes('unknown') ? ['At least one assertion is dynamic or unclassified.'] : [])];
    return { id: claim.id, originalClaim: claim.originalClaim, equivalenceRationale: claim.equivalenceRationale, outcome, assertionIds: claim.assertionIds, modalities, protectionSignals: claim.protectionSignals, parityClaimIds: claim.parityClaimIds, parity, blockers: [...new Set(blockers)], staticReplacementEquivalent: outcome === 'equivalent' };
  });
  const unclassified = assertions.filter(assertion => !referenced.has(assertion.id) || assertion.modality === 'unknown').map(assertion => ({ assertionId: assertion.id, outcome: 'unclassified' as const, blocker: !referenced.has(assertion.id) ? 'Assertion has no caller-owned semantic-obligation mapping.' : 'Assertion modality is dynamic or unclassified.' }));
  const counts = { declarations: catalog.inventory.declarations.length, assertions: assertions.length, claims: claims.length, equivalent: claims.filter(claim => claim.outcome === 'equivalent').length, partialOverlap: claims.filter(claim => claim.outcome === 'partial-overlap').length, distinctProtection: claims.filter(claim => claim.outcome === 'distinct-protection').length, unprovenEquivalence: claims.filter(claim => claim.outcome === 'unproven-equivalence').length, unclassified: claims.filter(claim => claim.outcome === 'unclassified').length, unmappedOrUnclassifiedAssertions: unclassified.length };
  const inputFingerprint = createHash('sha256').update(JSON.stringify({ catalog, parityClaims })).digest('hex');
  return { formatVersion: 1, project: graph.project, revision: graph.repositoryRevision, graphId: graph.graphId, analyzerVersion: graph.analyzerVersion, sourceFingerprint: graph.sourceFingerprint, inputFingerprint, catalog: { name: catalog.name ?? null, revision: catalog.revision, analyzerVersion: catalog.analyzerVersion ?? null, current: analyzerCurrent, callerOwned: true, persisted: false }, counts, declarations: catalog.inventory.declarations, assertions, claims, unclassified, policy: { deterministicForExactInputs: true, answerChangesRequireRevisionAnalyzerOrInputChange: true, conditionalRedundancyOnly: true, recommendsDeletion: false, dispositionOwner: 'inspected-project', decisionAuthorityChanged: false, nonStaticEvidenceRemainsDistinct: true } };
}
