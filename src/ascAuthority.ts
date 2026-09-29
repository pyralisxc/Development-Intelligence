import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  IncomingMessage,
  ServerResponse
} from 'node:http';

import {
  listAuthorizedGithubOwners
} from './config/registry.js';
import {
  inspectGithubRepositoryPathAtRevision,
  type GithubRepositoryIdentity,
  type GithubRepositoryPathEntry
} from './source/repositoryCredential.js';

export interface AscDelegationResource {
  readonly kind: string;
  readonly value: string;
}

export interface AscReadDelegationReceipt {
  readonly accountDomainId: string;
  readonly delegationId: string;
  readonly bindingId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly projectId: string;
  readonly capabilityId: string;
  readonly effectClass: 'read';
  readonly resource: AscDelegationResource;
  readonly audience: 'development-intelligence';
  readonly consumedAt: string;
}

export interface ConsumeAscReadDelegationInput {
  readonly handle: string;
  readonly accountDomainId: string;
  readonly projectId: string;
}

export interface AscReadDelegationVerifier {
  consume(
    input: ConsumeAscReadDelegationInput
  ): Promise<AscReadDelegationReceipt>;
}

export interface RepositoryPathEvidenceReader {
  inspect(
    repository: GithubRepositoryIdentity,
    path: string,
    revision: string
  ): Promise<{
    revision: string;
    entries: GithubRepositoryPathEntry[];
  }>;
}

export interface AscRepositoryPathEvidenceInput {
  readonly delegationHandle: string;
  readonly accountDomainId: string;
  readonly projectId: string;
  readonly revision: string;
  readonly path: string;
}

export interface AscRepositoryPathEvidence {
  readonly authority: {
    readonly source: 'asc';
    readonly accountDomainId: string;
    readonly delegationId: string;
    readonly bindingId: string;
    readonly connectionId: string;
    readonly connectionGeneration: number;
    readonly projectId: string;
    readonly capabilityId: 'source.read';
    readonly resource: AscDelegationResource;
    readonly consumedAt: string;
  };
  readonly evidence: {
    readonly provider: 'github';
    readonly repository: string;
    readonly revision: string;
    readonly path: string;
    readonly entries: readonly GithubRepositoryPathEntry[];
  };
}

export class AscReadAuthorityRejectedError extends Error {
  readonly code = 'asc_read_authority_rejected';

  constructor(
    message = 'ASC read delegation was rejected.'
  ) {
    super(message);
    this.name = 'AscReadAuthorityRejectedError';
  }
}

function record(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function stringField(
  value: unknown,
  label: string
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AscReadAuthorityRejectedError(
      label + ' is missing from ASC receipt.'
    );
  }
  return value.trim();
}

function parseReceipt(
  value: unknown
): AscReadDelegationReceipt {
  if (!record(value)) {
    throw new AscReadAuthorityRejectedError();
  }

  if (
    typeof value.connectionGeneration !== 'number' ||
    !Number.isSafeInteger(value.connectionGeneration) ||
    value.connectionGeneration < 1
  ) {
    throw new AscReadAuthorityRejectedError(
      'ASC receipt Connection generation is invalid.'
    );
  }

  if (!record(value.resource)) {
    throw new AscReadAuthorityRejectedError(
      'ASC receipt resource is invalid.'
    );
  }

  const consumedAt = stringField(
    value.consumedAt,
    'consumedAt'
  );
  if (!Number.isFinite(Date.parse(consumedAt))) {
    throw new AscReadAuthorityRejectedError(
      'ASC receipt consumption time is invalid.'
    );
  }

  const capabilityId = stringField(
    value.capabilityId,
    'capabilityId'
  );
  const effectClass = stringField(
    value.effectClass,
    'effectClass'
  );
  const audience = stringField(
    value.audience,
    'audience'
  );

  if (
    capabilityId !== 'source.read' ||
    effectClass !== 'read' ||
    audience !== 'development-intelligence'
  ) {
    throw new AscReadAuthorityRejectedError(
      'ASC receipt does not authorize Development Intelligence source read.'
    );
  }

  return Object.freeze({
    accountDomainId: stringField(
      value.accountDomainId,
      'accountDomainId'
    ),
    delegationId: stringField(
      value.delegationId,
      'delegationId'
    ),
    bindingId: stringField(
      value.bindingId,
      'bindingId'
    ),
    connectionId: stringField(
      value.connectionId,
      'connectionId'
    ),
    connectionGeneration:
      value.connectionGeneration,
    projectId: stringField(
      value.projectId,
      'projectId'
    ),
    capabilityId: 'source.read',
    effectClass: 'read',
    resource: Object.freeze({
      kind: stringField(
        value.resource.kind,
        'resource.kind'
      ),
      value: stringField(
        value.resource.value,
        'resource.value'
      )
    }),
    audience: 'development-intelligence',
    consumedAt
  });
}

function secureBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      'DEVINT_ASC_CONTROL_URL must be an absolute URL'
    );
  }

  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1';
  if (
    url.protocol !== 'https:' &&
    !(loopback && url.protocol === 'http:')
  ) {
    throw new Error(
      'DEVINT_ASC_CONTROL_URL must use HTTPS outside localhost'
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'DEVINT_ASC_CONTROL_URL must not contain credentials, query, or fragment'
    );
  }
  return url.origin;
}

function serviceSecret(value: string): string {
  const secret = value.trim();
  if (
    secret.length < 32 ||
    secret.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(secret)
  ) {
    throw new Error(
      'DEVINT_ASC_BRIDGE_SECRET must contain 32-4096 printable characters'
    );
  }
  return secret;
}

export class HttpAscReadDelegationVerifier
  implements AscReadDelegationVerifier
{
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: {
    readonly baseUrl: string;
    readonly secret: string;
    readonly fetch?: typeof globalThis.fetch;
  }) {
    this.#baseUrl = secureBaseUrl(options.baseUrl);
    this.#secret = serviceSecret(options.secret);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async consume(
    input: ConsumeAscReadDelegationInput
  ): Promise<AscReadDelegationReceipt> {
    const response = await this.#fetch(
      this.#baseUrl +
        '/api/internal/development-intelligence/delegations/consume',
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer ' + this.#secret,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          accountDomainId: input.accountDomainId,
          handle: input.handle,
          projectId: input.projectId,
          capabilityId: 'source.read',
          effectClass: 'read'
        })
      }
    );

    if (!response.ok) {
      throw new AscReadAuthorityRejectedError();
    }

    const payload: unknown = await response.json();
    if (!record(payload) || !('receipt' in payload)) {
      throw new AscReadAuthorityRejectedError(
        'ASC delegation response is invalid.'
      );
    }
    return parseReceipt(payload.receipt);
  }
}

function repositoryIdentity(
  value: string
): GithubRepositoryIdentity & {
  readonly fullName: string;
} {
  const pieces = value.trim().split('/');
  if (
    pieces.length !== 2 ||
    !pieces[0] ||
    !pieces[1] ||
    !/^[A-Za-z0-9_.-]+$/u.test(pieces[0]) ||
    !/^[A-Za-z0-9_.-]+$/u.test(pieces[1])
  ) {
    throw new AscReadAuthorityRejectedError(
      'ASC delegation repository identity is invalid.'
    );
  }

  const authorizedOwner =
    listAuthorizedGithubOwners().find(
      (owner) =>
        owner.toLowerCase() ===
        pieces[0]!.toLowerCase()
    );
  if (!authorizedOwner) {
    throw new AscReadAuthorityRejectedError(
      'ASC delegation repository owner is not authorized by Development Intelligence.'
    );
  }

  return Object.freeze({
    owner: authorizedOwner,
    name: pieces[1]!,
    fullName:
      authorizedOwner + '/' + pieces[1]!
  });
}

