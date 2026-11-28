import { createHash } from 'node:crypto';
import { Drive } from '@vercel/drives';
import { Sandbox } from '@vercel/sandbox';
import { currentVercelOidcToken, vercelOidcProjectIdentity } from '../vercelRequestContext.js';
import { hostedTransferToken, type BuildJob } from './workspace.js';

type HostedHandle = { sandbox: string; command: string; statusFile: string };
type HostedStatus = { state: 'running' | 'complete' | 'failed'; progress?: unknown; result?: unknown; error?: string };

export function initialHostedHandle(jobId: string): HostedHandle {
  return { sandbox: `di-job-${jobId}`, command: '', statusFile: `/tmp/di-status-${jobId}.json` };
}

function access() {
  const token = currentVercelOidcToken() ?? process.env.VERCEL_OIDC_TOKEN?.trim();
  const identity = token && vercelOidcProjectIdentity(token);
  if (!token || !identity) throw new Error('This deployment cannot access Vercel Sandbox and Drive');
  return { token, ...identity };
}

function driveName(userId: string): string {
  const namespace = process.env.DEVINT_ACCOUNT_NAMESPACE?.trim();
  if (!namespace || !/^[a-zA-Z0-9_-]+$/u.test(namespace)) throw new Error('Account storage namespace is not configured');
  const scope = createHash('sha256').update(namespace).digest('hex').slice(0, 10);
  return `di-${scope}-${createHash('sha256').update(userId).digest('hex').slice(0, 24)}`;
}

function transferName(job: BuildJob, graphId: string): string {
  return `di-transfer-${createHash('sha256').update(`${job.id}:${job.claimId}:${graphId}`).digest('hex').slice(0, 32)}`;
}

/** Create an isolated, claim-scoped streaming receiver mounted on the account Drive. */
export async function startHostedTransfer(userId: string, job: BuildJob, graphId: string, computerSecret: string, retain: number, origin: string): Promise<{ endpoint: string; token: string }> {
  if (!job.claimId) throw new Error('Graph transfer has no active claim');
  const credentials = access(), revision = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  const owner = process.env.VERCEL_GIT_REPO_OWNER?.trim(), repository = process.env.VERCEL_GIT_REPO_SLUG?.trim();
  const engine = process.env.DEVINT_HOSTED_ENGINE_REPOSITORY?.trim() || (owner && repository && /^[A-Za-z0-9_.-]+$/u.test(owner) && /^[A-Za-z0-9_.-]+$/u.test(repository) ? `https://github.com/${owner}/${repository}.git` : '');
  if (!revision || !/^[a-f0-9]{40}$/u.test(revision) || !engine) throw new Error('The deployed DI engine revision is unavailable');
  const engineUrl = new URL(engine);
  if (engineUrl.protocol !== 'https:' || engineUrl.username || engineUrl.password) throw new Error('The hosted DI engine repository must use HTTPS');
  const digest = createHash('sha256').update(computerSecret).digest('hex');
  const token = hostedTransferToken(digest, job.id, job.claimId, graphId);
  const drive = await Drive.getOrCreate({ name: driveName(userId), ...credentials });
  const timeout = job.graph.hostedResources?.timeoutMinutes ? job.graph.hostedResources.timeoutMinutes * 60_000 : Number(process.env.DEVINT_HOSTED_SANDBOX_TIMEOUT_MS || 3_600_000);
  const vcpus = job.graph.hostedResources?.buildVcpus ?? Number(process.env.DEVINT_HOSTED_SANDBOX_VCPUS || 8);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86_400_000 || !Number.isSafeInteger(vcpus) || vcpus < 1 || vcpus > 8) throw new Error('Invalid hosted sandbox capacity settings');
  const sandbox = await Sandbox.getOrCreate({ name: transferName(job, graphId), ...credentials, persistent: false,
    source: { type: 'git', url: engineUrl.href, revision }, runtime: 'node22', timeout, resources: { vcpus }, ports: [3457], mounts: { '/data': drive },
    onCreate: async instance => {
      try {
        const file = '/tmp/di-transfer-input.json';
        await instance.writeFiles([{ path: file, content: JSON.stringify({ token, project: job.project.id, graphId, target: job.snapshotStaging ? `.di-account-stage-${job.graph.id}-${job.claimId}` : job.graph.name, retain, stageOnly: Boolean(job.snapshotStaging), ...(job.graphLease && job.snapshotStaging ? { accountGraphId: job.graph.id } : {}), ...(job.graphLease && job.previousSnapshot && job.previousSnapshot.storage.computer === 'hosted' ? { previousGraphId: job.previousSnapshot.graphId } : {}), lease: { origin, userId, jobId: job.id, claimId: job.claimId } }), mode: 0o600 }]);
        const command = await instance.runCommand({ cmd: 'bash', detached: true, args: ['-lc', 'npm ci && npm run build:server:runtime && node dist/src/accounts/graphTransferEntry.js /tmp/di-transfer-input.json /data/graphs /tmp/di-transfer 3457'] });
        await instance.writeFiles([{ path: '/tmp/di-transfer-command', content: command.cmdId, mode: 0o600 }]);
      } catch (error) { await instance.stop().catch(() => {}); throw error; }
    },
  });
  return { endpoint: sandbox.domain(3457), token };
}

