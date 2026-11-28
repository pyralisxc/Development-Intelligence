import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Redis } from '@upstash/redis';

export type Project = { id: string; name: string };
export type LegacyGraphTarget = { name: string; graphId: string };
export type SnapshotReference = { legacyTarget?: LegacyGraphTarget; graphId: string; revision?: string | null; sourceState?: unknown; sourceFingerprint?: string | null; requestedAt: string; jobId: string; source: GraphDefinition['source']; storage: GraphDefinition['storage'] };
export type GraphDefinition = {
  currentSnapshot?: SnapshotReference;
  snapshotInitialized?: boolean;
  legacySnapshotUnavailable?: boolean;
  legacySnapshotUnavailableTarget?: string;
  id: string; projectId: string; name: string;
  source: { kind: 'local-folder' | 'git'; location: string; revision?: string };
  buildComputer: string; storage: { computer: string; location: string };
  query?: { computer: string; location: string };
  hostedResources?: { buildVcpus: number; queryVcpus: number; timeoutMinutes: number };
  transfer?: { kind: 'shared-folder'; buildLocation: string; storageLocation: string } | { kind: 'direct-hosted' };
  updatePolicy: 'snapshot';
};
export type Computer = { sharedTransferV2?: boolean; id: string; name: string; platform: string; lastSeen: string; state: 'linked' | 'revoked' };
export type BuildJob = { retainedLegacyTargets?: string[]; cleanupLegacyTarget?: LegacyGraphTarget; discardWhenComplete?: boolean; sharedTransferClaim?: string; claimScopedTransfer?: boolean; graphLease?: boolean; previousSnapshot?: SnapshotReference; snapshotStaging?: boolean; id: string; kind?: 'build' | 'question' | 'investigation'; question?: string; graphId?: string; request?: { path: string; method: 'GET' | 'POST'; query?: string; body?: unknown }; graph: GraphDefinition; project: Project; state: 'queued' | 'running' | 'complete' | 'failed'; createdAt: string; leaseUntil?: number; claimId?: string; progress?: unknown; sourceStage?: { reused: number; total: number }; result?: unknown; resultKey?: string; resultParts?: number; resultExpiresAt?: number; transferGraphId?: string; previousTransfer?: { claimId: string; graphId: string }; error?: string; assignedComputer?: string; stage?: 'build' | 'transfer' | 'cleanup'; cleanupResult?: Record<string, unknown>; hosted?: { sandbox: string; command: string; statusFile: string } };
export type BrowseJob = { id: string; kind: 'browse'; computerId: string; path?: string; state: 'queued' | 'running' | 'complete' | 'failed'; createdAt: string; leaseUntil?: number; claimId?: string; result?: unknown; resultKey?: string; error?: string };
type ComputerJob = BuildJob | BrowseJob;
// Investigation results are transient transport payloads; saved build results
// carry graph identity and must remain available until their own lifecycle ends.
const INVESTIGATION_RESULT_TTL_SECONDS = 24 * 60 * 60;

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
function sourceStageSummary(result: unknown): { reused: number; total: number } | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const stage = (result as { sourceStage?: unknown }).sourceStage;
  if (!stage || typeof stage !== 'object' || Array.isArray(stage)) return undefined;
  const { reused, total } = stage as { reused?: unknown; total?: unknown };
  if (!Number.isSafeInteger(reused) || !Number.isSafeInteger(total) || Number(reused) < 0 || Number(total) < Number(reused)) return undefined;
  return { reused: Number(reused), total: Number(total) };
}
function recordId(): string { return randomBytes(16).toString('hex'); }
export function hostedTransferToken(secretDigest: string, jobId: string, claimId: string, graphId: string): string { return createHmac('sha256', secretDigest).update(`${jobId}:${claimId}:${graphId}`).digest('base64url'); }

