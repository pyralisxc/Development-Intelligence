import { planVcrRetention } from './vcrRetention.js';

type JsonRecord = Record<string, any>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function requestJson(fetcher: FetchLike, token: string, url: string, init?: RequestInit): Promise<any> {
  const response = await fetcher(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`Vercel VCR request failed with status ${response.status}: ${text.slice(0, 300)}`), { status: 502 });
  return text ? JSON.parse(text) : null;
}

async function allPages(fetcher: FetchLike, token: string, basePath: string, collectionKey: string): Promise<JsonRecord[]> {
  const items: JsonRecord[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL(basePath);
    if (cursor) url.searchParams.set('cursor', cursor);
    const data = await requestJson(fetcher, token, url.toString());
    const page = Array.isArray(data) ? data : data?.[collectionKey];
    if (!Array.isArray(page)) throw Object.assign(new Error(`Vercel response did not include ${collectionKey}[]`), { status: 502 });
    items.push(...page);
    const next = data?.pagination?.next ?? data?.nextCursor ?? null;
    cursor = typeof next === 'string' || typeof next === 'number' ? String(next) : null;
  } while (cursor);
  return items;
}

export interface ApplyVcrRetentionOptions {
  token: string;
  projectId: string;
  teamId: string;
  repository?: string;
  fetcher?: FetchLike;
  now?: number;
}

export async function applyVcrRetentionMaintenance({
  token,
  projectId,
  teamId,
  repository = 'dockerfile',
  fetcher = fetch,
  now = Date.now(),
}: ApplyVcrRetentionOptions): Promise<Record<string, unknown>> {
  if (!token.trim()) throw Object.assign(new Error('Vercel OIDC token is unavailable for VCR maintenance'), { status: 503 });
  if (!projectId.trim() || !teamId.trim()) throw Object.assign(new Error('Vercel project/team identity is unavailable for VCR maintenance'), { status: 503 });

  const scope = `teamId=${encodeURIComponent(teamId)}&projectId=${encodeURIComponent(projectId)}`;
  const imagePath = `https://api.vercel.com/v1/vcr/repository/${encodeURIComponent(repository)}/images?${scope}&limit=100`;
  const deploymentPath = `https://api.vercel.com/v6/deployments?${scope}&limit=100`;

  const [images, deployments] = await Promise.all([
    allPages(fetcher, token, imagePath, 'images'),
    allPages(fetcher, token, deploymentPath, 'deployments'),
  ]);
  const plan = planVcrRetention({ images, deployments, now });
  const deletions = (plan.decisions as JsonRecord[]).filter(item => item.action === 'delete');

  const deleted: Array<{ id: string; sizeInBytes: number; reason: string }> = [];
  for (const candidate of deletions) {
    const id = typeof candidate.id === 'string' ? candidate.id : '';
    if (!id) throw Object.assign(new Error('Refusing to delete VCR candidate without an exact image ID'), { status: 500 });
    await requestJson(
      fetcher,
      token,
      `https://api.vercel.com/v1/vcr/repository/${encodeURIComponent(repository)}/images/${encodeURIComponent(id)}?${scope}`,
      { method: 'DELETE' },
    );
    deleted.push({ id, sizeInBytes: Number(candidate.sizeInBytes ?? 0), reason: String(candidate.reason ?? 'retention policy') });
  }

  const remainingImages = await allPages(fetcher, token, imagePath, 'images');
  const remainingIds = new Set(remainingImages.map(item => String(item.id ?? item.uid ?? item.imageId ?? '')));
  const undeleted = deleted.filter(item => remainingIds.has(item.id));
  if (undeleted.length) throw Object.assign(new Error(`VCR retention verification found ${undeleted.length} image(s) still present after deletion`), { status: 502 });

  return {
    repository,
    mode: 'apply',
    before: {
      images: images.length,
      knownBytes: images.reduce((total, item) => total + Number(item.sizeInBytes ?? 0), 0),
    },
    plan: {
      policy: plan.policy,
      counts: plan.counts,
      retainedTargetReached: plan.retainedTargetReached,
      review: (plan.decisions as JsonRecord[]).filter(item => item.action === 'review').map(item => ({ id: item.id, reason: item.reason })),
    },
    deleted: {
      images: deleted.length,
      knownBytes: deleted.reduce((total, item) => total + item.sizeInBytes, 0),
      items: deleted,
    },
    after: {
      images: remainingImages.length,
      knownBytes: remainingImages.reduce((total, item) => total + Number(item.sizeInBytes ?? 0), 0),
      verified: true,
    },
  };
}