export async function hostedTransferStatus(job: BuildJob, graphId: string): Promise<{ running: boolean; error?: string }> {
  const sandbox = await Sandbox.get({ name: transferName(job, graphId), ...access() });
  const file = await sandbox.readFileToBuffer({ path: '/tmp/di-transfer-command' });
  if (!file) return { running: true };
  const command = await sandbox.getCommand(file.toString('utf8'));
  return command.exitCode === null ? { running: true } : { running: false, error: `Hosted graph transfer receiver exited before it was ready (exit ${command.exitCode})` };
}

export async function stopHostedTransfer(job: BuildJob, graphId: string): Promise<void> {
  try {
    const sandbox = await Sandbox.get({ name: transferName(job, graphId), ...access() });
    try { await sandbox.stop(); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'No active session to stop.') throw error; }
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status !== 404 && status !== 410) throw error;
  }
}

/** Start the shared account graph job in an isolated Vercel Sandbox. */
export async function startHostedGraphJob(userId: string, job: BuildJob, githubToken: string | null, origin: string): Promise<HostedHandle> {
  const credentials = access();
  const revision = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (!revision || !/^[a-f0-9]{40}$/u.test(revision)) throw new Error('The deployed DI revision is unavailable');
  const owner = process.env.VERCEL_GIT_REPO_OWNER?.trim(), repository = process.env.VERCEL_GIT_REPO_SLUG?.trim();
  const configured = process.env.DEVINT_HOSTED_ENGINE_REPOSITORY?.trim();
  const engineRepository = configured || (owner && repository && /^[A-Za-z0-9_.-]+$/u.test(owner) && /^[A-Za-z0-9_.-]+$/u.test(repository) ? `https://github.com/${owner}/${repository}.git` : '');
  if (!engineRepository) throw new Error('The deployed DI engine repository is unavailable');
  const engineUrl = new URL(engineRepository);
  if (engineUrl.protocol !== 'https:' || engineUrl.username || engineUrl.password) throw new Error('The hosted DI engine repository must use HTTPS');
  const drive = await Drive.getOrCreate({ name: driveName(userId), ...credentials });
  const initial = initialHostedHandle(job.id), sandboxName = initial.sandbox;
  const readOnly = job.kind === 'question' || job.kind === 'investigation';
  const timeout = job.graph.hostedResources?.timeoutMinutes ? job.graph.hostedResources.timeoutMinutes * 60_000 : Number(process.env.DEVINT_HOSTED_SANDBOX_TIMEOUT_MS || 3_600_000);
  const vcpus = readOnly ? job.graph.hostedResources?.queryVcpus ?? 2 : job.graph.hostedResources?.buildVcpus ?? Number(process.env.DEVINT_HOSTED_SANDBOX_VCPUS || 8);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86_400_000 || !Number.isSafeInteger(vcpus) || vcpus < 1 || vcpus > 8) throw new Error('Invalid hosted sandbox capacity settings');
  const sandbox = await Sandbox.create({ name: sandboxName, ...credentials, persistent: false,
    source: { type: 'git', url: engineUrl.href, revision },
    runtime: 'node22', timeout, resources: { vcpus }, mounts: { '/data': readOnly ? drive.snapshot() : drive } });
  const inputFile = `/tmp/di-job-${job.id}.json`, statusFile = initial.statusFile;
  try {
    await sandbox.writeFiles([{ path: inputFile, content: JSON.stringify({ job, callback: { origin, userId } }), mode: 0o600 }]);
    const command = await sandbox.runCommand({ cmd: 'bash', detached: true,
      args: ['-lc', 'env -u DEVINT_HOSTED_GITHUB_TOKEN npm ci && env -u DEVINT_HOSTED_GITHUB_TOKEN npm run build:server:runtime && node dist/src/accounts/hostedEntry.js "$DI_JOB_INPUT" "$DI_JOB_STATUS" /data/graphs /tmp/di-scratch'],
      env: { DI_JOB_INPUT: inputFile, DI_JOB_STATUS: statusFile, DEVINT_HOSTED_GITHUB_TOKEN: githubToken ?? '',
        ...(readOnly ? { DEVINT_GRAPH_READ_ONLY_SNAPSHOT: '1' } : {}) } });
    return { sandbox: sandboxName, command: command.cmdId, statusFile };
  } catch (error) {
    await sandbox.stop().catch(() => {});
    throw error;
  }
}

/** Observe the detached job without turning the HTTP request into its lifetime. */
export async function readHostedGraphJob(handle: HostedHandle): Promise<HostedStatus> {
  const sandbox = await Sandbox.get({ name: handle.sandbox, ...access() });
  const data = await sandbox.readFileToBuffer({ path: handle.statusFile });
  if (data) {
    const status = JSON.parse(data.toString('utf8')) as HostedStatus;
    if (status.state === 'running' || status.state === 'complete' || status.state === 'failed') return status;
  }
  const command = await sandbox.getCommand(handle.command);
  if (command.exitCode !== null) return { state: 'failed', error: `Hosted worker exited before reporting a result (exit ${command.exitCode})` };
  return { state: 'running', progress: { stage: 'preparing-hosted-worker' } };
}

export async function stopHostedGraphJob(handle: HostedHandle): Promise<void> {
  const sandbox = await Sandbox.get({ name: handle.sandbox, ...access() });
  await sandbox.stop();
}
