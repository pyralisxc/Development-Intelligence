const DAY_MS = 24 * 60 * 60 * 1000;
const COMMIT_TAG = /^[0-9a-f]{7,40}$/i;

function timestamp(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function imageTags(image) {
  if (Array.isArray(image.tags)) return image.tags.map(tag => typeof tag === 'string' ? tag : tag?.name).filter(tag => typeof tag === 'string');
  if (typeof image.tag === 'string') return [image.tag];
  return [];
}

function deploymentSha(deployment) {
  const value = deployment?.meta?.githubCommitSha ?? deployment?.gitSource?.sha;
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function deploymentTime(deployment) {
  return timestamp(deployment.createdAt ?? deployment.created);
}

function isProduction(deployment) {
  return deployment.target === 'production' || deployment?.meta?.target === 'production';
}

function isReady(deployment) {
  return ['READY', 'ready'].includes(deployment.state ?? deployment.readyState);
}

function deploymentRef(deployment) {
  const value = deployment?.meta?.githubCommitRef ?? deployment?.gitSource?.ref ?? deployment?.sourceRef;
  return typeof value === 'string' ? value : null;
}

function tagMatchesSha(tag, sha) {
  return COMMIT_TAG.test(tag) && sha.startsWith(tag.toLowerCase());
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
}) {
  const readyProduction = deployments
    .filter(item => isProduction(item) && isReady(item))
    .sort((a, b) => deploymentTime(b) - deploymentTime(a));
  const protectedDeploymentIds = new Set(readyProduction.slice(0, 1 + rollbackCount).map(item => item.uid ?? item.id).filter(Boolean));

  for (const branch of previewBranches) {
    const latestReadyPreview = deployments
      .filter(item => !isProduction(item) && isReady(item) && deploymentRef(item) === branch)
      .sort((a, b) => deploymentTime(b) - deploymentTime(a))[0];
    const id = latestReadyPreview?.uid ?? latestReadyPreview?.id;
    if (id) protectedDeploymentIds.add(id);
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
    const id = image.id ?? image.uid ?? image.digest;
    const tags = imageTags(image);
    const createdAt = timestamp(image.createdAt ?? image.created);
    const matches = records.filter(record => tags.some(tag => tagMatchesSha(tag, record.sha)));
    const protectsProductionAlias = tags.some(tag => ['latest', 'production', 'prod'].includes(tag.toLowerCase()));
    const protectedMatch = matches.find(record => protectedDeploymentIds.has(record.id));
    const protectsDeployment = Boolean(protectedMatch);
    const recentReference = matches.some(record => {
      const days = record.production ? productionDays : nonProductionDays;
      return now - record.createdAt <= days * DAY_MS;
    });
    const ageDays = createdAt ? (now - createdAt) / DAY_MS : null;

    let action = 'keep';
    let reason = 'within retention window';
    if (protectsProductionAlias) reason = 'protected production tag';
    else if (protectsDeployment) {
      reason = protectedMatch.ref && previewBranches.includes(protectedMatch.ref)
        ? `latest READY ${protectedMatch.ref} deployment`
        : 'active production or rollback deployment';
    }
    else if (recentReference) reason = 'referenced by a retained deployment';
    else if (matches.length > 0) { action = 'delete'; reason = 'only referenced by expired deployments'; }
    else if (tags.length === 0 && ageDays !== null && ageDays > nonProductionDays) { action = 'delete'; reason = 'untagged beyond nonproduction retention'; }
    else if (tags.length > 0 && tags.every(tag => COMMIT_TAG.test(tag)) && ageDays !== null && ageDays > productionDays) { action = 'delete'; reason = 'orphaned commit tags beyond production retention'; }
    else if (!createdAt) { action = 'review'; reason = 'missing creation time'; }
    else if (ageDays > productionDays) { action = 'review'; reason = 'old image has tags not correlated to a deployment'; }

    return {
      id,
      digest: image.digest ?? null,
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

  const deleteCount = decisions.filter(item => item.action === 'delete').length;
  const retained = images.length - deleteCount;
  return {
    policy: { limit, retainedImageTarget, nonProductionDays, productionDays, rollbackCount, previewBranches },
    counts: {
      current: images.length,
      keep: decisions.filter(item => item.action === 'keep').length,
      delete: deleteCount,
      review: decisions.filter(item => item.action === 'review').length,
      retained,
      headroomBefore: Math.max(0, limit - images.length),
      headroomAfter: Math.max(0, limit - images.length + deleteCount),
    },
    retainedTargetReached: retained <= retainedImageTarget,
    decisions,
  };
}