function safePath(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 1024 ||
    normalized.startsWith('/') ||
    normalized.split('/').some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..'
    )
  ) {
    throw new Error(
      'Repository path must be a normalized repository-relative path.'
    );
  }
  return normalized;
}

function exactRevision(value: string): string {
  const revision = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error(
      'Repository evidence requires an exact 40-character Git revision.'
    );
  }
  return revision;
}

export class AscPrivateEvidenceService {
  readonly #verifier: AscReadDelegationVerifier;
  readonly #reader: RepositoryPathEvidenceReader;

  constructor(options: {
    readonly verifier: AscReadDelegationVerifier;
    readonly reader?: RepositoryPathEvidenceReader;
  }) {
    this.#verifier = options.verifier;
    this.#reader =
      options.reader ?? {
        inspect:
          inspectGithubRepositoryPathAtRevision
      };
  }

  async readRepositoryPath(
    input: AscRepositoryPathEvidenceInput
  ): Promise<AscRepositoryPathEvidence> {
    const authority = await this.#verifier.consume({
      handle: input.delegationHandle,
      accountDomainId: input.accountDomainId,
      projectId: input.projectId
    });

    if (
      authority.accountDomainId !==
        input.accountDomainId ||
      authority.projectId !== input.projectId
    ) {
      throw new AscReadAuthorityRejectedError(
        'ASC delegation identity does not match the requested evidence read.'
      );
    }
    if (
      authority.resource.kind !==
        'github_repository'
    ) {
      throw new AscReadAuthorityRejectedError(
        'ASC delegation is not bound to a GitHub repository.'
      );
    }

    const repository =
      repositoryIdentity(
        authority.resource.value
      );
    const revision =
      exactRevision(input.revision);
    const path = safePath(input.path);
    const inspected =
      await this.#reader.inspect(
        repository,
        path,
        revision
      );

    if (
      inspected.revision.toLowerCase() !==
      revision
    ) {
      throw new Error(
        'Provider evidence returned a different Git revision.'
      );
    }

    return Object.freeze({
      authority: Object.freeze({
        source: 'asc' as const,
        accountDomainId:
          authority.accountDomainId,
        delegationId:
          authority.delegationId,
        bindingId: authority.bindingId,
        connectionId:
          authority.connectionId,
        connectionGeneration:
          authority.connectionGeneration,
        projectId: authority.projectId,
        capabilityId: 'source.read' as const,
        resource: authority.resource,
        consumedAt: authority.consumedAt
      }),
      evidence: Object.freeze({
        provider: 'github' as const,
        repository: repository.fullName,
        revision,
        path,
        entries: Object.freeze(
          inspected.entries.map(
            (entry) =>
              Object.freeze({ ...entry })
          )
        )
      })
    });
  }
}

function digest(value: string): Buffer {
  return createHash('sha256')
    .update(value)
    .digest();
}

function bearerMatches(
  header: string | undefined,
  secret: string
): boolean {
  if (!header?.startsWith('Bearer ')) {
    return false;
  }
  const supplied =
    header.slice('Bearer '.length).trim();
  if (!supplied) return false;
  return timingSafeEqual(
    digest(supplied),
    digest(secret)
  );
}

async function readJson(
  req: IncomingMessage
): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 128 * 1024) {
      throw new Error('Request body is too large.');
    }
    chunks.push(buffer);
  }
  if (!chunks.length) {
    throw new Error('Request body is required.');
  }
  return JSON.parse(
    Buffer.concat(chunks).toString('utf8')
  ) as unknown;
}

function requiredString(
  value: unknown,
  label: string,
  max = 2048
): string {
  if (typeof value !== 'string') {
    throw new Error(label + ' is required.');
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > max ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(label + ' is invalid.');
  }
  return normalized;
}

