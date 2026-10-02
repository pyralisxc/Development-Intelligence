import { authorizedInstallationPortfolio } from './installationPortfolio.js';
import { reconcileCanonicalProject } from './canonicalPortfolio.js';
import { bootstrapSemanticPromotionBaseline, semanticReviewSurface } from './semanticWorkflow.js';
import type { SemanticReviewActor } from './semanticReview.js';

interface PortfolioCandidateLike {
  id?: unknown;
  proposal?: { name?: unknown; kind?: unknown };
  scope?: unknown;
  reviewAssessment?: { supported?: unknown; factuality?: unknown; classification?: unknown };
}

export function selectSupportedSemanticPortfolioCandidates(candidates: PortfolioCandidateLike[]): {
  selectedCandidateIds: string[];
  selected: Array<{ id: string; name: string; kind: string; scope: string; classification: string }>;
  unsupportedCandidateIds: string[];
} {
  const selected: Array<{ id: string; name: string; kind: string; scope: string; classification: string }> = [];
  const unsupportedCandidateIds: string[] = [];
  for (const candidate of candidates) {
    const id = typeof candidate.id === 'string' ? candidate.id : '';
    if (!id) continue;
    const supported = candidate.reviewAssessment?.supported === true
      || candidate.reviewAssessment?.factuality === 'supported';
    if (!supported) {
      unsupportedCandidateIds.push(id);
      continue;
    }
    selected.push({
      id,
      name: typeof candidate.proposal?.name === 'string' ? candidate.proposal.name : id,
      kind: typeof candidate.proposal?.kind === 'string' ? candidate.proposal.kind : 'unknown',
      scope: typeof candidate.scope === 'string' ? candidate.scope : '',
      classification: typeof candidate.reviewAssessment?.classification === 'string'
        ? candidate.reviewAssessment.classification
        : 'unclassified',
    });
  }
  selected.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  unsupportedCandidateIds.sort();
  return {
    selectedCandidateIds: selected.map(item => item.id),
    selected,
    unsupportedCandidateIds,
  };
}

export async function bootstrapSemanticAuthorityPortfolio(input: {
  actor: SemanticReviewActor;
  at: string;
  rationale: string;
  owners?: string[];
  repositories?: string[];
  includeArchived?: boolean;
  limit?: number;
}): Promise<Record<string, unknown>> {
  if (input.actor.kind !== 'human') throw new Error('Portfolio semantic bootstrap requires an explicit human actor');
  if (!input.rationale.trim()) throw new Error('Portfolio semantic bootstrap requires an explicit rationale');
  const portfolio = await authorizedInstallationPortfolio({
    ...(input.owners?.length ? { owners: input.owners } : {}),
    ...(input.repositories?.length ? { repositories: input.repositories } : {}),
  });
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 250);
  const selected = portfolio.selected.slice(0, limit);
  const items: Array<Record<string, unknown>> = [];

  for (const repository of selected) {
    const project = repository.fullName;
    if ((repository.archived || repository.disabled) && input.includeArchived !== true) {
      items.push({
        project,
        revision: null,
        outcome: 'blocked',
        reason: repository.disabled ? 'repository disabled' : 'repository archived',
        acceptedCandidateCount: 0,
      });
      continue;
    }

    try {
      const reconciled = await reconcileCanonicalProject(repository);
      if (reconciled.outcome === 'error' || reconciled.outcome === 'not-configured') {
        items.push({
          project,
          revision: reconciled.revision ?? null,
          outcome: 'blocked',
          reason: reconciled.reason ?? `canonical reconciliation outcome: ${reconciled.outcome}`,
          acceptedCandidateCount: 0,
        });
        continue;
      }

      const surface = await semanticReviewSurface({ project, limit: 1000 }) as any;
      if (surface.authority?.enrollmentState === 'enforced') {
        items.push({
          project,
          revision: surface.revision ?? null,
          outcome: surface.gateExplanation?.acceptedGraphCurrent ? 'already-current' : 'blocked',
          reason: surface.gateExplanation?.acceptedGraphCurrent
            ? 'semantic authority is already enforced and current'
            : 'semantic authority is already enforced but accepted A is not current; use the normal semantic promotion gate',
          acceptedCandidateCount: Number(surface.authority?.recordCount ?? 0),
          gateStatus: surface.promotionAudit?.gateStatus ?? null,
        });
        continue;
      }

      const selection = selectSupportedSemanticPortfolioCandidates(Array.isArray(surface.candidates) ? surface.candidates : []);
      if (selection.unsupportedCandidateIds.length) {
        items.push({
          project,
          revision: surface.revision ?? null,
          outcome: 'blocked',
          reason: 'one or more current semantic candidates are not factually supported',
          unsupportedCandidateIds: selection.unsupportedCandidateIds,
          acceptedCandidateCount: 0,
        });
        continue;
      }

      const result = await bootstrapSemanticPromotionBaseline({
        project,
        candidateIds: selection.selectedCandidateIds,
        actor: input.actor,
        at: input.at,
        rationale: input.rationale,
        expectedDigest: surface.promotionAudit?.digest ?? null,
      }) as any;

      items.push({
        project,
        revision: result.revision ?? surface.revision ?? null,
        outcome: result.state === 'stored' ? 'stored' : 'blocked',
        reason: result.state === 'stored' ? null : `semantic bootstrap state: ${result.state}`,
        acceptedCandidateCount: selection.selectedCandidateIds.length,
        acceptedCandidates: selection.selected,
        enrollmentState: result.enrollmentState ?? null,
        gateStatus: result.gateStatus ?? null,
        acceptedGraphCurrent: result.acceptedGraphCurrent ?? null,
      });
    } catch (error) {
      items.push({
        project,
        revision: null,
        outcome: 'error',
        reason: error instanceof Error ? error.message : String(error),
        acceptedCandidateCount: 0,
      });
    }
  }

  const counts = Object.fromEntries(['stored', 'already-current', 'blocked', 'error'].map(outcome => [
    outcome,
    items.filter(item => item.outcome === outcome).length,
  ]));
  const complete = counts.blocked === 0 && counts.error === 0;
  return {
    owners: portfolio.owners,
    discoveredRepositories: portfolio.discovered.length,
    selectedRepositories: portfolio.selected.length,
    processedRepositories: items.length,
    truncated: portfolio.selected.length > selected.length,
    counts,
    complete,
    items,
    policy: {
      authorityScope: 'per-repository',
      selection: 'all-factually-supported-current-candidates',
      humanAcceptance: true,
      agentBearerCanApplyWithoutExplicitOwnerApproval: false,
      chatOwnerApprovalReferenceSupported: true,
      exactDefaultRevision: true,
      partialProgressAllowed: true,
      unsupportedOrUnreachableRepositoriesMutated: false,
      emptySemanticCensusMayEnroll: true,
      megaAuthorityCreated: false,
    },
  };
}
