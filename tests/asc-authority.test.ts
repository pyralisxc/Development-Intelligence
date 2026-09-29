import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AscPrivateEvidenceService,
  AscReadAuthorityRejectedError,
  HttpAscReadDelegationVerifier
} from '../src/ascAuthority.js';

function receipt() {
  return Object.freeze({
    accountDomainId: 'domain:personal',
    delegationId: 'delegation:test',
    bindingId: 'binding:test',
    connectionId: 'connection:github:test',
    connectionGeneration: 4,
    projectId: 'asc',
    capabilityId: 'source.read' as const,
    effectClass: 'read' as const,
    resource: Object.freeze({
      kind: 'github_repository',
      value: 'pyralisxc/Private-Project'
    }),
    audience:
      'development-intelligence' as const,
    consumedAt:
      '2026-09-29T02:50:00.000Z'
  });
}

test('ASC private evidence read derives repository from delegation and keeps credentials out of provenance', async () => {
  const previousOwners =
    process.env.DEVINT_GITHUB_ALLOWED_OWNERS;
  process.env.DEVINT_GITHUB_ALLOWED_OWNERS =
    'pyralisxc';

  let repository:
    | { owner: string; name: string }
    | undefined;
  let path = '';
  let revision = '';

  try {
    const service =
      new AscPrivateEvidenceService({
        verifier: {
          async consume(input) {
            assert.deepEqual(input, {
              handle:
                'ascd_' + 'a'.repeat(43),
              accountDomainId:
                'domain:personal',
              projectId: 'asc'
            });
            return receipt();
          }
        },
        reader: {
          async inspect(
            repositoryInput,
            pathInput,
            revisionInput
          ) {
            repository = repositoryInput;
            path = pathInput;
            revision = revisionInput;
            return {
              revision: revisionInput,
              entries: [{
                name: 'README.md',
                path: 'README.md',
                type: 'file',
                size: 120,
                sha: 'blob-sha'
              }]
            };
          }
        }
      });

    const result =
      await service.readRepositoryPath({
        delegationHandle:
          'ascd_' + 'a'.repeat(43),
        accountDomainId:
          'domain:personal',
        projectId: 'asc',
        revision: 'b'.repeat(40),
        path: 'README.md'
      });

    assert.deepEqual(repository, {
      owner: 'pyralisxc',
      name: 'Private-Project'
    });
    assert.equal(path, 'README.md');
    assert.equal(revision, 'b'.repeat(40));
    assert.equal(
      result.evidence.repository,
      'pyralisxc/Private-Project'
    );
    assert.equal(
      result.authority.connectionGeneration,
      4
    );
    assert.equal(
      JSON.stringify(result).includes(
        'ascd_' + 'a'.repeat(43)
      ),
      false
    );
    assert.equal(
      JSON.stringify(result)
        .toLowerCase()
        .includes('token'),
      false
    );
  } finally {
    if (previousOwners === undefined) {
      delete process.env
        .DEVINT_GITHUB_ALLOWED_OWNERS;
    } else {
      process.env
        .DEVINT_GITHUB_ALLOWED_OWNERS =
        previousOwners;
    }
  }
});

test('ASC private evidence rejects repository owners outside DI allowlist before provider read', async () => {
  const previousOwners =
    process.env.DEVINT_GITHUB_ALLOWED_OWNERS;
  process.env.DEVINT_GITHUB_ALLOWED_OWNERS =
    'pyralisxc';
  let providerCalls = 0;

  try {
    const service =
      new AscPrivateEvidenceService({
        verifier: {
          async consume() {
            return Object.freeze({
              ...receipt(),
              resource: Object.freeze({
                kind: 'github_repository',
                value: 'other/Private-Project'
              })
            });
          }
        },
        reader: {
          async inspect() {
            providerCalls += 1;
            throw new Error(
              'must not execute'
            );
          }
        }
      });

    await assert.rejects(
      () =>
        service.readRepositoryPath({
          delegationHandle:
            'ascd_' + 'a'.repeat(43),
          accountDomainId:
            'domain:personal',
          projectId: 'asc',
          revision: 'b'.repeat(40),
          path: 'README.md'
        }),
      AscReadAuthorityRejectedError
    );
    assert.equal(providerCalls, 0);
  } finally {
    if (previousOwners === undefined) {
      delete process.env
        .DEVINT_GITHUB_ALLOWED_OWNERS;
    } else {
      process.env
        .DEVINT_GITHUB_ALLOWED_OWNERS =
        previousOwners;
    }
  }
});

test('HTTP ASC verifier hard-binds DI source.read semantics and parses safe authority provenance', async () => {
  const requests: Array<{
    url: string;
    body: unknown;
    authorization: string | null;
  }> = [];
  const verifier =
    new HttpAscReadDelegationVerifier({
      baseUrl: 'https://asc.example',
      secret: 's'.repeat(40),
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(
            String(init?.body)
          ),
          authorization:
            new Headers(init?.headers)
              .get('authorization')
        });
        return Response.json({
          receipt: receipt()
        });
      }
    });

  const result = await verifier.consume({
    handle: 'ascd_' + 'a'.repeat(43),
    accountDomainId: 'domain:personal',
    projectId: 'asc'
  });

  assert.equal(
    requests[0]?.url,
    'https://asc.example/api/internal/development-intelligence/delegations/consume'
  );
  assert.deepEqual(
    requests[0]?.body,
    {
      accountDomainId:
        'domain:personal',
      handle:
        'ascd_' + 'a'.repeat(43),
      projectId: 'asc',
      capabilityId: 'source.read',
      effectClass: 'read'
    }
  );
  assert.equal(
    requests[0]?.authorization,
    'Bearer ' + 's'.repeat(40)
  );
  assert.equal(
    result.audience,
    'development-intelligence'
  );
});
