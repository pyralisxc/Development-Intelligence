Failed to create stream fd: Operation not permitted
Failed to create stream fd: Operation not permitted
Failed to create stream fd: Operation not permitted
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Redis } from '@upstash/redis';

export type Project = { id: string; name: string };
export type GraphDefinition = {
  id: string; projectId: string; name: string;
  source: { kind: 'local-folder' | 'git'; location: string; revision?: string };
  buildComputer: string; storage: { computer: string; location: string };
  updatePolicy: 'snapshot';
};
export type Computer = { id: string; name: string; platform: string; lastSeen: string; state: 'linked' | 'revoked' };
export type BuildJob = { id: string; kind?: 'build' | 'question'; question?: string; graphId?: string; graph: GraphDefinition; project: Project; state: 'queued' | 'running' | 'complete' | 'failed'; createdAt: string; leaseUntil?: number; claimId?: string; progress?: unknown; result?: unknown; error?: string };

function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }
function value(input: unknown, label: string): string {
  if (typeof input !== 'string' || !input.trim() || input !== input.trim() || /[\u0000-\u001f\u007f]/u.test(input)) invalid(`${label} must be non-empty text`);
  return input;
}
function id(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{32}$/u.test(input)) invalid('Invalid workspace identity');
  return input;
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Expected an object');
  return input as Record<string, unknown>;
}
function recordId(): string { return randomBytes(16).toString('hex'); }

