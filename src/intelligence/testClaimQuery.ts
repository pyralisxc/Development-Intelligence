import { graphContext } from './service.js';
import { resolveProjectRevision, withResolvedProjectCheckout } from '../source/git.js';
import { maintainedParityReceipt, readLocalParityContract, readLocalTestClaimCatalog } from './local.js';
import { buildTestClaimDecisionRecord } from './testClaimInventory.js';
import { projectTestClaimDecisionPage } from './testClaimReport.js';

export async function queryTestClaimReport(input: {
  project: string;
  ref?: string;
  graphId?: string;
  catalogRef: string;
  catalogPath: string;
  parityContractPath?: string;
  page?: number;
  pageSize?: number;
  expectedReportDigest?: string;
}): Promise<Record<string, unknown>> {
  if (input.ref && !/^commit:[0-9a-f]{40}$/iu.test(input.ref)) throw new Error('test claim source ref must be an immutable commit:<full-sha> selector');
  if (!input.ref && !input.graphId) throw new Error('test claim reads require an immutable source ref or graphId');
  if (!/^commit:[0-9a-f]{40}$/iu.test(input.catalogRef)) throw new Error('test claim catalogRef must be an immutable commit:<full-sha> selector');
  const page = input.page ?? 0;
  const pageSize = input.pageSize ?? 100;
  if (!Number.isInteger(page) || page < 0) throw new Error('page must be a non-negative integer');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('pageSize must be an integer from 1 through 500');
  if (page > 0 && !input.expectedReportDigest) throw new Error('expectedReportDigest is required after the first page');
  const context = await graphContext(input.project, {
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.graphId ? { graphId: input.graphId } : {}),
  });
  const catalogRevision = await resolveProjectRevision(input.project, input.catalogRef);
  return await withResolvedProjectCheckout(context.revision, async checkout => await withResolvedProjectCheckout(catalogRevision, async catalogCheckout => {
    let catalog;
    try {
      catalog = await readLocalTestClaimCatalog(catalogCheckout.root, input.catalogPath);
    } catch (error) {
      if (/could not be read.*ENOENT/u.test(error instanceof Error ? error.message : String(error))) {
        return {
          available: false,
          reason: 'missing-validated-catalog',
          project: input.project,
          revision: context.revision.sha,
          graphId: context.graph.graphId,
          catalogPath: input.catalogPath,
          catalogRevision: catalogRevision.sha,
        };
      }
      throw error;
    }
    const parity = input.parityContractPath
      ? maintainedParityReceipt(context.graph, await readLocalParityContract(catalogCheckout.root, input.parityContractPath)) as any
      : null;
    const report = await buildTestClaimDecisionRecord(
      checkout.root,
      context.graph,
      catalog.catalog,
      parity?.claims ?? [],
    ) as Record<string, any>;
    const producerCommit = [process.env.DEVINT_BUILD_SHA, process.env.VERCEL_GIT_COMMIT_SHA]
      .map(value => value?.trim().toLowerCase()).find(value => value && /^[0-9a-f]{40}$/u.test(value)) ?? null;
    const projection = projectTestClaimDecisionPage({
        report,
        catalog: catalog.catalog,
        producerCommit,
        page,
        pageSize,
      });
    const reportDigest = String((projection as any).identity?.projectionSha256 ?? '');
    if (input.expectedReportDigest && input.expectedReportDigest !== reportDigest) throw new Error('test claim report digest does not match the requested immutable page identity');
    return {
      ...projection,
      source: {
        catalogPath: catalog.path,
        catalogRevision: catalogRevision.sha,
        parityContractPath: input.parityContractPath ?? null,
        historicalReceipt: 'Use the action artifact manifest digest for immutable CI history; this response is an exact-source recomputation.',
      },
    };
  }));
}
