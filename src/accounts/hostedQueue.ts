import { Sandbox } from '@vercel/sandbox';
import { currentVercelOidcToken, vercelOidcProjectIdentity } from '../vercelRequestContext.js';
import { accountGithubToken } from './github.js';
import { initialHostedHandle, readHostedGraphJob, startHostedGraphJob, stopHostedGraphJob } from './hosted.js';
import { WorkspaceStore, type BuildJob, type BrowseJob } from './workspace.js';

async function requireHostedProvider(): Promise<void> {
  const token = currentVercelOidcToken() ?? process.env.VERCEL_OIDC_TOKEN?.trim();
  const identity = token && vercelOidcProjectIdentity(token);
  if (!token || !identity) throw new Error('Hosted dispatcher credentials are unavailable');
  await Sandbox.list({ token, ...identity, limit: 1 });
}

/** Advance an explicitly requested hosted job from the execution owner or its callback. */
export async function advanceHostedJob(store: WorkspaceStore, userId: string, input: BuildJob | BrowseJob | null, origin?: string, providerReady = false): Promise<BuildJob | BrowseJob | null> {
  if (!input || input.kind === 'browse' || input.assignedComputer !== 'hosted') return input;
  let job = input;
  if (job.state === 'queued') {
    if (!origin) return job;
    if (!providerReady) { try { await requireHostedProvider(); } catch { return job; } }
    const claimed = await store.claimHosted(job.id);
    if (!claimed) return await store.build(job.id);
    job = claimed;
    let handle: BuildJob['hosted'] = initialHostedHandle(job.id);
    try {
      await store.hostedStarted(job.id, job.claimId!, handle);
      let token: string | null = null;
      if (job.kind === 'build' && job.graph.source.kind === 'git' && new URL(job.graph.source.location).hostname === 'github.com') token = await accountGithubToken(userId);
      handle = await startHostedGraphJob(userId, job, token, origin);
      await store.hostedStarted(job.id, job.claimId!, handle);
      return await store.build(job.id);
    } catch (error) {
      if (handle) await stopHostedGraphJob(handle).catch(() => {});
      await store.updateHosted(job.id, job.claimId!, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
      await store.releaseHostedBuild(job.id);
      return await store.build(job.id);
    }
  }
  if (job.state === 'running' && job.claimId && job.leaseUntil && Date.now() >= job.leaseUntil) {
    try { await store.updateHosted(job.id, job.claimId, { state: 'failed', error: 'Hosted worker exceeded its configured session duration' }); }
    catch (error) {
      const current = await store.build(job.id).catch(() => null);
      if (current?.claimId === job.claimId && (current.state === 'complete' || current.state === 'failed')) return current;
      throw error;
    }
    if (job.hosted) await stopHostedGraphJob(job.hosted).catch(() => {});
    await store.releaseHostedBuild(job.id);
    return await store.build(job.id);
  }
  if (job.state === 'running' && job.hosted?.command && job.claimId) {
    let status: Awaited<ReturnType<typeof readHostedGraphJob>>;
    try {
      status = await readHostedGraphJob(job.hosted);
      await store.updateHosted(job.id, job.claimId, status);
    }
    catch (error) {
      const current = await store.build(job.id).catch(() => null);
      if (current?.claimId === job.claimId && (current.state === 'complete' || current.state === 'failed')) return current;
      throw error;
    }
    if (status.state !== 'running') {
      await stopHostedGraphJob(job.hosted).catch(() => {});
      await store.releaseHostedBuild(job.id);
    }
    return await store.build(job.id);
  }
  return job;
}

/** Bounded periodic recovery for jobs whose caller or worker disappeared. */
export async function dispatchHostedAccounts(origin: string): Promise<{ accounts: number; failures: number }> {
  // Do not claim work if the scheduled request cannot reach the Sandbox provider.
  await requireHostedProvider();
  const registry = new WorkspaceStore('hosted-dispatcher');
  const users = await registry.reserveHostedAccounts();
  let failures = 0;
  for (const userId of users) {
    const store = new WorkspaceStore(userId);
    try {
      const jobs = await store.hostedJobs();
      for (const job of jobs) {
        try { await advanceHostedJob(store, userId, job, origin, true); }
        catch { failures++; }
      }
      await store.forgetIdleHostedAccount();
    } catch { failures++; }
  }
  return { accounts: users.length, failures };
}
