import { accountGithubToken } from './github.js';
import { initialHostedHandle, readHostedGraphJob, startHostedGraphJob, stopHostedGraphJob } from './hosted.js';
import { WorkspaceStore, type BuildJob, type BrowseJob } from './workspace.js';

/** Advance a hosted account job when its owner opens or refreshes the Workbench. */
export async function advanceHostedJob(store: WorkspaceStore, userId: string, input: BuildJob | BrowseJob | null, origin?: string): Promise<BuildJob | BrowseJob | null> {
  if (!input || input.kind === 'browse' || input.assignedComputer !== 'hosted') return input;
  let job = input;
  if (job.state === 'queued') {
    if (!origin) return job;
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
  if (job.state === 'running' && job.hosted && job.claimId && job.leaseUntil && Date.now() >= job.leaseUntil) {
    try { await store.updateHosted(job.id, job.claimId, { state: 'failed', error: 'Hosted worker exceeded its configured session duration' }); }
    catch (error) {
      const current = await store.build(job.id).catch(() => null);
      if (current?.claimId === job.claimId && (current.state === 'complete' || current.state === 'failed')) return current;
      throw error;
    }
    await stopHostedGraphJob(job.hosted).catch(() => {});
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
