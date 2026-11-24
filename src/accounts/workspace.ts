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
export type BuildJob = { id: string; kind?: 'build' | 'question' | 'investigation'; question?: string; graphId?: string; request?: { path: string; method: 'GET' | 'POST'; query?: string; body?: unknown }; graph: GraphDefinition; project: Project; state: 'queued' | 'running' | 'complete' | 'failed'; createdAt: string; leaseUntil?: number; claimId?: string; progress?: unknown; result?: unknown; resultKey?: string; error?: string };
export type BrowseJob = { id: string; kind: 'browse'; computerId: string; path?: string; state: 'queued' | 'running' | 'complete' | 'failed'; createdAt: string; leaseUntil?: number; claimId?: string; result?: unknown; resultKey?: string; error?: string };
type ComputerJob = BuildJob | BrowseJob;

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
  private async ensureIndexed(): Promise<void> {
    await this.redis.eval<unknown[], number>(`if redis.call('EXISTS',KEYS[1])==1 then return 0 end; local all=redis.call('HGETALL',KEYS[2]); for i=1,#all,2 do local ok,job=pcall(cjson.decode,all[i+1]); if ok and job.id then local score=tonumber(ARGV[2])+i; if job.kind~='investigation' and job.kind~='browse' then redis.call('ZADD',KEYS[3],score,job.id) end; local computer=job.kind=='browse' and job.computerId or (job.graph and job.graph.buildComputer); if computer and (job.state=='queued' or job.state=='running') then redis.call('ZADD',ARGV[1]..computer,job.leaseUntil or score,job.id) end end end; redis.call('SET',KEYS[1],'1'); return 1`, [this.key('jobs-index-v1'), this.key('builds'), this.key('build-history')], [`${this.root}:queue:`, Date.now()]);
  }
  async projects(): Promise<Project[]> { return Object.values(await this.redis.hgetall<Record<string, Project>>(this.key('projects')) ?? {}); }
  async graphs(): Promise<GraphDefinition[]> { return Object.values(await this.redis.hgetall<Record<string, GraphDefinition>>(this.key('graphs')) ?? {}); }
  async computers(): Promise<Computer[]> { return Object.values(await this.redis.hgetall<Record<string, Computer>>(this.key('computers')) ?? {}); }
  async builds(): Promise<BuildJob[]> {
    await this.ensureIndexed();
    const ids = await this.redis.zrange<string[]>(this.key('build-history'), 0, -1);
    if (!ids.length) return [];
    const pipe = this.redis.pipeline();
    for (const jobId of ids) pipe.hget(this.key('builds'), jobId);
    const jobs = (await pipe.exec()).filter((job): job is BuildJob => Boolean(job && typeof job === 'object'));
    return await Promise.all(jobs.map(async job => job.resultKey ? { ...job, result: await this.redis.get(job.resultKey) } : job));
  }
  async build(jobId: unknown): Promise<ComputerJob | null> {
    const job = await this.redis.hget<ComputerJob>(this.key('builds'), id(jobId));
    return job?.resultKey ? { ...job, result: await this.redis.get(job.resultKey) } : job;
  }
  private async enqueue(job: ComputerJob): Promise<void> {
    await this.ensureIndexed();
    const computer = job.kind === 'browse' ? job.computerId : job.graph.buildComputer;
    await this.redis.eval<unknown[], number>(`redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]); redis.call('ZADD',KEYS[2],ARGV[3],ARGV[1]); if ARGV[4]=='1' then redis.call('ZADD',KEYS[3],ARGV[3],ARGV[1]) end; return 1`, [this.key('builds'), this.key(`queue:${computer}`), this.key('build-history')], [job.id, JSON.stringify(job), Date.now(), job.kind === 'investigation' || job.kind === 'browse' ? '0' : '1']);
  }
  async queueBrowse(computerId: unknown, folder: unknown): Promise<BrowseJob> {
    const selected = id(computerId), computer = (await this.computers()).find(item => item.id === selected && item.state === 'linked');
    if (!computer) invalid('Choose a linked computer');
    const job: BrowseJob = { id: recordId(), kind: 'browse', computerId: selected, ...(folder === undefined || folder === '' ? {} : { path: value(folder, 'Folder') }), state: 'queued', createdAt: new Date().toISOString() };
    await this.enqueue(job); return job;
  }
  async beginComputerLink(): Promise<string> {
    const code = randomBytes(16).toString('hex');
    await this.redis.set(this.key(`pairing:${code}`), 'approved', { ex: 600 });
    return code;
  }
  async linkComputer(input: unknown, pairingCode: unknown): Promise<{ computer: Computer; secret: string }> {
    const code = id(pairingCode);
    if (await this.redis.getdel(this.key(`pairing:${code}`)) !== 'approved') throw Object.assign(new Error('Computer link request expired; start linking from the Workbench'), { status: 403 });
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
    await this.enqueue(job); return job;
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
    await this.enqueue(job); return job;
  }
  async queueInvestigation(graphId: unknown, input: unknown): Promise<BuildJob> {
    const request = object(input), path = value(request.path, 'Investigation path');
    if (!['/workbench/data', '/workbench/query', '/workbench/parity', '/graph/data'].includes(path)) invalid('Unsupported investigation');
    const method = request.method === 'POST' ? 'POST' : 'GET';
    if ((path === '/workbench/query' || path === '/workbench/parity') !== (method === 'POST')) invalid('Unsupported investigation method');
    const graph = await this.redis.hget<GraphDefinition>(this.key('graphs'), id(graphId));
    if (!graph) invalid('Graph does not exist');
    const project = await this.redis.hget<Project>(this.key('projects'), graph.projectId);
    if (!project) invalid('Project does not exist');
    const latest = (await this.builds()).filter(job => job.graph.id === graph.id && job.kind === 'build' && job.state === 'complete').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const built = latest?.result as { graphId?: unknown } | undefined;
    if (typeof built?.graphId !== 'string') invalid('Build a snapshot of this graph first');
    const job: BuildJob = { id: recordId(), kind: 'investigation', graphId: built.graphId, graph: latest!.graph, project, state: 'queued', createdAt: new Date().toISOString(), request: { path, method,
      ...(typeof request.query === 'string' ? { query: request.query } : {}), ...(request.body === undefined ? {} : { body: request.body }) } };
    await this.enqueue(job); return job;
  }
  async claimBuild(computerId: unknown, secret: unknown): Promise<ComputerJob | null> {
    await this.ensureIndexed();
    const computer = await this.heartbeat(computerId, secret);
    const now = Date.now();
    const digest = typeof secret === 'string' ? createHash('sha256').update(secret).digest('hex') : '';
    const claimed = await this.redis.eval<unknown[], string | null>(`if redis.call('HGET',KEYS[3],ARGV[4])~=ARGV[5] then return nil end; local ids=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',ARGV[1],'LIMIT',0,1); if #ids==0 then return nil end; local raw=redis.call('HGET',KEYS[1],ids[1]); if not raw then redis.call('ZREM',KEYS[2],ids[1]); return nil end; local job=cjson.decode(raw); job.state='running'; job.leaseUntil=tonumber(ARGV[2]); job.claimId=ARGV[3]; local value=cjson.encode(job); redis.call('HSET',KEYS[1],ids[1],value); redis.call('ZADD',KEYS[2],ARGV[2],ids[1]); return value`, [this.key('builds'), this.key(`queue:${computer.id}`), this.key('computer-secrets')], [now, now + 900_000, recordId(), computer.id, digest]);
    return !claimed ? null : typeof claimed === 'string' ? JSON.parse(claimed) as ComputerJob : claimed as unknown as ComputerJob;
  }
  async updateBuild(computerId: unknown, secret: unknown, jobId: unknown, update: unknown): Promise<void> {
    const computer = await this.heartbeat(computerId, secret), data = object(update), buildId = id(jobId), claimId = id(data.claimId);
    const { result, ...small } = data;
    const resultKey = this.key(`result:${buildId}:${claimId}`);
    if (data.state === 'complete') await this.redis.set(resultKey, result ?? null);
    const digest = typeof secret === 'string' ? createHash('sha256').update(secret).digest('hex') : '';
    const changed = await this.redis.eval<unknown[], number>(`if redis.call('HGET',KEYS[3],ARGV[2])~=ARGV[7] then return 0 end; local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); local owner=job.kind=='browse' and job.computerId or job.graph.buildComputer; if job.state~='running' or owner~=ARGV[2] or job.claimId~=ARGV[3] then return 0 end; local update=cjson.decode(ARGV[4]); if update.state=='complete' then job.state='complete'; job.resultKey=ARGV[6]; job.result=nil; job.leaseUntil=nil; redis.call('ZREM',KEYS[2],ARGV[1]) elseif update.state=='failed' then job.state='failed'; job.error=update.error; job.leaseUntil=nil; redis.call('ZREM',KEYS[2],ARGV[1]) else job.progress=update.progress; job.leaseUntil=tonumber(ARGV[5]); redis.call('ZADD',KEYS[2],ARGV[5],ARGV[1]) end; redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); return 1`, [this.key('builds'), this.key(`queue:${computer.id}`), this.key('computer-secrets')], [buildId, computer.id, claimId, JSON.stringify(small), Date.now() + 900_000, resultKey, digest]);
    if (changed !== 1 && data.state === 'complete') await this.redis.del(resultKey);
    if (changed !== 1) invalid('Build claim is no longer active');
  }
}
