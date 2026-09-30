const DAY_MS = 24 * 60 * 60 * 1000;
const COMMIT_TAG = /^[0-9a-f]{7,40}$/i;

type JsonRecord = Record<string, any>;

function timestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function imageTags(image: JsonRecord): string[] {
  if (Array.isArray(image.tags)) {
    return image.tags
      .map((tag: unknown) => typeof tag === 'string' ? tag : tag && typeof tag === 'object' ? (tag as JsonRecord).name : null)
      .filter((tag: unknown): tag is string => typeof tag === 'string');
  }
  return typeof image.tag === 'string' ? [image.tag] : [];
}

function deploymentSha(deployment: JsonRecord): string | null {
  const value = deployment?.meta?.githubCommitSha ?? deployment?.gitSource?.sha ?? deployment?.sourceRevision;
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function deploymentTime(deployment: JsonRecord): number {
  return timestamp(deployment.createdAt ?? deployment.created);
}

function isProduction(deployment: JsonRecord): boolean {
  return deployment.target === 'production' || deployment?.meta?.target === 'production';
}

function isReady(deployment: JsonRecord): boolean {
  return ['READY', 'ready'].includes(deployment.state ?? deployment.readyState);
}

function deploymentRef(deployment: JsonRecord): string | null {
  const value = deployment?.meta?.githubCommitRef ?? deployment?.gitSource?.ref ?? deployment?.sourceRef;
  return typeof value === 'string' ? value : null;
}

function tagMatchesSha(tag: string, sha: string): boolean {
  return COMMIT_TAG.test(tag) && sha.startsWith(tag.toLowerCase());
}

export interface VcrRetentionOptions {
  images: JsonRecord[];
  deployments: JsonRecord[];
  now?: number;
  limit?: number;
  retainedImageTarget?: number;
  nonProductionDays?: number;
  productionDays?: number;
  rollbackCount?: number;
  previewBranches?: string[];
}

export function planVcrRetention({
  images,
  deployments,
  now = Date.now(),
  limit = 50,
  retainedImageTarget = 10,
  nonProductionDays = 1,
  productionDays = 7,
  rollbackCount = 1,
  previewBranches = ['preview'],
}: VcrRetentionOptions): Record<string, any> {
  const readyProduction = deployments
    .filter(item => isProduction(item) && isReady(item))
    .map(item => ({ item, id: item.uid ?? item.id ?? null, sha: deploymentSha(item), createdAt: deploymentTime(item) }))
    .filter(record => record.id && record.sha)
    .sort((a, b) => b.createdAt - a.createdAt);

  const protectedDeploymentIds = new Set<string>();
  const protectedProductionShas = new Set<string>();
  for (const record of readyProduction) {
    if (protectedProductionShas.has(record.sha!)) continue;
    protectedProductionShas.add(record.sha!);
    protectedDeploymentIds.add(String(record.id));
    if (protectedProductionShas.size >= 1 + rollbackCount) break;
  }

  for (const branch of previewBranches) {
    const latestReadyPreview = deployments
      .filter(item => !isProduction(item) && isReady(item) && deploymentRef(item) === branch)
      .sort((a, b) => deploymentTime(b) - deploymentTime(a))[0];
    const id = latestReadyPreview?.uid ?? latestReadyPreview?.id;
    if (id) protectedDeploymentIds.add(String(id));
  }

  const records = deployments.map(deployment => ({
    deployment,
    id: deployment.uid ?? deployment.id ?? null,
    sha: deploymentSha(deployment),
    production: isProduction(deployment),
    ref: deploymentRef(deployment),
    createdAt: deploymentTime(deployment),
  })).filter(record => record.sha);

  const decisions = images.map(image => {
    const id = image.id ?? image.uid ?? image.imageId ?? image.digest;
    const tags = imageTags(image);
    const createdAt = timestamp(image.createdAt ?? image.created);
    const matches = records.filter(record => tags.some(tag => tagMatchesSha(tag, record.sha!)));
    const protectsProductionAlias = tags.some(tag => ['latest', 'production', 'prod'].includes(tag.toLowerCase()));
    const protectedMatch = matches.find(record => record.id && protectedDeploymentIds.has(String(record.id)));
    const protectsDeployment = Boolean(protectedMatch);
    const recentReference = matches.some(record => {
      const days = record.production ? productionDays : nonProductionDays;
      return now - record.createdAt <= days * DAY_MS;
    });
    const ageDays = createdAt ? (now - createdAt) / DAY_MS : null;

    let action: 'keep' | 'delete' | 'review' = 'keep';
    let reason = 'within retention window';
    if (protectsProductionAlias) reason = 'protected production tag';
    else if (protectsDeployment) {
      reason = protectedMatch?.ref && previewBranches.includes(protectedMatch.ref)
        ? `latest READY ${protectedMatch.ref} deployment`
        : 'active production or distinct rollback deployment';
    } else if (recentReference) reason = 'referenced by a retained deployment';
    else if (matches.length > 0) { action = 'delete'; reason = 'only referenced by expired deployments'; }
    else if (tags.length === 0 && ageDays !== null && ageDays > nonProductionDays) { action = 'delete'; reason = 'untagged beyond nonproduction retention'; }
    else if (tags.length > 0 && tags.every(tag => COMMIT_TAG.test(tag)) && ageDays !== null && ageDays > productionDays) { action = 'delete'; reason = 'orphaned commit tags beyond production retention'; }
    else if (!createdAt) { action = 'review'; reason = 'missing creation time'; }
    else if (ageDays !== null && ageDays > productionDays) { action = 'review'; reason = 'old image has tags not correlated to a deployment'; }

    return {
      id,
      digest: image.digest ?? image.manifestDigest ?? null,
      sizeInBytes: typeof image.sizeInBytes === 'number' ? image.sizeInBytes : 0,
      tags,
      createdAt: createdAt || null,
      ageDays: ageDays === null ? null : Number(ageDays.toFixed(2)),
      action,
      reason,
      protected: protectsProductionAlias || protectsDeployment,
    };
  });

  const retainedBeforeTarget = () => decisions.filter(item => item.action !== 'delete').length;
  const trimCandidates = decisions
    .filter(item => item.action === 'keep' && !item.protected)
    .sort((a, b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER));

  for (const candidate of trimCandidates) {
    if (retainedBeforeTarget() <= retainedImageTarget) break;
    candidate.action = 'delete';
    candidate.reason = `oldest nonprotected image above retained target of ${retainedImageTarget}`;
  }

  const deleted = decisions.filter(item => item.action === 'delete');
  const retained = images.length - deleted.length;
  return {
    policy: { limit, retainedImageTarget, nonProductionDays, productionDays, rollbackCount, previewBranches },
    counts: {
      current: images.length,
      keep: decisions.filter(item => item.action === 'keep').length,
      delete: deleted.length,
      review: decisions.filter(item => item.action === 'review').length,
      retained,
      deleteBytes: deleted.reduce((total, item) => total + item.sizeInBytes, 0),
      headroomBefore: Math.max(0, limit - images.length),
      headroomAfter: Math.max(0, limit - images.length + deleted.length),
    },
    retainedTargetReached: retained <= retainedImageTarget,
    decisions,
  };
}
