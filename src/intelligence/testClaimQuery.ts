import { graphContext } from './service.js';
import { withResolvedProjectCheckout } from '../source/git.js';
import { maintainedParityReceipt, readLocalParityContract, readLocalTestClaimCatalog } from './local.js';
import { buildTestClaimDecisionRecord } from './testClaimInventory.js';
import { projectTestClaimDecisionPage } from './testClaimReport.js';

export async function queryTestClaimReport(input: {
  project: string;
  ref?: string;
  graphId?: string;
  catalogPath: string;
  parityContractPath?: string;
  page?: number;
  pageSize?: number;
}): Promise<Record<string, unknown>> {
  const context = await graphContext(input.project, {
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.graphId ? { graphId: input.graphId } : {}),
  });
  return await withResolvedProjectCheckout(context.revision, async checkout => {
    let catalog;
    try {
      catalog = await readLocalTestClaimCatalog(checkout.root, input.catalogPath);
    } catch (error) {
      if (/could not be read.*ENOENT/u.test(error instanceof Error ? error.message : String(error))) {
        return {
          available: false,
          reason: 'missing-validated-catalog',
          project: input.project,
          revision: context.revision.sha,
          graphId: context.graph.graphId,
          catalogPath: input.catalogPath,
        };
      }
      throw error;
    }
    const parity = input.parityContractPath
      ? maintainedParityReceipt(context.graph, await readLocalParityContract(checkout.root, input.parityContractPath)) as any
      : null;
    const report = await buildTestClaimDecisionRecord(
      checkout.root,
      context.graph,
      catalog.catalog,
      parity?.claims ?? [],
    ) as Record<string, any>;
    return {
      ...projectTestClaimDecisionPage({
        report,
        catalog: catalog.catalog,
        ...(input.page !== undefined ? { page: input.page } : {}),
        ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
      }),
      source: {
        catalogPath: catalog.path,
        parityContractPath: input.parityContractPath ?? null,
        historicalReceipt: 'Use the action artifact manifest digest for immutable CI history; this response is an exact-source recomputation.',
      },
    };
  });
}