function requestInput(
  value: unknown
): AscRepositoryPathEvidenceInput {
  if (!record(value)) {
    throw new Error('Invalid request.');
  }

  const allowed = new Set([
    'delegationHandle',
    'accountDomainId',
    'projectId',
    'revision',
    'path'
  ]);
  if (
    Object.keys(value).some(
      (key) => !allowed.has(key)
    )
  ) {
    throw new Error('Unsupported request field.');
  }

  const delegationHandle = requiredString(
    value.delegationHandle,
    'Delegation handle',
    128
  );
  if (
    !/^ascd_[A-Za-z0-9_-]{43}$/u.test(
      delegationHandle
    )
  ) {
    throw new Error(
      'Delegation handle is invalid.'
    );
  }

  return Object.freeze({
    delegationHandle,
    accountDomainId: requiredString(
      value.accountDomainId,
      'AccountDomain',
      256
    ),
    projectId: requiredString(
      value.projectId,
      'Project',
      256
    ),
    revision: exactRevision(
      requiredString(
        value.revision,
        'Revision',
        40
      )
    ),
    path: safePath(
      requiredString(
        value.path,
        'Path',
        1024
      )
    )
  });
}

function json(
  res: ServerResponse,
  status: number,
  value: unknown
): void {
  res.writeHead(status, {
    'content-type':
      'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(value));
}

function environmentService():
  | {
      secret: string;
      service: AscPrivateEvidenceService;
    }
  | undefined {
  if (
    process.env
      .DEVINT_ENABLE_ASC_AUTHORITY_CANARY !== '1'
  ) {
    return undefined;
  }

  const secret = serviceSecret(
    process.env.DEVINT_ASC_BRIDGE_SECRET ?? ''
  );
  const baseUrl =
    process.env.DEVINT_ASC_CONTROL_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      'DEVINT_ASC_CONTROL_URL is required when ASC authority canary is enabled'
    );
  }

  return {
    secret,
    service: new AscPrivateEvidenceService({
      verifier:
        new HttpAscReadDelegationVerifier({
          baseUrl,
          secret
        })
    })
  };
}

export async function handleAscEvidenceBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  options?: {
    readonly enabled?: boolean;
    readonly secret?: string;
    readonly service?: AscPrivateEvidenceService;
  }
): Promise<boolean> {
  if (
    requestUrl.pathname !==
    '/internal/asc/evidence/repository-path'
  ) {
    return false;
  }

  const enabled =
    options?.enabled ??
    process.env
      .DEVINT_ENABLE_ASC_AUTHORITY_CANARY === '1';
  if (!enabled) {
    json(res, 503, {
      error: 'asc_authority_canary_disabled'
    });
    return true;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, {
      allow: 'POST',
      'cache-control': 'no-store'
    });
    res.end();
    return true;
  }

  let configured:
    | {
        secret: string;
        service: AscPrivateEvidenceService;
      }
    | undefined;
  try {
    configured =
      options?.secret && options.service
        ? {
            secret:
              serviceSecret(options.secret),
            service: options.service
          }
        : environmentService();
  } catch {
    json(res, 503, {
      error: 'asc_authority_bridge_unavailable'
    });
    return true;
  }

  if (!configured) {
    json(res, 503, {
      error: 'asc_authority_bridge_unavailable'
    });
    return true;
  }

  if (
    !bearerMatches(
      req.headers.authorization,
      configured.secret
    )
  ) {
    json(res, 401, { error: 'unauthorized' });
    return true;
  }

  let input: AscRepositoryPathEvidenceInput;
  try {
    input = requestInput(await readJson(req));
  } catch {
    json(res, 400, {
      error: 'invalid_request'
    });
    return true;
  }

  try {
    json(
      res,
      200,
      await configured.service
        .readRepositoryPath(input)
    );
  } catch (error) {
    if (
      error instanceof
      AscReadAuthorityRejectedError
    ) {
      json(res, 403, {
        error: 'asc_authority_rejected'
      });
      return true;
    }

    json(res, 502, {
      error: 'provider_evidence_unavailable'
    });
  }
  return true;
}
