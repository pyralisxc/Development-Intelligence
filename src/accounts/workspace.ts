import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Redis } from '@upstash/redis';

export type Project = { id: string; name: string };
export type GraphDefinition = {
  id: string; projectId: string; name: string;
  source: { kind: 'local-folder' | 'git'; location: string; revision?: string };
  buildComputer: string; storage: { computer: string; location: string };
  query?: { computer: string; location: string };
  hostedResources?: { buildVcpus: number; queryVcpus: number; timeoutMinutes: number };
  transfer?: { kind: 'shared-folder'; buildLocation: string; storageLocation: string };
  updatePolicy: 'snapshot';
};
export type Computer = { id: string; name: string; platform: string; lastSeen: string; state: 'linked' | 'revoked' };
export type BuildJob = { id: string; kind?: 'build' | 'question' | 'investigation'; question?: string; graphId?: string; request?: { path: string; method: 'GET' | 'POST'; query?: string; body?: unknown }; graph: GraphDefinition; project: Project; state: 'queued' | 'running' | 'complete' | 'failed'; createdAt: string; leaseUntil?: number; claimId?: string; progress?: unknown; result?: unknown; resultKey?: string; resultParts?: number; error?: string; assignedComputer?: string; stage?: 'build' | 'transfer'; hosted?: { sandbox: string; command: string; statusFile: string } };
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
function serviceId(input: unknown): string { return input === 'hosted' ? 'hosted' : id(input); }
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
  async builds(includeResults = true): Promise<BuildJob[]> {
    await this.ensureIndexed();
    const ids = await this.redis.zrange<string[]>(this.key('build-history'), 0, -1);
    if (!ids.length) return [];
    const pipe = this.redis.pipeline();
    for (const jobId of ids) pipe.hget(this.key('builds'), jobId);
    const jobs = (await pipe.exec()).filter((job): job is BuildJob => Boolean(job && typeof job === 'object'));
    return includeResults ? await Promise.all(jobs.map(async job => job.resultKey ? { ...job, result: await this.redis.get(job.resultKey) } : job)) : jobs.map(({ result: _result, ...job }) => job);
  }
  async build(jobId: unknown): Promise<ComputerJob | null> {
    const job = await this.redis.hget<ComputerJob>(this.key('builds'), id(jobId));
    return job?.resultKey && !(job.kind === 'investigation' && job.resultParts) ? { ...job, result: await this.redis.get(job.resultKey) } : job;
  }
  /** Read an account-owned investigation one transport part at a time. */
  async investigationPart(jobId: unknown, index: number): Promise<string> {
    const job = await this.redis.hget<ComputerJob>(this.key('builds'), id(jobId));
    if (!job || job.kind !== 'investigation' || job.state !== 'complete' || !job.resultKey || !job.resultParts || !Number.isSafeInteger(index) || index < 0 || index >= job.resultParts) invalid('Investigation result part is unavailable');
    const part = await this.redis.hget<string>(job.resultKey, String(index));
    if (typeof part !== 'string' || !part.startsWith('b:')) throw new Error('Investigation result is incomplete');
    return part.slice(2);
  }
  /** Accept a bounded part only from the computer holding the active job claim. */
  async putInvestigationPart(computerId: unknown, secret: unknown, jobId: unknown, claim: unknown, index: unknown, part: unknown): Promise<void> {
    const computer = await this.verifyComputer(computerId, secret), jobKey = id(jobId), claimKey = id(claim);
    if (!Number.isSafeInteger(index) || Number(index) < 0 || typeof part !== 'string' || part.length > 300_000 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(part)) invalid('Invalid investigation result part');
    const digest = typeof secret === 'string' ? createHash('sha256').update(secret).digest('hex') : '';
    const key = this.key(`result:${jobKey}:${claimKey}`);
    const changed = await this.redis.eval<unknown[], number>(`if redis.call('HGET',KEYS[2],ARGV[2])~=ARGV[3] then return 0 end; local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.kind~='investigation' or job.state~='running' or job.assignedComputer~=ARGV[2] or job.claimId~=ARGV[4] then return 0 end; redis.call('HSET',KEYS[3],ARGV[5],ARGV[6]); redis.call('EXPIRE',KEYS[3],86400); return 1`, [this.key('builds'), this.key('computer-secrets'), key], [jobKey, computer.id, digest, claimKey, String(index), `b:${part}`]);
    if (changed !== 1) invalid('Investigation claim is no longer active');
  }
  private async enqueue(job: ComputerJob): Promise<void> {
    await this.ensureIndexed();
    const computer = job.kind === 'browse' ? job.computerId : job.assignedComputer ?? job.graph.buildComputer;
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
      buildComputer: serviceId(data.buildComputer), storage: { computer: serviceId(storage.computer), location: storage.computer === 'hosted' ? '/data/graphs' : value(storage.location, 'Graph storage location') }, updatePolicy: 'snapshot' };
    if (data.transfer !== undefined && data.transfer !== null) {
      const transfer = object(data.transfer);
      if (transfer.kind !== 'shared-folder') invalid('Unsupported graph transfer method');
      graph.transfer = { kind: 'shared-folder', buildLocation: value(transfer.buildLocation, 'Shared folder on the build computer'), storageLocation: value(transfer.storageLocation, 'Shared folder on the storage computer') };
    }
    if (data.query !== undefined && data.query !== null) {
      const query = object(data.query);
      graph.query = { computer: serviceId(query.computer), location: query.computer === 'hosted' ? '/data/graphs' : value(query.location, 'Graph location available to the query service') };
    }
    if (data.hostedResources !== undefined && data.hostedResources !== null) {
      const resources = object(data.hostedResources);
      const buildVcpus = Number(resources.buildVcpus), queryVcpus = Number(resources.queryVcpus), timeoutMinutes = Number(resources.timeoutMinutes);
      if (![buildVcpus, queryVcpus].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 8) || !Number.isSafeInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 1440) invalid('Choose hosted CPUs from 1–8 and a session duration from 1–1440 minutes');
      graph.hostedResources = { buildVcpus, queryVcpus, timeoutMinutes };
    }
    if (data.id !== undefined && !await this.redis.hexists(this.key('graphs'), graph.id)) invalid('Graph does not exist');
    const computers = await this.computers();
    if (![graph.buildComputer, graph.storage.computer, ...(graph.query ? [graph.query.computer] : [])].every(computer => computer === 'hosted' || computers.some(item => item.id === computer && item.state === 'linked'))) invalid('Choose linked computers');
    await this.redis.hset(this.key('graphs'), { [graph.id]: graph }); return graph;
  }
  async queueBuild(graphId: unknown): Promise<BuildJob> {
    const graph = await this.redis.hget<GraphDefinition>(this.key('graphs'), id(graphId));
    if (!graph) invalid('Graph does not exist');
    const project = await this.redis.hget<Project>(this.key('projects'), graph.projectId);
    if (!project) invalid('Project does not exist');
    if (graph.buildComputer === 'hosted' && graph.source.kind === 'local-folder') invalid('A hosted build needs a repository source accessible to the hosted service');
    if (graph.buildComputer !== graph.storage.computer && (graph.buildComputer === 'hosted' || graph.storage.computer === 'hosted')) invalid('Transfer between a linked computer and hosted storage is not available yet');
    if (graph.buildComputer !== graph.storage.computer && !graph.transfer) invalid('Choose a transfer method for different build and storage computers');
    const job: BuildJob = { id: recordId(), kind: 'build', graph, project, assignedComputer: graph.buildComputer, stage: 'build', state: 'queued', createdAt: new Date().toISOString() };
    await this.enqueue(job); return job;
  }
  async queueQuestion(graphId: unknown, question: unknown): Promise<BuildJob> {
    const graph = await this.redis.hget<GraphDefinition>(this.key('graphs'), id(graphId));
    if (!graph) invalid('Graph does not exist');
    const project = await this.redis.hget<Project>(this.key('projects'), graph.projectId);
    if (!project) invalid('Project does not exist');
    const newest = (await this.builds(false)).filter(job => job.graph.id === graph.id && job.kind === 'build' && job.state === 'complete').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const latest = newest ? await this.build(newest.id) as BuildJob | null : null;
    const built = latest?.result as { graphId?: unknown } | undefined;
    if (typeof built?.graphId !== 'string') invalid('Build a snapshot of this graph first');
    const query = graph.query ?? { computer: latest!.graph.storage.computer, location: latest!.graph.storage.location };
    if (query.computer === 'hosted' && latest!.graph.storage.computer !== 'hosted') invalid('Transfer this snapshot to hosted storage before querying it with the hosted service');
    const job: BuildJob = { id: recordId(), kind: 'question', question: value(question, 'Question'), graphId: built.graphId, graph: { ...latest!.graph, query, ...(graph.hostedResources ? { hostedResources: graph.hostedResources } : {}) }, project, assignedComputer: query.computer, state: 'queued', createdAt: new Date().toISOString() };
    await this.enqueue(job); return job;
  }
  async queueInvestigation(graphId: unknown, input: unknown): Promise<BuildJob> {
    const request = object(input), path = value(request.path, 'Investigation path');
    if (!['/workbench/data', '/workbench/source', '/workbench/query', '/workbench/parity', '/graph/data'].includes(path)) invalid('Unsupported investigation');
    const method = request.method === 'POST' ? 'POST' : 'GET';
    if ((path === '/workbench/query' || path === '/workbench/parity') !== (method === 'POST')) invalid('Unsupported investigation method');
    const graph = await this.redis.hget<GraphDefinition>(this.key('graphs'), id(graphId));
    if (!graph) invalid('Graph does not exist');
    const project = await this.redis.hget<Project>(this.key('projects'), graph.projectId);
    if (!project) invalid('Project does not exist');
    const newest = (await this.builds(false)).filter(job => job.graph.id === graph.id && job.kind === 'build' && job.state === 'complete').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const latest = newest ? await this.build(newest.id) as BuildJob | null : null;
    const built = latest?.result as { graphId?: unknown } | undefined;
    if (typeof built?.graphId !== 'string') invalid('Build a snapshot of this graph first');
    const query = graph.query ?? { computer: latest!.graph.storage.computer, location: latest!.graph.storage.location };
    if (query.computer === 'hosted' && latest!.graph.storage.computer !== 'hosted') invalid('Transfer this snapshot to hosted storage before querying it with the hosted service');
    const job: BuildJob = { id: recordId(), kind: 'investigation', graphId: built.graphId, graph: { ...latest!.graph, query, ...(graph.hostedResources ? { hostedResources: graph.hostedResources } : {}) }, project, assignedComputer: query.computer, state: 'queued', createdAt: new Date().toISOString(), request: { path, method,
      ...(typeof request.query === 'string' ? { query: request.query } : {}), ...(request.body === undefined ? {} : { body: request.body }) } };
    await this.enqueue(job); return job;
  }
  async claimBuild(computerId: unknown, secret: unknown): Promise<ComputerJob | null> {
    await this.ensureIndexed();
    const computer = await this.heartbeat(computerId, secret);
    const now = Date.now();
    const digest = typeof secret === 'string' ? createHash('sha256').update(secret).digest('hex') : '';
    const claimed = await this.redis.eval<unknown[], string | null>(`if redis.call('HGET',KEYS[3],ARGV[4])~=ARGV[5] then return nil end; local ids=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',ARGV[1],'LIMIT',0,1); if #ids==0 then return nil end; local raw=redis.call('HGET',KEYS[1],ids[1]); if not raw then redis.call('ZREM',KEYS[2],ids[1]); return nil end; local job=cjson.decode(raw); job.state='running'; job.leaseUntil=tonumber(ARGV[2]); job.claimId=ARGV[3]; local value=cjson.encode(job); redis.call('HSET',KEYS[1],ids[1],value); redis.call('ZADD',KEYS[2],ARGV[2],ids[1]); return value`, [this.key('builds'), this.key(`queue:${computer.id}`), this.key('computer-secrets')], [now, now + 900_000, recordId(), computer.id, digest]);
    if (!claimed) return null;
    const job = typeof claimed === 'string' ? JSON.parse(claimed) as ComputerJob : claimed as unknown as ComputerJob;
    return job.resultKey ? { ...job, result: await this.redis.get(job.resultKey) } : job;
  }
  /** Claim one account-hosted job without issuing it a linked-computer credential. */
  async claimHosted(jobId: unknown): Promise<BuildJob | null> {
    const jobKey = id(jobId), claim = recordId(), now = Date.now();
    const existing = await this.redis.hget<BuildJob>(this.key('builds'), jobKey);
    const duration = existing?.graph.hostedResources?.timeoutMinutes ? existing.graph.hostedResources.timeoutMinutes * 60_000 : Number(process.env.DEVINT_HOSTED_SANDBOX_TIMEOUT_MS || 3_600_000);
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 86_400_000) invalid('Invalid hosted sandbox duration');
    const raw = await this.redis.eval<unknown[], string | null>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return nil end; local job=cjson.decode(raw); if job.state~='queued' or job.assignedComputer~='hosted' then return nil end; if job.kind=='build' and not redis.call('SET',KEYS[3],ARGV[1],'NX','PX',ARGV[4]) then return nil end; job.state='running'; job.claimId=ARGV[2]; job.leaseUntil=tonumber(ARGV[3]); job.progress={stage='starting-hosted-worker'}; local out=cjson.encode(job); redis.call('HSET',KEYS[1],ARGV[1],out); redis.call('ZADD',KEYS[2],ARGV[3],ARGV[1]); return out`, [this.key('builds'), this.key('queue:hosted'), this.key('hosted-build-lock')], [jobKey, claim, now + duration, duration + 60_000]);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) as BuildJob : raw as unknown as BuildJob;
  }
  async hostedStarted(jobId: string, claimId: string, handle: NonNullable<BuildJob['hosted']>): Promise<void> {
    const changed = await this.redis.eval<unknown[], number>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.state~='running' or job.assignedComputer~='hosted' or job.claimId~=ARGV[2] then return 0 end; job.hosted=cjson.decode(ARGV[3]); redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); return 1`, [this.key('builds')], [id(jobId), id(claimId), JSON.stringify(handle)]);
    if (changed !== 1) invalid('Hosted job claim is no longer active');
  }
  async updateHosted(jobId: string, claimId: string, status: { state: 'running' | 'complete' | 'failed'; progress?: unknown; result?: unknown; error?: string }): Promise<void> {
    const key = this.key(`result:${id(jobId)}:${id(claimId)}`);
    const current = status.state === 'complete' ? await this.redis.hget<BuildJob>(this.key('builds'), id(jobId)) : null;
    let resultParts: number | undefined;
    if (status.state === 'complete' && current?.kind === 'investigation') {
      const bytes = Buffer.from(JSON.stringify(status.result ?? null), 'utf8'), size = 192 * 1024;
      resultParts = Math.ceil(bytes.length / size);
      for (let index = 0; index < resultParts; index++) await this.redis.hset(key, { [String(index)]: `b:${bytes.subarray(index * size, (index + 1) * size).toString('base64')}` });
      await this.redis.expire(key, 86400);
    } else if (status.state === 'complete') await this.redis.set(key, status.result ?? null);
    const { result: _result, ...rest } = status;
    const small = { ...rest, ...(resultParts ? { resultParts } : {}) };
    const changed = await this.redis.eval<unknown[], number>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.state~='running' or job.assignedComputer~='hosted' or job.claimId~=ARGV[2] then return 0 end; local update=cjson.decode(ARGV[3]); if update.state=='running' then job.progress=update.progress else job.state=update.state; job.leaseUntil=nil; if update.state=='complete' then if update.resultParts then if redis.call('HLEN',KEYS[4])~=update.resultParts then return 0 end; job.resultParts=update.resultParts; redis.call('PERSIST',KEYS[4]) end; job.resultKey=ARGV[4] else job.error=update.error end; redis.call('ZREM',KEYS[2],ARGV[1]) end; redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); return 1`, [this.key('builds'), this.key('queue:hosted'), this.key('hosted-build-lock'), key], [jobId, claimId, JSON.stringify(small), key]);
    if (changed !== 1 && status.state === 'complete') {
      const completed = await this.redis.hget<BuildJob>(this.key('builds'), jobId);
      if (completed?.resultKey !== key) await this.redis.del(key);
      else if (completed.resultParts) await this.redis.persist(key);
    }
    if (changed !== 1) invalid('Hosted job claim is no longer active');
  }
  async releaseHostedBuild(jobId: string): Promise<void> {
    await this.redis.eval<unknown[], number>(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`, [this.key('hosted-build-lock')], [id(jobId)]);
  }
  async updateBuild(computerId: unknown, secret: unknown, jobId: unknown, update: unknown): Promise<void> {
    const computer = await this.heartbeat(computerId, secret), data = object(update), buildId = id(jobId), claimId = id(data.claimId);
    const { result, ...small } = data;
    const resultKey = this.key(`result:${buildId}:${claimId}`);
    const resultParts = data.resultParts;
    if (resultParts !== undefined && (!Number.isSafeInteger(resultParts) || Number(resultParts) < 1)) invalid('Invalid investigation result manifest');
    if (data.state === 'complete' && resultParts === undefined) await this.redis.set(resultKey, result ?? null);
    const digest = typeof secret === 'string' ? createHash('sha256').update(secret).digest('hex') : '';
    const changed = await this.redis.eval<unknown[], number>(`if redis.call('HGET',KEYS[3],ARGV[2])~=ARGV[7] then return 0 end; local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); local owner=job.kind=='browse' and job.computerId or (job.assignedComputer or job.graph.buildComputer); if job.state~='running' or owner~=ARGV[2] or job.claimId~=ARGV[3] then return 0 end; local update=cjson.decode(ARGV[4]); if update.state=='complete' then if update.resultParts then if job.kind~='investigation' or redis.call('HLEN',KEYS[4])~=update.resultParts then return 0 end; job.resultParts=update.resultParts; redis.call('PERSIST',KEYS[4]) end; job.resultKey=ARGV[6]; job.result=nil; job.leaseUntil=nil; redis.call('ZREM',KEYS[2],ARGV[1]); if job.kind=='build' and job.stage=='build' and job.graph.buildComputer~=job.graph.storage.computer then job.state='queued'; job.stage='transfer'; job.assignedComputer=job.graph.storage.computer; job.progress={stage='waiting-for-storage-computer'}; job.claimId=nil; redis.call('ZADD',ARGV[8]..job.assignedComputer,ARGV[9],ARGV[1]) else job.state='complete' end elseif update.state=='failed' then job.state='failed'; job.error=update.error; job.leaseUntil=nil; redis.call('ZREM',KEYS[2],ARGV[1]) else job.progress=update.progress; job.leaseUntil=tonumber(ARGV[5]); redis.call('ZADD',KEYS[2],ARGV[5],ARGV[1]) end; redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); return 1`, [this.key('builds'), this.key(`queue:${computer.id}`), this.key('computer-secrets'), resultKey], [buildId, computer.id, claimId, JSON.stringify(small), Date.now() + 900_000, resultKey, digest, `${this.root}:queue:`, Date.now()]);
    if (changed !== 1 && data.state === 'complete') {
      const current = await this.redis.hget<ComputerJob>(this.key('builds'), buildId);
      if (current?.resultKey !== resultKey) await this.redis.del(resultKey);
    }
    if (changed !== 1) invalid('Build claim is no longer active');
  }
}
