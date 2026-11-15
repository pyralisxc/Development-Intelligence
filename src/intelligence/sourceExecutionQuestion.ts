/** Ordinary execution questions reuse the existing source-only test claim projection. */
export type SourceExecutionQuestion =
  | { mode: 'file'; path: string }
  | { mode: 'repository' }
  | { mode: 'ambiguous' }
  | { mode: 'invalid' };

const TEST_PATH = /(?:^|[\s"'\x60([{:])([A-Za-z0-9_./-]+\.(?:test|spec)\.(?:[cm]?[jt]sx?))(?=$|[\s"'\x60)\]},;:?!])/gu;
export const SOURCE_EXECUTION_TEST_SUFFIXES = [
  '.test.ts', '.test.tsx', '.test.js', '.test.mjs', '.test.cjs',
  '.spec.ts', '.spec.tsx', '.spec.js', '.spec.mjs', '.spec.cjs',
] as const;

export function parseSourceExecutionQuestion(question: string): SourceExecutionQuestion | null {
  if (question.length > 1000) return null;
  const sourceSubject = /\b(?:assertions?|test claims?|execution[- ]facts?)\b/iu.test(question);
  const sourceReach = /\b(?:must[- ]on[- ]success|mandatory|source[- ]derived|execution[- ]facts?)\b/iu.test(question)
    || /\bmust\b[^?.!]{0,55}\b(?:execute|run|evaluate)\b/iu.test(question);
  const actualQuestion = /\b(?:which|what|how many|count|show|list|summarize|summary)\b/iu.test(question);
  if (!sourceSubject || !sourceReach || !actualQuestion) return null;
  const paths = [...new Set([...question.matchAll(TEST_PATH)].map(match => match[1]!))];
  if (paths.length > 1) return { mode: 'ambiguous' };
  if (paths.length === 1) {
    const path = paths[0]!;
    if (path.startsWith('/') || path.startsWith('-') || path.includes('\\')
      || path.split('/').some(part => !part || part === '.' || part === '..')) return { mode: 'invalid' };
    return { mode: 'file', path };
  }
  return /\b(?:source[- ]derived|must[- ]on[- ]success|execution[- ]facts?|(?:this|the|our)\s+(?:repository|repo|project|codebase))\b/iu.test(question)
    ? { mode: 'repository' } : null;
}

interface SourceFactRow {
  assertionId: string;
  locator: string;
  sourceReach: string;
  sourceReason: string;
  testDeclarationId: string | null;
  inferredExecution: string;
}
interface SourceFactReport {
  available?: boolean;
  identity?: { sourceRevision?: string; graphId?: string };
  counts?: { files?: number; assertions?: number; nativeExecutionObserved?: number };
  sourceExecutionFacts?: {
    strategy?: string;
    sourceFactsSha256?: string;
    counts?: { assertions?: number; sourceMust?: number; sourceMay?: number;
      sourceNever?: number; sourceUnknown?: number; insideReportedPass?: number };
    items?: SourceFactRow[];
    returned?: number;
    total?: number;
  };
}

export function sourceExecutionQuestionAnswer(request: SourceExecutionQuestion,
  report?: SourceFactReport): { status: 'supported' | 'unproven'; answer: string; result: Record<string, unknown> } {
  if (request.mode === 'ambiguous' || request.mode === 'invalid') {
    const reason = request.mode === 'ambiguous' ? 'multiple-test-files' : 'unsafe-source-path';
    return { status: 'unproven',
      answer: request.mode === 'ambiguous'
        ? 'Multiple test files were named; a single exact file is required before execution facts can be attributed.'
        : 'The requested test path is not a safe repository-relative source identity.',
      result: { mode: 'source-execution-facts', reason, sourceOnly: true } };
  }
  const facts = report?.sourceExecutionFacts;
  const counts = facts?.counts;
  const file = request.mode === 'file' ? request.path : null;
  if (!report?.available || !counts || (file && report.counts?.files !== 1)) {
    return { status: 'unproven',
      answer: file ? `No eligible, uniquely tracked test source was found for ${file}; this does not establish that a test or assertion is absent.`
        : 'Source execution facts are not available for this exact graph and supported test scope.',
      result: { mode: 'source-execution-facts', reason: 'source-or-facts-unavailable', file, sourceOnly: true } };
  }
  const must = counts.sourceMust ?? 0, may = counts.sourceMay ?? 0;
  const never = counts.sourceNever ?? 0, unknown = counts.sourceUnknown ?? 0;
  const total = counts.assertions ?? 0;
  const examples = (facts.items ?? []).filter(f => f.sourceReach === 'must-on-success')
    .slice(0, 12).map(f => ({ id: f.assertionId, locator: f.locator,
      testDeclarationId: f.testDeclarationId, sourceReason: f.sourceReason }));
  const scope = file ?? 'tracked tests/ and scripts/ matching .test.ts or .test.mjs';
  const samples = examples.length ? ` Examples of mandatory assertion source locations: ${examples.map(f => f.locator).join('; ')}.` : '';
  const paging = (facts.returned ?? 0) < (facts.total ?? 0)
    ? ' The source-location examples are sampled from one bounded report page, not the complete population.' : '';
  const answer = `At revision ${report.identity?.sourceRevision ?? 'unavailable'}, within ${scope}, `
    + `${must} of ${total} supported source assertions are proven to be evaluated on every modeled successful completion path; `
    + `${may} may execute, ${never} cannot occur on a modeled successful path, and ${unknown} remain unknown.`
    + samples + paging
    + ' These are conditional facts from current source, not observations of test execution. '
    + 'No authenticated run evidence was attached to this source-only read; zero observed here does not mean no tests ran. '
    + 'Passing assertions, real provider effects, and independent test replacement are not established.';
  return { status: 'supported', answer,
    result: { mode: 'source-execution-facts', sourceOnly: true,
      revision: report.identity?.sourceRevision ?? null, graphId: report.identity?.graphId ?? null,
      file, scope: file ?? { sourcePrefixes: ['tests/', 'scripts/'],
        sourceSuffixes: ['.test.ts', '.test.mjs'] },
      strategy: facts.strategy ?? null, sourceFactsSha256: facts.sourceFactsSha256 ?? null,
      counts: { assertions: total, sourceMust: must, sourceMay: may,
        sourceNever: never, sourceUnknown: unknown, insideReportedPass: counts.insideReportedPass ?? 0 },
      sampleLocations: examples, samplesReturned: examples.length,
      reportPageAssertionCount: facts.returned ?? 0, completeSample: (facts.returned ?? 0) >= (facts.total ?? 0),
      executionObservedFromThisReport: false, independentReplacementProven: false } };
}
