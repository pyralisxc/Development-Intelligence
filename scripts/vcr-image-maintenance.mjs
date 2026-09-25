import { planVcrRetention } from './vcr-retention-lib.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const token = process.env.VERCEL_TOKEN;
const projectId = argument('project-id', process.env.VERCEL_PROJECT_ID);
const teamId = argument('team-id', process.env.VERCEL_TEAM_ID);
const repository = argument('repository', process.env.VERCEL_VCR_REPOSITORY ?? 'dockerfile');
const applyConfirmation = argument('apply', null);
const policy = {
  limit: Number(argument('limit', '50')),
  retainedImageTarget: Number(argument('retained-images', '10')),
  nonProductionDays: Number(argument('nonproduction-days', '1')),
  productionDays: Number(argument('production-days', '7')),
  rollbackCount: Number(argument('rollback-count', '1')),
  previewBranches: String(argument('preview-branch', 'preview')).split(',').map(value => value.trim()).filter(Boolean),
};

if (!token || !projectId || !teamId) {
  throw new Error('VERCEL_TOKEN, VERCEL_PROJECT_ID, and VERCEL_TEAM_ID are required. The command is dry run unless --apply exactly matches VERCEL_PROJECT_ID.');
}
if (applyConfirmation && applyConfirmation !== projectId) throw new Error('--apply must exactly match VERCEL_PROJECT_ID');

const headers = { authorization: `Bearer ${token}` };
async function request(path, init) {
  const response = await fetch(`https://api.vercel.com${path}`, { ...init, headers: { ...headers, ...init?.headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function allPages(path, collectionKey) {
  const items = [];
  let cursor;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const data = await request(`${path}${cursor ? `${separator}cursor=${encodeURIComponent(cursor)}` : ''}`);
    const pageItems = Array.isArray(data) ? data : data?.[collectionKey];
    if (!Array.isArray(pageItems)) throw new Error(`Vercel response did not include ${collectionKey}[]`);
    items.push(...pageItems);
    const next = data?.pagination?.next ?? data?.nextCursor ?? null;
    cursor = typeof next === 'string' || typeof next === 'number' ? String(next) : null;
  } while (cursor);
  return items;
}

const scope = `teamId=${encodeURIComponent(teamId)}&projectId=${encodeURIComponent(projectId)}`;
const images = await allPages(`/v1/vcr/repository/${encodeURIComponent(repository)}/images?${scope}&limit=100`, 'images');
const deployments = await allPages(`/v6/deployments?${scope}&limit=100`, 'deployments');
const plan = planVcrRetention({ images, deployments, ...policy });

console.log(JSON.stringify({ mode: applyConfirmation ? 'apply' : 'dry-run', projectId, teamId, repository, ...plan }, null, 2));

if (applyConfirmation) {
  for (const candidate of plan.decisions.filter(item => item.action === 'delete')) {
    if (!candidate.id) throw new Error(`Refusing to delete candidate without an image id: ${JSON.stringify(candidate)}`);
    await request(`/v1/vcr/repository/${encodeURIComponent(repository)}/images/${encodeURIComponent(candidate.id)}?${scope}`, { method: 'DELETE' });
    console.error(`Deleted VCR image ${candidate.id} (${candidate.reason})`);
  }
}
