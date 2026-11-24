import { createClerkClient } from '@clerk/backend';

export async function accountGithubToken(userId: string): Promise<string | null> {
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY!, publishableKey: process.env.CLERK_PUBLISHABLE_KEY! });
  try { return (await client.users.getUserOauthAccessToken(userId, 'github')).data[0]?.token ?? null; } catch { return null; }
}

export async function accountGithubBranches(userId: string, repository: string): Promise<string[]> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw Object.assign(new Error('Invalid GitHub repository'), { status: 400 });
  const available = await accountGithubRepositories(userId);
  if (!available.repositories.some(item => item.name.toLowerCase() === repository.toLowerCase())) throw Object.assign(new Error('Repository is not available to this account'), { status: 403 });
  const token = await accountGithubToken(userId);
  let next: string | null = `https://api.github.com/repos/${repository.split('/').map(encodeURIComponent).join('/')}/branches?per_page=100`;
  const names: string[] = [];
  while (next) {
    const response: Response = await fetch(next, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'development-intelligence', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) }, redirect: 'error' });
    if (!response.ok) throw new Error(`GitHub branch listing failed (${response.status})`);
    names.push(...(await response.json() as Array<{ name: string }>).map(item => item.name));
    const match: RegExpMatchArray | null = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/u) ?? null;
    next = match?.[1] ?? null;
    if (next && new URL(next).origin !== 'https://api.github.com') throw new Error('Invalid GitHub pagination');
  }
  return names;
}

/** Resolve the signed-in person's GitHub connection, never the operator's app credentials. */
export async function accountGithubRepositories(userId: string): Promise<{ connected: boolean; username?: string; access?: string; repositories: Array<{ name: string; url: string; private: boolean }> }> {
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY!, publishableKey: process.env.CLERK_PUBLISHABLE_KEY! });
  const user = await client.users.getUser(userId);
  const github = user.externalAccounts.find(account => ['github', 'oauth_github'].includes(account.provider));
  if (!github?.username) return { connected: false, repositories: [] };
  const token = await accountGithubToken(userId);
  let next: string | null = token ? 'https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member' : `https://api.github.com/users/${encodeURIComponent(github.username)}/repos?per_page=100`;
  const repositories: Array<{ name: string; url: string; private: boolean }> = [];
  while (next) {
    const response: Response = await fetch(next, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'development-intelligence', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) }, redirect: 'error' });
    if (!response.ok) throw new Error(`GitHub repository listing failed (${response.status})`);
    const page = await response.json() as Array<{ full_name: string; clone_url: string; private: boolean }>;
    repositories.push(...page.map(item => ({ name: item.full_name, url: item.clone_url, private: item.private })));
    const match: RegExpMatchArray | null = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/u) ?? null;
    next = match?.[1] ?? null;
    if (next && new URL(next).origin !== 'https://api.github.com') throw new Error('Invalid GitHub pagination');
  }
  return { connected: true, username: github.username, access: token ? 'authorized repositories' : 'public repositories', repositories };
}