/** Account records are separate Redis fields so project count is not a whole-document limit. */
export class WorkspaceStore {
  private readonly redis: Redis;
  private readonly root: string;
  constructor(userId: string) {
    const url = process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.KV_REST_API_URL?.trim();
    const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || process.env.KV_REST_API_TOKEN?.trim();
    const scope = process.env.DEVINT_ACCOUNT_NAMESPACE?.trim();
    if (!url || !token || !scope || !/^[a-zA-Z0-9_-]+$/u.test(scope)) throw new Error('Account storage is not configured for this environment');
    this.redis = new Redis({ url, token, enableTelemetry: false });
    const account = createHash('sha256').update(userId).digest('hex');
    this.root = `di:accounts:${scope}:${account}`;
  }
  private key(kind: string): string { return `${this.root}:${kind}`; }
  async projects(): Promise<Project[]> { return Object.values(await this.redis.hgetall<Record<string, Project>>(this.key('projects')) ?? {}); }
  async graphs(): Promise<GraphDefinition[]> { return Object.values(await this.redis.hgetall<Record<string, GraphDefinition>>(this.key('graphs')) ?? {}); }
  async computers(): Promise<Computer[]> { return Object.values(await this.redis.hgetall<Record<string, Computer>>(this.key('computers')) ?? {}); }
  async builds(): Promise<BuildJob[]> { return Object.values(await this.redis.hgetall<Record<string, BuildJob>>(this.key('builds')) ?? {}); }
  async linkComputer(input: unknown): Promise<{ computer: Computer; secret: string }> {
    const data = object(input);
    const computer: Computer = { id: recordId(), name: value(data.name, 'Computer name'), platform: value(data.platform, 'Platform'), lastSeen: new Date().toISOString(), state: 'linked' };
    const secret = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(secret).digest('hex');
    // The device credential is separate from the public computer metadata.
    await this.redis.hset(this.key('computer-secrets'), { [computer.id]: digest });
    await this.redis.hset(this.key('computers'), { [computer.id]: computer });
    return { computer, secret };
  }
  async verifyComputer(computerId: unknown, secret: unknown): Promise<Computer> {
    const computerKey = id(computerId);
    const computer = await this.redis.hget<Computer>(this.key('computers'), computerKey);
    const expected = await this.redis.hget<string>(this.key('computer-secrets'), computerKey);
    const supplied = typeof secret === 'string' ? createHash('sha256').update(secret).digest('hex') : '';
    if (!computer || computer.state !== 'linked' || typeof expected !== 'string' || expected.length !== supplied.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
      throw Object.assign(new Error('Computer is not linked to this account'), { status: 403 });
    }
    return computer;
  }
  async heartbeat(computerId: unknown, secret: unknown): Promise<Computer> {
    const computerKey = id(computerId);
    const digest = typeof secret === 'string' ? createHash('sha256').update(secret).digest('hex') : '';
    const result = await this.redis.eval<unknown[], string | null>(`local secret=redis.call('HGET',KEYS[2],ARGV[1]); local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not secret or secret~=ARGV[2] or not raw then return nil end; local item=cjson.decode(raw); if item.state~='linked' then return nil end; item.lastSeen=ARGV[3]; local out=cjson.encode(item); redis.call('HSET',KEYS[1],ARGV[1],out); return out`, [this.key('computers'), this.key('computer-secrets')], [computerKey, digest, new Date().toISOString()]);
    if (!result) throw Object.assign(new Error('Computer is not linked to this account'), { status: 403 });
    return typeof result === 'string' ? JSON.parse(result) as Computer : result as unknown as Computer;
  }
  async revokeComputer(computerId: unknown): Promise<void> {
    const computerKey = id(computerId);
    const computer = await this.redis.hget<Computer>(this.key('computers'), computerKey);
    if (!computer) invalid('Computer does not exist');
    await this.redis.hdel(this.key('computer-secrets'), computerKey);
    await this.redis.hset(this.key('computers'), { [computerKey]: { ...computer, state: 'revoked' } });
  }
  async layout(): Promise<unknown> { return await this.redis.get(this.key('layout')); }
  async saveLayout(layout: unknown): Promise<void> {
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) invalid('Layout must be an object');
    await this.redis.set(this.key('layout'), layout);
  }
  async saveProject(input: unknown): Promise<Project> {
    const data = object(input); const project: Project = { id: data.id === undefined ? recordId() : id(data.id), name: value(data.name, 'Project name') };
    if (data.id !== undefined && !await this.redis.hexists(this.key('projects'), project.id)) invalid('Project does not exist');
    await this.redis.hset(this.key('projects'), { [project.id]: project }); return project;
  }
  async saveGraph(input: unknown): Promise<GraphDefinition> {
    const data = object(input), source = object(data.source), storage = object(data.storage);
    const projectId = id(data.projectId);
    if (!await this.redis.hexists(this.key('projects'), projectId)) invalid('Project does not exist');
    if (source.kind !== 'local-folder' && source.kind !== 'git') invalid('Choose a local folder or Git source');
    if (data.updatePolicy !== undefined && data.updatePolicy !== 'snapshot') invalid('Unsupported graph update policy');
    const graph: GraphDefinition = { id: data.id === undefined ? recordId() : id(data.id), projectId,
      name: value(data.name, 'Graph name'), source: { kind: source.kind, location: value(source.location, 'Source location'),
        ...(source.revision === undefined || source.revision === '' ? {} : { revision: value(source.revision, 'Revision') }) },
      buildComputer: id(data.buildComputer), storage: { computer: id(storage.computer), location: value(storage.location, 'Graph storage location') }, updatePolicy: 'snapshot' };
    if (data.id !== undefined && !await this.redis.hexists(this.key('graphs'), graph.id)) invalid('Graph does not exist');
    const computers = await this.computers();
    if (![graph.buildComputer, graph.storage.computer].every(computer => computers.some(item => item.id === computer && item.state === 'linked'))) invalid('Choose linked computers');
    await this.redis.hset(this.key('graphs'), { [graph.id]: graph }); return graph;
  }
  async queueBuild(graphId: unknown): Promise<BuildJob> {
    const graph = await this.redis.hget<GraphDefinition>(this.key('graphs'), id(graphId));
    if (!graph) invalid('Graph does not exist');
    const project = await this.redis.hget<Project>(this.key('projects'), graph.projectId);
    if (!project) invalid('Project does not exist');
    if (graph.buildComputer !== graph.storage.computer) invalid('Cross-computer graph storage is not available yet');
    const job: BuildJob = { id: recordId(), kind: 'build', graph, project, state: 'queued', createdAt: new Date().toISOString() };
    await this.redis.hset(this.key('builds'), { [job.id]: job }); return job;
  }
  async queueQuestion(graphId: unknown, question: unknown): Promise<BuildJob> {
    const graph = await this.redis.hget<GraphDefinition>(this.key('graphs'), id(graphId));
    if (!graph) invalid('Graph does not exist');
    const project = await this.redis.hget<Project>(this.key('projects'), graph.projectId);
    if (!project) invalid('Project does not exist');
    const latest = (await this.builds()).filter(job => job.graph.id === graph.id && job.kind === 'build' && job.state === 'complete').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const built = latest?.result as { graphId?: unknown } | undefined;
    if (typeof built?.graphId !== 'string') invalid('Build a snapshot of this graph first');
    const job: BuildJob = { id: recordId(), kind: 'question', question: value(question, 'Question'), graphId: built.graphId, graph: latest!.graph, project, state: 'queued', createdAt: new Date().toISOString() };
    await this.redis.hset(this.key('builds'), { [job.id]: job }); return job;
  }
  async claimBuild(computerId: unknown, secret: unknown): Promise<BuildJob | null> {
    const computer = await this.heartbeat(computerId, secret);
    const jobs = (await this.builds()).filter(job => job.graph.buildComputer === computer.id && (job.state === 'queued' || (job.state === 'running' && (job.leaseUntil ?? 0) < Date.now()))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of jobs) {
      const now = Date.now();
      const claimed = await this.redis.eval<unknown[], string | null>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return nil end; local job=cjson.decode(raw); if job.graph.buildComputer~=ARGV[2] then return nil end; if job.state~='queued' and (job.state~='running' or (job.leaseUntil or 0)>=tonumber(ARGV[3])) then return nil end; job.state='running'; job.leaseUntil=tonumber(ARGV[4]); job.claimId=ARGV[5]; local value=cjson.encode(job); redis.call('HSET',KEYS[1],ARGV[1],value); return value`, [this.key('builds')], [job.id, computer.id, now, now + 900_000, recordId()]);
      if (claimed) return typeof claimed === 'string' ? JSON.parse(claimed) as BuildJob : claimed as unknown as BuildJob;
    }
    return null;
  }
  async updateBuild(computerId: unknown, secret: unknown, jobId: unknown, update: unknown): Promise<void> {
    const computer = await this.verifyComputer(computerId, secret), data = object(update), buildId = id(jobId), claimId = id(data.claimId);
    const changed = await this.redis.eval<unknown[], number>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.state~='running' or job.graph.buildComputer~=ARGV[2] or job.claimId~=ARGV[3] then return 0 end; local update=cjson.decode(ARGV[4]); if update.state=='complete' then job.state='complete'; job.result=update.result; job.leaseUntil=nil elseif update.state=='failed' then job.state='failed'; job.error=update.error; job.leaseUntil=nil else job.progress=update.progress; job.leaseUntil=tonumber(ARGV[5]) end; redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); return 1`, [this.key('builds')], [buildId, computer.id, claimId, JSON.stringify(data), Date.now() + 900_000]);
    if (changed !== 1) invalid('Build claim is no longer active');
  }
}