/** Account records are separate Redis fields so project count is not a whole-document limit. */
export class WorkspaceStore {
  private readonly redis: Redis;
  private readonly root: string;
  private readonly hostedAccountsKey: string;
  private readonly userId: string;
  constructor(userId: string) {
    const url = process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.KV_REST_API_URL?.trim();
    const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || process.env.KV_REST_API_TOKEN?.trim();
    const scope = process.env.DEVINT_ACCOUNT_NAMESPACE?.trim();
    if (!url || !token || !scope || !/^[a-zA-Z0-9_-]+$/u.test(scope)) throw new Error('Account storage is not configured for this environment');
    this.redis = new Redis({ url, token, enableTelemetry: false });
    const account = createHash('sha256').update(userId).digest('hex');
    this.root = `di:accounts:${scope}:${account}`;
    this.hostedAccountsKey = `di:accounts:${scope}:hosted-dispatch`;
    this.userId = userId;
  }
  private key(kind: string): string { return `${this.root}:${kind}`; }
  private async ensureIndexed(): Promise<void> {
    await this.redis.eval<unknown[], number>(`if redis.call('EXISTS',KEYS[1])==1 then return 0 end; local all=redis.call('HGETALL',KEYS[2]); for i=1,#all,2 do local ok,job=pcall(cjson.decode,all[i+1]); if ok and job.id then local score=tonumber(ARGV[2])+i; if job.kind~='investigation' and job.kind~='question' and job.kind~='browse' then redis.call('ZADD',KEYS[3],score,job.id) end; local computer=job.kind=='browse' and job.computerId or (job.assignedComputer or (job.graph and job.graph.buildComputer)); if computer and (job.state=='queued' or job.state=='running') then redis.call('ZADD',ARGV[1]..computer,job.leaseUntil or score,job.id) end end end; redis.call('SET',KEYS[1],'1'); return 1`, [this.key('jobs-index-v1'), this.key('builds'), this.key('build-history')], [`${this.root}:queue:`, Date.now()]);
  }
  async project(projectId: unknown): Promise<Project | null> { return await this.redis.hget<Project>(this.key('projects'), id(projectId)); }
  async projects(): Promise<Project[]> { return Object.values(await this.redis.hgetall<Record<string, Project>>(this.key('projects')) ?? {}); }
  async graphs(): Promise<GraphDefinition[]> { return Object.values(await this.redis.hgetall<Record<string, GraphDefinition>>(this.key('graphs')) ?? {}); }
  async computers(): Promise<Computer[]> { return Object.values(await this.redis.hgetall<Record<string, Computer>>(this.key('computers')) ?? {}); }
  async builds(includeResults = true): Promise<BuildJob[]> {
    if (!await this.redis.exists(this.key('jobs-index-v1'))) {
      const all = Object.values(await this.redis.hgetall<Record<string, ComputerJob>>(this.key('builds')) ?? {});
      const jobs = all.filter((job): job is BuildJob => job.kind !== 'browse' && job.kind !== 'investigation' && job.kind !== 'question');
      return includeResults ? await Promise.all(jobs.map(async job => job.resultKey ? { ...job, result: await this.redis.get(job.resultKey) } : job)) : jobs.map(({ result: _result, ...job }) => job);
    }
    const ids = await this.redis.zrange<string[]>(this.key('build-history'), 0, -1);
    if (!ids.length) return [];
    const pipe = this.redis.pipeline();
    for (const jobId of ids) pipe.hget(this.key('builds'), jobId);
    const jobs = (await pipe.exec()).filter((job): job is BuildJob => Boolean(job && typeof job === 'object' && (job as BuildJob).kind !== 'investigation' && (job as BuildJob).kind !== 'question'));
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
    if (typeof part !== 'string' || !part.startsWith('b:')) {
      if (job.resultExpiresAt && Date.now() >= job.resultExpiresAt && !await this.redis.exists(job.resultKey)) throw Object.assign(new Error('This temporary investigation result expired. Reopen the graph and run the investigation again.'), { status: 410 });
      throw new Error('Investigation result is incomplete');
    }
    return part.slice(2);
  }
  /** Retire one delivered or abandoned transient investigation, never a saved build. */
  async discardInvestigation(jobId: unknown): Promise<BuildJob | null> {
    const key = id(jobId);
    const raw = await this.redis.eval<unknown[], string | null>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return nil end; local job=cjson.decode(raw); if job.kind~='investigation' and job.kind~='question' then return nil end; if job.resultKey then redis.call('DEL',job.resultKey) end; if job.claimId then redis.call('DEL',ARGV[3]..job.id..':'..job.claimId) end; local computer=job.assignedComputer or job.graph.buildComputer; if computer~='hosted' and job.state=='running' then job.discardWhenComplete=true; job.question=nil; job.request=nil; redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); redis.call('HEXPIRE',KEYS[1],86400,'FIELDS',1,ARGV[1]); return raw end; if computer then redis.call('ZREM',ARGV[2]..computer,job.id) end; redis.call('HDEL',KEYS[1],ARGV[1]); return raw`, [this.key('builds')], [key, `${this.root}:queue:`, `${this.root}:result:`]);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) as BuildJob : raw as unknown as BuildJob) : null;
  }
  /** Accept a bounded part only from the computer holding the active job claim. */
  async putInvestigationPart(computerId: unknown, secret: unknown, jobId: unknown, claim: unknown, index: unknown, part: unknown): Promise<void> {
    const computer = await this.verifyComputer(computerId, secret), jobKey = id(jobId), claimKey = id(claim);
    if (!Number.isSafeInteger(index) || Number(index) < 0 || typeof part !== 'string' || part.length > 300_000 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(part)) invalid('Invalid investigation result part');
    const digest = typeof secret === 'string' ? createHash('sha256').update(secret).digest('hex') : '';
    const key = this.key(`result:${jobKey}:${claimKey}`);
    const changed = await this.redis.eval<unknown[], number>(`if redis.call('HGET',KEYS[2],ARGV[2])~=ARGV[3] then return 0 end; local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.kind~='investigation' or job.state~='running' or job.assignedComputer~=ARGV[2] or job.claimId~=ARGV[4] then return 0 end; if job.discardWhenComplete then return 1 end; redis.call('HSET',KEYS[3],ARGV[5],ARGV[6]); redis.call('EXPIRE',KEYS[3],86400); return 1`, [this.key('builds'), this.key('computer-secrets'), key], [jobKey, computer.id, digest, claimKey, String(index), `b:${part}`]);
    if (changed !== 1) invalid('Investigation claim is no longer active');
  }
  private async enqueue(job: ComputerJob): Promise<void> {
    await this.ensureIndexed();
    const computer = job.kind === 'browse' ? job.computerId : job.assignedComputer ?? job.graph.buildComputer;
    await this.redis.eval<unknown[], number>(`redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]); local job=cjson.decode(ARGV[2]); if job.kind=='investigation' or job.kind=='question' then redis.call('HEXPIRE',KEYS[1],86400,'FIELDS',1,ARGV[1]) end; redis.call('ZADD',KEYS[2],ARGV[3],ARGV[1]); if ARGV[4]=='1' then redis.call('ZADD',KEYS[3],ARGV[3],ARGV[1]) end; if ARGV[5]=='1' then redis.call('ZADD',KEYS[4],ARGV[3],ARGV[6]) end; return 1`, [this.key('builds'), this.key(`queue:${computer}`), this.key('build-history'), this.hostedAccountsKey], [job.id, JSON.stringify(job), Date.now(), job.kind === 'investigation' || job.kind === 'question' || job.kind === 'browse' ? '0' : '1', computer === 'hosted' ? '1' : '0', this.userId]);
  }
  /** Explicitly enroll pre-existing hosted work without executing it as part of a read. */
  async registerHostedWork(): Promise<boolean> {
    await this.ensureIndexed();
    return await this.redis.eval<unknown[], number>(`local all=redis.call('HGETALL',KEYS[3]); for i=1,#all,2 do local ok,job=pcall(cjson.decode,all[i+1]); if ok and job.kind~='browse' and job.graph and (job.state=='queued' or job.state=='running') and (job.assignedComputer or job.graph.buildComputer)=='hosted' then redis.call('ZADD',KEYS[1],job.leaseUntil or ARGV[1],job.id); if job.assignedComputer=='hosted' and job.graph.buildComputer~='hosted' then redis.call('ZREM',ARGV[3]..job.graph.buildComputer,job.id) end end end; if redis.call('ZCARD',KEYS[1])>0 then redis.call('ZADD',KEYS[2],ARGV[1],ARGV[2]); return 1 end; return 0`, [this.key('queue:hosted'), this.hostedAccountsKey, this.key('builds')], [Date.now(), this.userId, `${this.root}:queue:`]) === 1;
  }
  /** Reserve a bounded, fair batch; a crash makes accounts eligible again. */
  async reserveHostedAccounts(): Promise<string[]> {
    const now = Date.now();
    return await this.redis.eval<unknown[], string[]>(`local users=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[1],'LIMIT',0,8); for _,user in ipairs(users) do redis.call('ZADD',KEYS[1],ARGV[2],user) end; return users`, [this.hostedAccountsKey], [now, now + 60000]) ?? [];
  }
  async hostedJobs(): Promise<ComputerJob[]> {
    const ids = await this.redis.zrange<string[]>(this.key('queue:hosted'), 0, -1);
    const jobs = await Promise.all(ids.map(id => this.build(id)));
    for (let i = 0; i < ids.length; i++) if (!jobs[i]) {
      await this.redis.eval<unknown[], number>(`if redis.call('HEXISTS',KEYS[1],ARGV[1])==0 then return redis.call('ZREM',KEYS[2],ARGV[1]) end; return 0`, [this.key('builds'), this.key('queue:hosted')], [ids[i]]);
    }
    return jobs.filter((job): job is ComputerJob => Boolean(job)).sort((a,b) => Number(b.state === 'running') - Number(a.state === 'running')).slice(0, 10);
  }
  /** Remove idle accounts atomically with enqueue so new work cannot be lost. */
  async forgetIdleHostedAccount(): Promise<void> {
    await this.redis.eval<unknown[], number>(`if redis.call('ZCARD',KEYS[1])==0 then return redis.call('ZREM',KEYS[2],ARGV[1]) end; return 0`, [this.key('queue:hosted'), this.hostedAccountsKey], [this.userId]);
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
  async heartbeat(computerId: unknown, secret: unknown, sharedTransferV2?: boolean): Promise<Computer> {
    const computerKey = id(computerId);
    const digest = typeof secret === 'string' ? createHash('sha256').update(secret).digest('hex') : '';
    const result = await this.redis.eval<unknown[], string | null>(`local secret=redis.call('HGET',KEYS[2],ARGV[1]); local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not secret or secret~=ARGV[2] or not raw then return nil end; local item=cjson.decode(raw); if item.state~='linked' then return nil end; item.lastSeen=ARGV[3]; if ARGV[4]~='' then item.sharedTransferV2=ARGV[4]=='1' end; local out=cjson.encode(item); redis.call('HSET',KEYS[1],ARGV[1],out); return out`, [this.key('computers'), this.key('computer-secrets')], [computerKey, digest, new Date().toISOString(), sharedTransferV2 === undefined ? '' : sharedTransferV2 ? '1' : '0']);
    if (!result) throw Object.assign(new Error('Computer is not linked to this account'), { status: 403 });
    return typeof result === 'string' ? JSON.parse(result) as Computer : result as unknown as Computer;
  }
  async revokeComputer(computerId: unknown): Promise<BuildJob[]> {
    const computerKey = id(computerId);
    const revoked = await this.redis.eval<unknown[], number>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local computer=cjson.decode(raw); computer.state='revoked'; redis.call('HDEL',KEYS[2],ARGV[1]); redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(computer)); return 1`, [this.key('computers'), this.key('computer-secrets')], [computerKey]);
    if (revoked !== 1) invalid('Computer does not exist');
    const queue = this.key(`queue:${computerKey}`), ids = await this.redis.zrange<string[]>(queue, 0, -1);
    const transfers: BuildJob[] = [];
    for (const jobId of ids) {
      const raw = await this.redis.eval<unknown[], string | null>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then redis.call('ZREM',KEYS[2],ARGV[1]); return nil end; local job=cjson.decode(raw); local owner=job.kind=='browse' and job.computerId or (job.assignedComputer or job.graph.buildComputer); if owner~=ARGV[2] or (job.state~='running' and job.state~='queued') then return nil end; job.state='failed'; job.error='The linked computer was unlinked while work was pending'; job.leaseUntil=nil; if job.kind=='investigation' or job.kind=='question' then job.request=nil; job.question=nil end; local out=cjson.encode(job); redis.call('HSET',KEYS[1],ARGV[1],out); if job.kind=='investigation' or job.kind=='question' then redis.call('HEXPIRE',KEYS[1],86400,'FIELDS',1,ARGV[1]) end; redis.call('ZREM',KEYS[2],ARGV[1]); return out`, [this.key('builds'), queue], [jobId, computerKey]);
      if (raw) { const job = typeof raw === 'string' ? JSON.parse(raw) as ComputerJob : raw as unknown as ComputerJob; if (job.kind === 'build' && job.graph.transfer?.kind === 'direct-hosted' && job.transferGraphId && job.claimId) transfers.push(job); }
    }
    return transfers;
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
      if (transfer.kind === 'direct-hosted') graph.transfer = { kind: 'direct-hosted' };
      else if (transfer.kind === 'shared-folder') graph.transfer = { kind: 'shared-folder', buildLocation: value(transfer.buildLocation, 'Shared folder on the build computer'), storageLocation: value(transfer.storageLocation, 'Shared folder on the storage computer') };
      else invalid('Unsupported graph transfer method');
    }
    if (graph.transfer?.kind === 'direct-hosted' && (graph.buildComputer === 'hosted' || graph.storage.computer !== 'hosted')) invalid('Direct hosted transfer requires a linked build computer and hosted storage');
    if (graph.transfer?.kind === 'shared-folder' && (graph.buildComputer === 'hosted' || graph.storage.computer === 'hosted')) invalid('Shared-folder transfer requires linked computers');
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
    const saved = await this.redis.eval<unknown[], string>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); local value=cjson.decode(ARGV[2]); if raw then local old=cjson.decode(raw); value.currentSnapshot=old.currentSnapshot; value.snapshotInitialized=old.snapshotInitialized end; local out=cjson.encode(value); redis.call('HSET',KEYS[1],ARGV[1],out); return out`, [this.key('graphs')], [graph.id, JSON.stringify(graph)]);
    return typeof saved === 'string' ? JSON.parse(saved) as GraphDefinition : saved as unknown as GraphDefinition;
  }
  async queueBuild(graphId: unknown): Promise<BuildJob> {
    const graph = await this.graphWithSnapshot(graphId);
    if (!graph) invalid('Graph does not exist');
    const project = await this.redis.hget<Project>(this.key('projects'), graph.projectId);
    if (!project) invalid('Project does not exist');
    if (graph.buildComputer === 'hosted' && graph.source.kind === 'local-folder') invalid('A hosted build needs a repository source accessible to the hosted service');
    if (graph.buildComputer !== graph.storage.computer && (graph.buildComputer === 'hosted' || graph.storage.computer === 'hosted') && !(graph.buildComputer !== 'hosted' && graph.storage.computer === 'hosted' && graph.transfer?.kind === 'direct-hosted')) invalid('This build and storage combination is not available yet');
    if (graph.buildComputer !== graph.storage.computer && !graph.transfer) invalid('Choose a transfer method for different build and storage computers');
    const { currentSnapshot: _currentSnapshot, snapshotInitialized: _snapshotInitialized, ...buildGraph } = graph;
    const job: BuildJob = { id: recordId(), kind: 'build', graph: buildGraph, project, assignedComputer: graph.buildComputer, stage: 'build', state: 'queued', createdAt: new Date().toISOString() };
    await this.enqueue(job); return job;
  }
  /** Retry a failed direct transfer using its staged generation when available. */
  async retryDirectBuild(jobId: unknown): Promise<BuildJob> {
    const key = id(jobId), existing = await this.redis.hget<BuildJob>(this.key('builds'), key);
    if (!existing || existing.kind !== 'build' || existing.state !== 'failed' || existing.graph.transfer?.kind !== 'direct-hosted' || existing.graph.storage.computer !== 'hosted' || existing.graph.buildComputer === 'hosted') invalid('This build cannot be retried as a direct transfer');
    const raw = await this.redis.eval<unknown[], string | null>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return nil end; local job=cjson.decode(raw); if job.state~='failed' or job.kind~='build' or not job.graph.transfer or job.graph.transfer.kind~='direct-hosted' then return nil end; if job.claimId and job.transferGraphId then job.previousTransfer={claimId=job.claimId,graphId=job.transferGraphId} end; job.state='queued'; job.stage='build'; job.assignedComputer=job.graph.buildComputer; job.error=nil; job.claimId=nil; job.leaseUntil=nil; job.transferGraphId=nil; job.progress={stage='retrying-build-or-transfer'}; local out=cjson.encode(job); redis.call('HSET',KEYS[1],ARGV[1],out); redis.call('ZADD',KEYS[2],ARGV[2],ARGV[1]); return out`, [this.key('builds'), this.key(`queue:${existing.graph.buildComputer}`)], [key, Date.now()]);
    if (!raw) invalid('This build is no longer available to retry');
    return typeof raw === 'string' ? JSON.parse(raw) as BuildJob : raw as unknown as BuildJob;
  }
  /** Convert the one formerly-current build result into the graph owner once. */
  async graphWithSnapshot(graphId: unknown): Promise<GraphDefinition | null> {
    const graph = await this.redis.hget<GraphDefinition>(this.key('graphs'), id(graphId));
    if (!graph || graph.currentSnapshot || graph.snapshotInitialized) return graph;
    const latest = (await this.builds(false)).filter(job => job.kind === 'build' && job.graph.id === graph.id && job.state === 'complete').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    const saved = latest ? await this.build(latest.id) as BuildJob | null : null;
    const result = saved?.result as { graphId?: unknown; revision?: string | null; sourceState?: unknown; sourceFingerprint?: string | null } | undefined;
    if (latest && typeof result?.graphId !== 'string') return { ...graph, legacySnapshotUnavailable: true, ...(typeof latest.graph.name === 'string' && latest.graph.name ? { legacySnapshotUnavailableTarget: latest.graph.name } : {}) };
    const snapshot = latest && result ? { graphId: result.graphId, revision: result.revision ?? null, sourceState: result.sourceState ?? null, sourceFingerprint: result.sourceFingerprint ?? null, requestedAt: latest.createdAt, jobId: latest.id, source: latest.graph.source, storage: latest.graph.storage, ...(!latest.snapshotStaging && typeof latest.graph.name === 'string' && latest.graph.name ? { legacyTarget: { name: latest.graph.name, graphId: result.graphId } } : {}) } : null;
    const raw = await this.redis.eval<unknown[], string | null>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return nil end; local graph=cjson.decode(raw); if not graph.currentSnapshot and not graph.snapshotInitialized then local snapshot=cjson.decode(ARGV[2]); if snapshot~=cjson.null then graph.currentSnapshot=snapshot end; graph.snapshotInitialized=true; raw=cjson.encode(graph); redis.call('HSET',KEYS[1],ARGV[1],raw) end; return raw`, [this.key('graphs')], [graph.id, JSON.stringify(snapshot)]);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) as GraphDefinition : raw as unknown as GraphDefinition) : null;
  }
  async queueQuestion(graphId: unknown, question: unknown): Promise<BuildJob> {
    const graph = await this.graphWithSnapshot(graphId);
    if (!graph) invalid('Graph does not exist');
    const project = await this.redis.hget<Project>(this.key('projects'), graph.projectId);
    if (!project) invalid('Project does not exist');
    const latest = graph.currentSnapshot;
    const built = latest;
    if (typeof built?.graphId !== 'string') invalid('Build a snapshot of this graph first');
    const query = graph.query ?? { computer: latest!.storage.computer, location: latest!.storage.location };
    if (query.computer === 'hosted' && latest!.storage.computer !== 'hosted') invalid('Transfer this snapshot to hosted storage before querying it with the hosted service');
    const { currentSnapshot: _snapshot, snapshotInitialized: _initialized, ...executionGraph } = graph;
    const job: BuildJob = { id: recordId(), kind: 'question', question: value(question, 'Question'), graphId: built.graphId, graph: { ...executionGraph, source: latest!.source, storage: latest!.storage, query, ...(graph.hostedResources ? { hostedResources: graph.hostedResources } : {}) }, project, assignedComputer: query.computer, state: 'queued', createdAt: new Date().toISOString() };
    await this.enqueue(job); return job;
  }
  async queueInvestigation(graphId: unknown, input: unknown, snapshotGraphId?: unknown, runOn?: unknown): Promise<BuildJob> {
    const request = object(input), path = value(request.path, 'Investigation path');
    if (!['/workbench/data', '/workbench/source', '/workbench/query', '/workbench/parity', '/graph/data'].includes(path)) invalid('Unsupported investigation');
    const method = request.method === 'POST' ? 'POST' : 'GET';
    if ((path === '/workbench/query' || path === '/workbench/parity') !== (method === 'POST')) invalid('Unsupported investigation method');
    const graph = await this.graphWithSnapshot(graphId);
    if (!graph) invalid('Graph does not exist');
    const project = await this.redis.hget<Project>(this.key('projects'), graph.projectId);
    if (!project) invalid('Project does not exist');
    const latest = graph.currentSnapshot;
    const built = latest;
    if (typeof built?.graphId !== 'string') invalid('Build a snapshot of this graph first');
    if (snapshotGraphId && snapshotGraphId !== built.graphId) invalid('The selected graph snapshot has changed. Reopen the graph to inspect its current snapshot.');
    const configured = graph.query ?? { computer: latest!.storage.computer, location: latest!.storage.location };
    const storage = latest!.storage;
    const selected = runOn === undefined || runOn === '' ? configured.computer : serviceId(runOn);
    const query = selected === configured.computer ? configured : selected === storage.computer ? storage : invalid('That computer is not configured to read this saved snapshot');
    if (selected !== 'hosted' && !(await this.computers()).some(computer => computer.id === selected && computer.state === 'linked')) invalid('That computer is not linked to this account');
    if (query.computer === 'hosted' && latest!.storage.computer !== 'hosted') invalid('Transfer this snapshot to hosted storage before querying it with the hosted service');
    const { currentSnapshot: _snapshot, snapshotInitialized: _initialized, ...executionGraph } = graph;
    const job: BuildJob = { id: recordId(), kind: 'investigation', graphId: built.graphId, graph: { ...executionGraph, source: latest!.source, storage: latest!.storage, query, ...(graph.hostedResources ? { hostedResources: graph.hostedResources } : {}) }, project, assignedComputer: query.computer, state: 'queued', createdAt: new Date().toISOString(), request: { path, method,
      ...(typeof request.query === 'string' ? { query: request.query } : {}), ...(request.body === undefined ? {} : { body: request.body }) } };
    await this.enqueue(job); return job;
  }
  async recordHostedTransfer(job: BuildJob, secret: string, graphId: string): Promise<void> {
    const digest = createHash('sha256').update(secret).digest('hex');
    const saved = await this.redis.eval<unknown[], number>(`if redis.call('HGET',KEYS[2],ARGV[2])~=ARGV[3] then return 0 end; local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.state~='running' or job.claimId~=ARGV[4] or job.assignedComputer~=ARGV[2] then return 0 end; if job.transferGraphId and job.transferGraphId~=ARGV[5] then return 0 end; job.transferGraphId=ARGV[5]; redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); return 1`, [this.key('builds'), this.key('computer-secrets')], [job.id, job.graph.buildComputer, digest, job.claimId, graphId]);
    if (saved !== 1) invalid('Graph transfer claim is no longer active');
  }
  async clearPreviousHostedTransfer(job: BuildJob): Promise<void> {
    const changed = await this.redis.eval<unknown[], number>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.state~='running' or job.claimId~=ARGV[2] then return 0 end; job.previousTransfer=nil; redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); return 1`, [this.key('builds')], [job.id, job.claimId]);
    if (changed !== 1) invalid('Graph transfer claim is no longer active');
  }
  /** The receiver keeps its claim only while the linked computer remains authorized. */
  async verifyHostedTransferLease(jobId: unknown, claimId: unknown, graphId: unknown, token: unknown, requirePublished = false): Promise<boolean> {
    if (typeof graphId !== 'string' || !graphId || typeof token !== 'string') return false;
    const job = await this.redis.hget<BuildJob>(this.key('builds'), id(jobId));
    if (!job || job.kind !== 'build' || job.state !== 'running' || (job.stage !== 'build' && job.stage !== 'cleanup') || job.claimId !== id(claimId) || job.graph.transfer?.kind !== 'direct-hosted' || job.graph.storage.computer !== 'hosted' || job.assignedComputer !== job.graph.buildComputer) return false;
    if (job.graphLease && await this.redis.get<string>(this.key(`graph-lease:${job.graph.id}`)) !== job.id) return false;
    if (requirePublished) { const graph = await this.redis.hget<GraphDefinition>(this.key('graphs'), job.graph.id); if (job.stage !== 'cleanup' || !graph?.currentSnapshot || graph.currentSnapshot.jobId !== job.id || graph.currentSnapshot.graphId !== graphId) return false; }
    const computer = await this.redis.hget<Computer>(this.key('computers'), job.graph.buildComputer);
    const digest = await this.redis.hget<string>(this.key('computer-secrets'), job.graph.buildComputer);
    if (!computer || computer.state !== 'linked' || typeof digest !== 'string') return false;
    const expected = hostedTransferToken(digest, job.id, job.claimId!, graphId);
    return token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  }
  async directHostedTransferClaim(computerId: unknown, secret: unknown, jobId: unknown, claimId: unknown, graphId: unknown, allowComplete = false): Promise<BuildJob> {
    const computer = await this.verifyComputer(computerId, secret), job = await this.build(jobId);
    if (!job || job.kind !== 'build' || (job.state !== 'running' && !(allowComplete && job.state === 'complete')) || (job.stage !== 'build' && job.stage !== 'cleanup') || (job.stage === 'cleanup' && (job.cleanupResult?.graphId ?? (allowComplete ? job.transferGraphId : undefined)) !== graphId) || job.claimId !== id(claimId) || job.assignedComputer !== computer.id || job.graph.buildComputer !== computer.id || job.graph.storage.computer !== 'hosted' || job.graph.transfer?.kind !== 'direct-hosted' || typeof graphId !== 'string' || !graphId) throw Object.assign(new Error('Graph transfer is not assigned to this computer'), { status: 403 });
    if (job.state === 'running' && job.graphLease && await this.redis.get<string>(this.key(`graph-lease:${job.graph.id}`)) !== job.id) throw Object.assign(new Error('Graph transfer claim expired'), { status: 403 });
    return job;
  }
  async claimBuild(computerId: unknown, secret: unknown, snapshotStaging = false, sharedTransferV2 = false, snapshotHandoffVersion = 0): Promise<ComputerJob | null> {
    await this.ensureIndexed();
    const supportedWorker = snapshotStaging && sharedTransferV2 && snapshotHandoffVersion === 1;
    const computer = await this.heartbeat(computerId, secret, supportedWorker);
    const now = Date.now();
    const digest = typeof secret === 'string' ? createHash('sha256').update(secret).digest('hex') : '';
    const claimed = await this.redis.eval<unknown[], string | null>(`if redis.call('HGET',KEYS[3],ARGV[4])~=ARGV[5] then return nil end; local ids=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',ARGV[1],'LIMIT',0,1); if #ids==0 then return nil end; local raw=redis.call('HGET',KEYS[1],ids[1]); if not raw then redis.call('ZREM',KEYS[2],ids[1]); return nil end; local job=cjson.decode(raw); if job.kind=='build' and ARGV[8]~='1' then if job.stage=='cleanup' then job.progress={stage='update-linked-worker-to-finish-graph-retirement'}; redis.call('HSET',KEYS[1],ids[1],cjson.encode(job)); return nil end; job.state='failed'; job.error='Update the linked DI worker to the current Preview build, then run Build & Save again. The last saved graph remains available.'; job.leaseUntil=nil; redis.call('HSET',KEYS[1],ids[1],cjson.encode(job)); redis.call('ZREM',KEYS[2],ids[1]); local oldLock=ARGV[7]..job.graph.id; if redis.call('GET',oldLock)==job.id then redis.call('DEL',oldLock) end; return nil end; if job.kind=='build' and job.stage=='cleanup' then if ARGV[6]~='1' then return nil end; local graphRaw=redis.call('HGET',KEYS[4],job.graph.id); local graph=graphRaw and cjson.decode(graphRaw); if not graph or not graph.currentSnapshot or graph.currentSnapshot.jobId~=job.id or not job.cleanupResult or graph.currentSnapshot.graphId~=job.cleanupResult.graphId then local staleLock=ARGV[7]..job.graph.id; if redis.call('GET',staleLock)==job.id then redis.call('DEL',staleLock) end; job.state='complete'; job.leaseUntil=nil; job.cleanupResult=nil; job.cleanupLegacyTarget=nil; redis.call('HSET',KEYS[1],ids[1],cjson.encode(job)); redis.call('ZREM',KEYS[2],ids[1]); return nil end end; if job.discardWhenComplete and (job.kind=='investigation' or job.kind=='question') then redis.call('ZREM',KEYS[2],ids[1]); return nil end; if job.kind=='build' and job.stage=='transfer' and job.claimScopedTransfer and ARGV[8]~='1' then job.state='failed'; job.error='This staged transfer requires an updated DI worker on the storage computer'; job.leaseUntil=nil; redis.call('HSET',KEYS[1],job.id,cjson.encode(job)); redis.call('ZREM',KEYS[2],job.id); local lock=ARGV[7]..job.graph.id; if redis.call('GET',lock)==job.id then redis.call('DEL',lock) end; return nil end; if job.kind=='build' and job.stage=='build' and job.graph.transfer and job.graph.transfer.kind=='shared-folder' then local dest=redis.call('HGET',KEYS[5],job.graph.storage.computer); local other=dest and cjson.decode(dest); if not other or other.state~='linked' or other.sharedTransferV2~=true then job.state='failed'; job.error='Update and connect the storage computer to the current Preview worker, then run Build & Save again. The last saved graph remains available.'; job.leaseUntil=nil; redis.call('HSET',KEYS[1],job.id,cjson.encode(job)); redis.call('ZREM',KEYS[2],job.id); local oldLock=ARGV[7]..job.graph.id; if redis.call('GET',oldLock)==job.id then redis.call('DEL',oldLock) end; return nil end; job.claimScopedTransfer=true end; if job.state=='running' and job.kind=='build' and job.graph.transfer and job.graph.transfer.kind=='direct-hosted' and job.claimId and job.transferGraphId then job.previousTransfer={claimId=job.claimId,graphId=job.transferGraphId} end; if job.kind=='build' then local lock=ARGV[7]..job.graph.id; local held=redis.call('GET',lock); if held and held~=job.id then return nil end; redis.call('SET',lock,job.id,'PX',900000); job.graphLease=true; local rawGraph=redis.call('HGET',KEYS[4],job.graph.id); if rawGraph then job.previousSnapshot=cjson.decode(rawGraph).currentSnapshot end end; job.state='running'; job.leaseUntil=tonumber(ARGV[2]); job.claimId=ARGV[3]; job.snapshotStaging=nil; if ARGV[6]=='1' and job.kind=='build' then job.snapshotStaging=true end; local value=cjson.encode(job); redis.call('HSET',KEYS[1],ids[1],value); if job.kind=='investigation' or job.kind=='question' then redis.call('HEXPIRE',KEYS[1],86400,'FIELDS',1,ids[1]) end; redis.call('ZADD',KEYS[2],ARGV[2],ids[1]); return value`, [this.key('builds'), this.key(`queue:${computer.id}`), this.key('computer-secrets'), this.key('graphs'), this.key('computers')], [now, now + 900_000, recordId(), computer.id, digest, supportedWorker ? '1' : '0', `${this.root}:graph-lease:`, supportedWorker ? '1' : '0']);
    if (!claimed) return null;
    const job = await this.hydrateClaimedSnapshot(typeof claimed === 'string' ? JSON.parse(claimed) as ComputerJob : claimed as unknown as ComputerJob);
    return job.resultKey ? { ...job, result: await this.redis.get(job.resultKey) } : job;
  }
  /** Preserve the prior reference for jobs queued before snapshot migration. */
  private async hydrateClaimedSnapshot(job: ComputerJob): Promise<ComputerJob> {
    if (job.kind !== 'build' || !job.graphLease || !job.claimId) return job;
    const graph = await this.graphWithSnapshot(job.graph.id);
    if (!graph) invalid('Graph does not exist');
    const raw = await this.redis.eval<unknown[], string | null>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return nil end; local job=cjson.decode(raw); if job.state~='running' or job.claimId~=ARGV[2] or redis.call('GET',ARGV[3]..job.graph.id)~=job.id then return nil end; local graphRaw=redis.call('HGET',KEYS[2],job.graph.id); if not graphRaw then return nil end; job.previousSnapshot=cjson.decode(graphRaw).currentSnapshot; if job.previousSnapshot and job.previousSnapshot.legacyTarget then local all=redis.call('HGETALL',KEYS[2]); for i=1,#all,2 do local ok,peer=pcall(cjson.decode,all[i+1]); if ok and peer.id~=job.graph.id and peer.projectId==job.graph.projectId and ((peer.storage and peer.storage.computer==job.previousSnapshot.storage.computer and peer.storage.location==job.previousSnapshot.storage.location) or (peer.currentSnapshot and peer.currentSnapshot.storage and peer.currentSnapshot.storage.computer==job.previousSnapshot.storage.computer and peer.currentSnapshot.storage.location==job.previousSnapshot.storage.location)) then job.retainedLegacyTargets={job.previousSnapshot.legacyTarget.name}; job.previousSnapshot.legacyTarget=nil; break end end end; local out=cjson.encode(job); redis.call('HSET',KEYS[1],ARGV[1],out); return out`, [this.key('builds'), this.key('graphs')], [job.id, job.claimId, `${this.root}:graph-lease:`]);
    if (!raw) invalid('Build claim is no longer active');
    return typeof raw === 'string' ? JSON.parse(raw) as BuildJob : raw as unknown as BuildJob;
  }
  /** Claim one account-hosted job without issuing it a linked-computer credential. */
  async claimHosted(jobId: unknown): Promise<BuildJob | null> {
    const jobKey = id(jobId), claim = recordId(), now = Date.now();
    const existing = await this.redis.hget<BuildJob>(this.key('builds'), jobKey);
    const duration = existing?.graph.hostedResources?.timeoutMinutes ? existing.graph.hostedResources.timeoutMinutes * 60_000 : Number(process.env.DEVINT_HOSTED_SANDBOX_TIMEOUT_MS || 3_600_000);
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 86_400_000) invalid('Invalid hosted sandbox duration');
    const raw = await this.redis.eval<unknown[], string | null>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return nil end; local job=cjson.decode(raw); if job.state~='queued' or job.assignedComputer~='hosted' then return nil end; if job.kind=='build' then local graphLock=ARGV[5]..job.graph.id; local held=redis.call('GET',graphLock); if held and held~=job.id then return nil end; if not redis.call('SET',KEYS[3],ARGV[1],'NX','PX',ARGV[4]) then return nil end; redis.call('SET',graphLock,job.id,'PX',ARGV[4]); job.graphLease=true; local rawGraph=redis.call('HGET',KEYS[4],job.graph.id); if rawGraph then job.previousSnapshot=cjson.decode(rawGraph).currentSnapshot end end; job.state='running'; job.claimId=ARGV[2]; if job.kind=='build' then job.snapshotStaging=true end; job.leaseUntil=tonumber(ARGV[3]); job.progress={stage='starting-hosted-worker'}; local out=cjson.encode(job); redis.call('HSET',KEYS[1],ARGV[1],out); if job.kind=='investigation' or job.kind=='question' then redis.call('HEXPIRE',KEYS[1],86400,'FIELDS',1,ARGV[1]) end; redis.call('ZADD',KEYS[2],ARGV[3],ARGV[1]); return out`, [this.key('builds'), this.key('queue:hosted'), this.key('hosted-build-lock'), this.key('graphs')], [jobKey, claim, now + duration, duration + 60_000, `${this.root}:graph-lease:`]);
    if (!raw) return null;
    return await this.hydrateClaimedSnapshot(typeof raw === 'string' ? JSON.parse(raw) as BuildJob : raw as unknown as BuildJob) as BuildJob;
  }
  async hostedClaimActive(jobId: string, claimId: string): Promise<boolean> {
    return await this.redis.eval<unknown[], number>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.state~='running' or job.assignedComputer~='hosted' or job.claimId~=ARGV[2] then return 0 end; if job.graphLease and redis.call('GET',ARGV[3]..job.graph.id)~=job.id then return 0 end; return 1`, [this.key('builds')], [id(jobId), id(claimId), `${this.root}:graph-lease:`]) === 1;
  }
  /** Publish a hosted generation while keeping its existing build claim for retirement. */
  async publishHostedBuild(jobId: string, claimId: string, value: unknown): Promise<void> {
    const result = object(value);
    if (typeof result.graphId !== 'string' || !result.graphId) invalid('The completed build has no usable saved graph reference');
    const changed = await this.redis.eval<unknown[], number>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.kind~='build' or job.state~='running' or job.assignedComputer~='hosted' or job.claimId~=ARGV[2] or not job.snapshotStaging or not job.graphLease or redis.call('GET',ARGV[4]..job.graph.id)~=job.id then return 0 end; local graphRaw=redis.call('HGET',KEYS[2],job.graph.id); if not graphRaw then return 0 end; local graph=cjson.decode(graphRaw); local result=cjson.decode(ARGV[3]); if job.stage=='cleanup' then if graph.currentSnapshot and graph.currentSnapshot.jobId==job.id and graph.currentSnapshot.graphId==result.graphId then return 1 end; return 0 end; if job.stage~='build' or job.graph.buildComputer~='hosted' or job.graph.storage.computer~='hosted' then return 0 end; local old=graph.currentSnapshot; if old and (not job.previousSnapshot or old.graphId~=job.previousSnapshot.graphId or old.jobId~=job.previousSnapshot.jobId or old.storage.computer~=job.graph.storage.computer or old.storage.location~=job.graph.storage.location) then return 0 end; if not old and job.previousSnapshot then return 0 end; graph.snapshotInitialized=true; graph.currentSnapshot={graphId=result.graphId,revision=result.revision,sourceState=result.sourceState,sourceFingerprint=result.sourceFingerprint,requestedAt=job.createdAt,jobId=job.id,source=job.graph.source,storage=job.graph.storage,legacyTarget=job.previousSnapshot and job.previousSnapshot.legacyTarget}; job.cleanupResult=result; if job.previousSnapshot then job.cleanupLegacyTarget=job.previousSnapshot.legacyTarget end; job.stage='cleanup'; job.progress={stage='retiring-replaced-graph'}; redis.call('HSET',KEYS[2],job.graph.id,cjson.encode(graph)); redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); return 1`, [this.key('builds'), this.key('graphs')], [id(jobId), id(claimId), JSON.stringify(result), `${this.root}:graph-lease:`]);
    if (changed !== 1) invalid('Hosted build claim or current graph is no longer active');
  }
  /** Requeue an interrupted hosted retirement, keeping the published snapshot. */
  async requeueHostedCleanup(jobId: string, claimId: string): Promise<void> {
    const changed = await this.redis.eval<unknown[], number>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.kind~='build' or job.stage~='cleanup' or job.state~='running' or job.claimId~=ARGV[2] then return 0 end; local graphRaw=redis.call('HGET',KEYS[3],job.graph.id); local graph=graphRaw and cjson.decode(graphRaw); if not graph or not graph.currentSnapshot or graph.currentSnapshot.jobId~=job.id or not job.cleanupResult or graph.currentSnapshot.graphId~=job.cleanupResult.graphId then local staleLock=ARGV[4]..job.graph.id; if redis.call('GET',staleLock)==job.id then redis.call('DEL',staleLock) end; job.state='complete'; job.leaseUntil=nil; job.cleanupResult=nil; job.cleanupLegacyTarget=nil; redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); redis.call('ZREM',KEYS[2],ARGV[1]); return 1 end; local lock=ARGV[4]..job.graph.id; if redis.call('GET',lock)==job.id then redis.call('DEL',lock) end; job.state='queued'; job.claimId=nil; job.leaseUntil=nil; job.hosted=nil; job.progress={stage='waiting-to-retry-graph-retirement'}; redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); redis.call('ZADD',KEYS[2],ARGV[3],ARGV[1]); return 1`, [this.key('builds'), this.key('queue:hosted'), this.key('graphs')], [id(jobId), id(claimId), Date.now(), `${this.root}:graph-lease:`]);
    if (changed !== 1) invalid('Hosted graph retirement is no longer current');
  }
  async hostedStarted(jobId: string, claimId: string, handle: NonNullable<BuildJob['hosted']>): Promise<void> {
    const changed = await this.redis.eval<unknown[], number>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.state~='running' or job.assignedComputer~='hosted' or job.claimId~=ARGV[2] then return 0 end; job.hosted=cjson.decode(ARGV[3]); redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); if job.kind=='investigation' or job.kind=='question' then redis.call('HEXPIRE',KEYS[1],86400,'FIELDS',1,ARGV[1]) end; return 1`, [this.key('builds')], [id(jobId), id(claimId), JSON.stringify(handle)]);
    if (changed !== 1) invalid('Hosted job claim is no longer active');
  }
  async updateHosted(jobId: string, claimId: string, status: { state: 'running' | 'complete' | 'failed'; retainedLegacyTargets?: string[]; progress?: unknown; result?: unknown; error?: string }): Promise<void> {
    const key = this.key(`result:${id(jobId)}:${id(claimId)}`);
    const current = status.state === 'complete' ? await this.redis.hget<BuildJob>(this.key('builds'), id(jobId)) : null;
    let resultParts: number | undefined;
    if (status.state === 'complete' && !current) invalid('Hosted job claim is no longer active');
    if (status.state === 'complete' && current?.kind === 'investigation') {
      const bytes = Buffer.from(JSON.stringify(status.result ?? null), 'utf8'), size = 192 * 1024;
      resultParts = Math.ceil(bytes.length / size);
      for (let index = 0; index < resultParts; index++) {
        const part = `b:${bytes.subarray(index * size, (index + 1) * size).toString('base64')}`;
        const saved = await this.redis.eval<unknown[], number>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.state~='running' or job.assignedComputer~='hosted' or job.claimId~=ARGV[2] then return 0 end; redis.call('HSET',KEYS[2],ARGV[3],ARGV[4]); redis.call('EXPIRE',KEYS[2],86400); return 1`, [this.key('builds'), key], [jobId, claimId, String(index), part]);
        if (saved !== 1) invalid('Hosted job claim is no longer active');
      }
    } else if (status.state === 'complete') await this.redis.set(key, status.result ?? null, current?.kind === 'question' ? { ex: INVESTIGATION_RESULT_TTL_SECONDS } : undefined);
    const { result: _result, ...rest } = status;
    const stage = sourceStageSummary(status.result);
    const small = { ...rest, ...(resultParts ? { resultParts } : {}), ...(stage ? { sourceStage: stage } : {}) };
    const changed = await this.redis.eval<unknown[], number>(`local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.state~='running' or job.assignedComputer~='hosted' or job.claimId~=ARGV[2] then return 0 end; if job.graphLease and redis.call('GET',ARGV[6]..job.graph.id)~=job.id then return 0 end; local update=cjson.decode(ARGV[3]); if update.state=='running' then job.progress=update.progress else job.state=update.state; job.leaseUntil=nil; if update.state=='complete' then if job.kind=='build' and update.retainedLegacyTargets then job.retainedLegacyTargets=update.retainedLegacyTargets end; if job.kind=='build' and update.sourceStage then job.sourceStage=update.sourceStage end; if update.resultParts then if job.kind~='investigation' or redis.call('HLEN',KEYS[4])~=update.resultParts then return 0 end; job.resultParts=update.resultParts; local now=redis.call('TIME'); job.resultExpiresAt=tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000)+tonumber(ARGV[5])*1000; redis.call('EXPIRE',KEYS[4],ARGV[5]) end; job.resultKey=ARGV[4] else job.error=update.error end; redis.call('ZREM',KEYS[2],ARGV[1]) end; if job.graphLease and (job.state=='complete' or job.state=='failed') then redis.call('DEL',ARGV[6]..job.graph.id) end; if job.state=='complete' and job.kind=='build' then local rawGraph=redis.call('HGET',KEYS[5],job.graph.id); local rawResult=redis.call('GET',KEYS[4]); if not rawGraph or not rawResult then job.state='failed'; job.error='The completed build has no usable saved graph reference' else local ok,result=pcall(cjson.decode,rawResult); if not ok or type(result)~='table' or type(result.graphId)~='string' or result.graphId=='' then job.state='failed'; job.error='The completed build has no usable saved graph reference' else local graph=cjson.decode(rawGraph); local old=graph.currentSnapshot; if not old or old.requestedAt<job.createdAt or (old.requestedAt==job.createdAt and old.jobId<job.id) then graph.snapshotInitialized=true; graph.currentSnapshot={graphId=result.graphId,revision=result.revision,sourceState=result.sourceState,sourceFingerprint=result.sourceFingerprint,requestedAt=job.createdAt,jobId=job.id,source=job.graph.source,storage=job.graph.storage}; redis.call('HSET',KEYS[5],job.graph.id,cjson.encode(graph)) end end end end; if job.kind=='build' and job.state=='complete' then if job.stage=='cleanup' then local currentRaw=redis.call('HGET',KEYS[5],job.graph.id); if currentRaw then local currentGraph=cjson.decode(currentRaw); if currentGraph.currentSnapshot and currentGraph.currentSnapshot.jobId==job.id then currentGraph.currentSnapshot.legacyTarget=nil; redis.call('HSET',KEYS[5],job.graph.id,cjson.encode(currentGraph)) end end end; job.cleanupResult=nil; job.cleanupLegacyTarget=nil end; if job.kind=='investigation' or job.kind=='question' then if job.state=='complete' or job.state=='failed' then job.request=nil; job.question=nil end end; redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); if job.kind=='investigation' or job.kind=='question' then redis.call('HEXPIRE',KEYS[1],86400,'FIELDS',1,ARGV[1]) end; return 1`, [this.key('builds'), this.key('queue:hosted'), this.key('hosted-build-lock'), key, this.key('graphs')], [jobId, claimId, JSON.stringify(small), key, INVESTIGATION_RESULT_TTL_SECONDS, `${this.root}:graph-lease:`]);
    if (changed !== 1 && status.state === 'complete') {
      const completed = await this.redis.hget<BuildJob>(this.key('builds'), jobId);
      if (completed?.resultKey !== key) await this.redis.del(key);
    }
    if (changed !== 1) invalid('Hosted job claim is no longer active');
  }
  /** Serialize writes to an account Drive with hosted graph builds. */
  async acquireHostedTransfer(job: BuildJob): Promise<boolean> {
    const duration = job.graph.hostedResources?.timeoutMinutes ? job.graph.hostedResources.timeoutMinutes * 60_000 : Number(process.env.DEVINT_HOSTED_SANDBOX_TIMEOUT_MS || 3_600_000);
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 86_400_000) invalid('Invalid hosted sandbox duration');
    const acquired = await this.redis.eval<unknown[], number>(`local owner=redis.call('GET',KEYS[1]); if owner==ARGV[1] then return 1 end; if owner then return 0 end; if redis.call('SET',KEYS[1],ARGV[1],'NX','PX',ARGV[2]) then return 1 end; return 0`, [this.key('hosted-build-lock')], [`transfer:${job.id}:${job.claimId}`, duration + 60_000]);
    return acquired === 1;
  }
  async releaseHostedTransfer(job: BuildJob): Promise<void> {
    await this.redis.eval<unknown[], number>(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`, [this.key('hosted-build-lock')], [`transfer:${job.id}:${job.claimId}`]);
  }
  async releaseHostedBuild(jobId: string): Promise<void> {
    await this.redis.eval<unknown[], number>(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`, [this.key('hosted-build-lock')], [id(jobId)]);
  }
  async updateBuild(computerId: unknown, secret: unknown, jobId: unknown, update: unknown): Promise<void> {
    const computer = await this.heartbeat(computerId, secret), data = object(update), buildId = id(jobId), claimId = id(data.claimId);
    const { result, sourceStage: _sourceStage, ...rest } = data;
    const stage = sourceStageSummary(result);
    const small = { ...rest, ...(stage ? { sourceStage: stage } : {}) };
    const resultKey = this.key(`result:${buildId}:${claimId}`);
    if (data.state === 'publishing') {
      const published = object(result);
      if (typeof published.graphId !== 'string' || !published.graphId) invalid('The completed build has no usable saved graph reference');
      const digest = typeof secret === 'string' ? createHash('sha256').update(secret).digest('hex') : '';
      const changed = await this.redis.eval<unknown[], number>(`if redis.call('HGET',KEYS[3],ARGV[2])~=ARGV[4] then return 0 end; local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); if job.kind~='build' or job.state~='running' or job.assignedComputer~=ARGV[2] or job.claimId~=ARGV[3] or not job.snapshotStaging or not job.graphLease or redis.call('GET',ARGV[7]..job.graph.id)~=job.id then return 0 end; local graphRaw=redis.call('HGET',KEYS[4],job.graph.id); if not graphRaw then return 0 end; local graph=cjson.decode(graphRaw); local result=cjson.decode(ARGV[5]); if job.stage=='cleanup' then if graph.currentSnapshot and graph.currentSnapshot.jobId==job.id and graph.currentSnapshot.graphId==result.graphId then return 1 end; return 0 end; local direct=ARGV[8]=='1' and job.graph.storage.computer=='hosted' and job.graph.buildComputer==ARGV[2] and job.graph.transfer and job.graph.transfer.kind=='direct-hosted' and job.transferGraphId==result.graphId; if (job.graph.storage.computer~=ARGV[2] and not direct) or (job.stage~='build' and job.stage~='transfer') then return 0 end; if job.stage=='build' and job.graph.buildComputer~=job.graph.storage.computer and not direct then return 0 end; local old=graph.currentSnapshot; if old and (not job.previousSnapshot or old.graphId~=job.previousSnapshot.graphId or old.jobId~=job.previousSnapshot.jobId or old.storage.computer~=job.graph.storage.computer or old.storage.location~=job.graph.storage.location) then return 0 end; if not old and job.previousSnapshot then return 0 end; graph.snapshotInitialized=true; graph.currentSnapshot={graphId=result.graphId,revision=result.revision,sourceState=result.sourceState,sourceFingerprint=result.sourceFingerprint,requestedAt=job.createdAt,jobId=job.id,source=job.graph.source,storage=job.graph.storage,legacyTarget=job.previousSnapshot and job.previousSnapshot.legacyTarget}; job.cleanupResult=result; if job.previousSnapshot then job.cleanupLegacyTarget=job.previousSnapshot.legacyTarget end; job.stage='cleanup'; job.progress={stage='retiring-replaced-graph'}; job.leaseUntil=tonumber(ARGV[6]); redis.call('HSET',KEYS[4],job.graph.id,cjson.encode(graph)); redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); redis.call('PEXPIRE',ARGV[7]..job.graph.id,900000); redis.call('ZADD',KEYS[2],ARGV[6],ARGV[1]); return 1`, [this.key('builds'), this.key(`queue:${computer.id}`), this.key('computer-secrets'), this.key('graphs')], [buildId, computer.id, claimId, digest, JSON.stringify(published), Date.now() + 900_000, `${this.root}:graph-lease:`, data.hostedTransferred === true ? '1' : '0']);
      if (changed !== 1) invalid('Build claim or current graph is no longer active');
      return;
    }
    const resultParts = data.resultParts;
    if (resultParts !== undefined && (!Number.isSafeInteger(resultParts) || Number(resultParts) < 1)) invalid('Invalid investigation result manifest');
    if (data.state === 'complete' && resultParts === undefined) { const pending = await this.redis.hget<ComputerJob>(this.key('builds'), buildId); if (!pending) invalid('Build claim is no longer active'); if (!('discardWhenComplete' in pending && pending.discardWhenComplete)) await this.redis.set(resultKey, result ?? null, pending?.kind === 'question' || pending?.kind === 'investigation' ? { ex: INVESTIGATION_RESULT_TTL_SECONDS } : undefined); }
    const digest = typeof secret === 'string' ? createHash('sha256').update(secret).digest('hex') : '';
    const changed = await this.redis.eval<unknown[], number>(`if redis.call('HGET',KEYS[3],ARGV[2])~=ARGV[7] then return 0 end; local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end; local job=cjson.decode(raw); local owner=job.kind=='browse' and job.computerId or (job.assignedComputer or job.graph.buildComputer); if job.state~='running' or owner~=ARGV[2] or job.claimId~=ARGV[3] then return 0 end; if job.graphLease and redis.call('GET',ARGV[11]..job.graph.id)~=job.id then return 0 end; local update=cjson.decode(ARGV[4]); if job.discardWhenComplete and (update.state=='complete' or update.state=='failed') then redis.call('DEL',KEYS[4]); redis.call('ZREM',KEYS[2],ARGV[1]); redis.call('HDEL',KEYS[1],ARGV[1]); return 1 end; if update.state=='complete' and job.kind=='build' and job.stage=='build' and job.claimScopedTransfer then local bytes=redis.call('GET',KEYS[4]); if not bytes then return 0 end; local ok,result=pcall(cjson.decode,bytes); if not ok or type(result)~='table' or result.sharedTransferClaim~=ARGV[3] then return 0 end; job.sharedTransferClaim=ARGV[3] end; if job.graphLease then redis.call('PEXPIRE',ARGV[11]..job.graph.id,900000) end; if update.state=='complete' then if job.kind=='build' and update.retainedLegacyTargets then job.retainedLegacyTargets=update.retainedLegacyTargets end; if job.kind=='build' and update.sourceStage then job.sourceStage=update.sourceStage end; if update.resultParts then if job.kind~='investigation' or redis.call('HLEN',KEYS[4])~=update.resultParts then return 0 end; job.resultParts=update.resultParts; local now=redis.call('TIME'); job.resultExpiresAt=tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000)+tonumber(ARGV[10])*1000; redis.call('EXPIRE',KEYS[4],ARGV[10]) end; job.resultKey=ARGV[6]; job.result=nil; job.leaseUntil=nil; redis.call('ZREM',KEYS[2],ARGV[1]); if job.kind=='build' and job.stage=='build' and job.graph.buildComputer~=job.graph.storage.computer and not update.hostedTransferred then job.state='queued'; job.stage='transfer'; job.assignedComputer=job.graph.storage.computer; job.progress={stage='waiting-for-storage-computer'}; job.claimId=nil; redis.call('ZADD',ARGV[8]..job.assignedComputer,ARGV[9],ARGV[1]) else job.state='complete' end elseif update.state=='failed' then job.state='failed'; job.error=update.error; job.leaseUntil=nil; redis.call('ZREM',KEYS[2],ARGV[1]) else job.progress=update.progress; job.leaseUntil=tonumber(ARGV[5]); redis.call('ZADD',KEYS[2],ARGV[5],ARGV[1]) end; if job.graphLease and (job.state=='complete' or job.state=='failed') then redis.call('DEL',ARGV[11]..job.graph.id) end; if job.state=='complete' and job.kind=='build' then local rawGraph=redis.call('HGET',KEYS[5],job.graph.id); local rawResult=redis.call('GET',KEYS[4]); if not rawGraph or not rawResult then job.state='failed'; job.error='The completed build has no usable saved graph reference' else local ok,result=pcall(cjson.decode,rawResult); if not ok or type(result)~='table' or type(result.graphId)~='string' or result.graphId=='' then job.state='failed'; job.error='The completed build has no usable saved graph reference' else local graph=cjson.decode(rawGraph); local old=graph.currentSnapshot; if not old or old.requestedAt<job.createdAt or (old.requestedAt==job.createdAt and old.jobId<job.id) then graph.snapshotInitialized=true; graph.currentSnapshot={graphId=result.graphId,revision=result.revision,sourceState=result.sourceState,sourceFingerprint=result.sourceFingerprint,requestedAt=job.createdAt,jobId=job.id,source=job.graph.source,storage=job.graph.storage}; redis.call('HSET',KEYS[5],job.graph.id,cjson.encode(graph)) end end end end; if job.kind=='build' and job.state=='complete' then if job.stage=='cleanup' then local currentRaw=redis.call('HGET',KEYS[5],job.graph.id); if currentRaw then local currentGraph=cjson.decode(currentRaw); if currentGraph.currentSnapshot and currentGraph.currentSnapshot.jobId==job.id then currentGraph.currentSnapshot.legacyTarget=nil; redis.call('HSET',KEYS[5],job.graph.id,cjson.encode(currentGraph)) end end end; job.cleanupResult=nil; job.cleanupLegacyTarget=nil end; if job.kind=='investigation' or job.kind=='question' then if job.state=='complete' or job.state=='failed' then job.request=nil; job.question=nil end end; redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(job)); if job.kind=='investigation' or job.kind=='question' then redis.call('HEXPIRE',KEYS[1],86400,'FIELDS',1,ARGV[1]) end; return 1`, [this.key('builds'), this.key(`queue:${computer.id}`), this.key('computer-secrets'), resultKey, this.key('graphs')], [buildId, computer.id, claimId, JSON.stringify(small), Date.now() + 900_000, resultKey, digest, `${this.root}:queue:`, Date.now(), INVESTIGATION_RESULT_TTL_SECONDS, `${this.root}:graph-lease:`]);
    if (changed !== 1 && data.state === 'complete') {
      const current = await this.redis.hget<ComputerJob>(this.key('builds'), buildId);
      if (current?.resultKey !== resultKey) await this.redis.del(resultKey);
    }
    if (changed !== 1) invalid('Build claim is no longer active');
  }
}
