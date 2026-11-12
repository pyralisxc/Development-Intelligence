import { graphContext } from './service.js';
import { withResolvedProjectCheckout } from '../source/git.js';
import { buildTestClaimDecisionRecord, generateTestClaimCatalog } from './testClaimInventory.js';
import { projectTestClaimDecisionPage } from './testClaimReport.js';
import { deriveSourceExecutionFacts } from './sourceExecutionFacts.js';

export async function queryTestClaimReport(input: {
  project: string;
  ref?: string;
  graphId?: string;
  sourcePrefixes: string[];
  sourceSuffixes: string[];
  page?: number;
  pageSize?: number;
  expectedReportDigest?: string;
  populationDetail?: 'full' | 'summary';
}): Promise<Record<string, unknown>> {
  if (input.ref && !/^commit:[0-9a-f]{40}$/iu.test(input.ref)) throw new Error('test claim source ref must be an immutable commit:<full-sha> selector');
  if (!input.ref && !input.graphId) throw new Error('test claim reads require an immutable source ref or graphId');
  if (!input.sourcePrefixes.length || !input.sourceSuffixes.length) throw new Error('test claim reads require non-empty sourcePrefixes and sourceSuffixes');
  const page = input.page ?? 0;
  const pageSize = input.pageSize ?? 100;
  if (!Number.isInteger(page) || page < 0) throw new Error('page must be a non-negative integer');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('pageSize must be an integer from 1 through 500');
  if (page > 0 && !input.expectedReportDigest) throw new Error('expectedReportDigest is required after the first page');
  const context = await graphContext(input.project, {
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.graphId ? { graphId: input.graphId } : {}),
  });
  return await withResolvedProjectCheckout(context.revision, async checkout => {
    const catalog = await generateTestClaimCatalog(checkout.root, context.graph, { sourcePrefixes: input.sourcePrefixes, sourceSuffixes: input.sourceSuffixes });
    const report = await buildTestClaimDecisionRecord(
      checkout.root,
      context.graph,
      catalog,
      [],
    ) as Record<string, any>;
    const executionFacts = await deriveSourceExecutionFacts(checkout.root, catalog, context.graph.graphId);
    const producerCommit = [process.env.DEVINT_BUILD_SHA, process.env.VERCEL_GIT_COMMIT_SHA]
      .map(value => value?.trim().toLowerCase()).find(value => value && /^[0-9a-f]{40}$/u.test(value)) ?? null;
    if (!producerCommit) throw new Error('test claim agent reads require an exact deployed DI producer commit');
    const projection = projectTestClaimDecisionPage({
        report,
        catalog,
        producerCommit,
        page,
        pageSize,
        ...(input.populationDetail ? { populationDetail: input.populationDetail } : {}),
      });
    const reportDigest = String((projection as any).identity?.projectionSha256 ?? '');
    if (input.expectedReportDigest && input.expectedReportDigest !== reportDigest) throw new Error('test claim report digest does not match the requested immutable page identity');
    const pageItems: any[] = Array.isArray(projection.items) ? projection.items : [];
    const pageAssertionIds = new Set(pageItems
      .filter((item: any) => item.kind === 'assertion').map((item: any) => item.id));
    const pageExecutionFacts = executionFacts.facts.filter(f => pageAssertionIds.has(f.assertionId));
    return {
      ...projection,
      sourceExecutionFacts: {
        strategy: executionFacts.strategy, revision: executionFacts.revision,
        graphId: executionFacts.graphId, factsSha256: executionFacts.factsSha256,
        counts: executionFacts.counts, items: pageExecutionFacts,
        returned: pageExecutionFacts.length, total: executionFacts.facts.length,
        note: 'Source success-path proofs are independent of runtime observations; a passing run must be supplied separately.',
        policy: executionFacts.policy,
      },
      source: {
        scope: catalog.scope,
        catalogMode: 'derived-from-exact-source',
        historicalReceipt: 'Optional action artifacts retain immutable CI history; this response derives and evaluates source facts directly from the selected exact revision.',
      },
    };
  });
}
