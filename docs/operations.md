# Operations

## Production layout

Development Intelligence is host-neutral. A production deployment needs:

- Node.js 22+;
- Git;
- Codebase Memory executable;
- persistent `DEVINT_DATA_DIR`;
- persistent `CBM_CACHE_DIR`;
- project registry mounted read-only;
- secrets injected through environment variables;
- TLS/auth at the service or a trusted reverse proxy.

No Oracle, Vercel, Google Cloud, or other provider is part of the product contract.

## Important environment variables

| Variable | Purpose |
|---|---|
| `DEVINT_PROJECTS_FILE` | Project access registry path |
| `DEVINT_DATA_DIR` | Managed mirrors/worktrees/parity scans/state |
| `DEVINT_CBM_BINARY` | Codebase Memory executable |
| `DEVINT_KEEP_GENERATIONS` | Selected + prior derived generations to retain (default 2) |
| `DEVINT_INDEX_TIMEOUT_MS` | Codebase Memory indexing timeout |
| `DEVINT_LOCK_STALE_MS` | Stale refresh-lock recovery window; active operations heartbeat the lock |
| `CBM_WORKERS` | Codebase Memory worker bound (default 1) |
| `CBM_MEM_BUDGET_MB` | Optional explicit Codebase Memory memory budget |
| `CBM_CACHE_DIR` | Persistent Codebase Memory cache |
| `DEVINT_PARITY_MAX_FILES` | Maximum eligible tracked files scanned per parity run |
| `DEVINT_PARITY_MAX_FILE_BYTES` | Per-file parity scan cap |
| `DEVINT_PARITY_MAX_RUNTIME_BYTES` | Runtime response cap |
| `DEVINT_RUNTIME_TIMEOUT_MS` | Runtime GET timeout |
| `DEVINT_AUTH_MODE` | `bearer`, `proxy`, or development-only `none` |
| `DEVINT_ALLOWED_HOSTS` | Optional Host allowlist |

## Authentication

### Bearer

Set:

```text
DEVINT_AUTH_MODE=bearer
DEVINT_BEARER_TOKEN=<secret>
```

### Existing OAuth/reverse proxy

Keep OAuth/provider identity at the gateway and configure the upstream service as:

```text
DEVINT_AUTH_MODE=proxy
DEVINT_PROXY_SHARED_SECRET=<gateway-to-service-secret>
```

The proxy sends `X-Devint-Proxy-Secret`. This lets an existing OAuth boundary remain authoritative without embedding OAuth/product identity logic in Development Intelligence.

### Local only

Unauthenticated mode fails closed unless both are set:

```text
DEVINT_AUTH_MODE=none
DEVINT_ALLOW_UNAUTHENTICATED=1
```

Do not use this for public deployment.

## Codebase Memory

The candidate is tested against the public Codebase Memory CLI contract used by version 0.10.8. Pin production installs until a newer release is explicitly verified.

Start with `CBM_WORKERS=1` in constrained containers. Increase only after observing memory headroom. A repeated OOM/SIGKILL is a capacity signal, not a retry strategy.

## Project onboarding

1. Add the public project identity and canonical repository to the operator registry.
2. Allowlist only refs Development Intelligence is permitted to observe.
3. Inject repository credentials through the referenced environment variable.
4. Optionally allowlist live runtime origins and environment-backed request headers.
5. Call `refresh_codebase`.
6. Verify `project_status` reports exact upstream/checkout/indexed SHA alignment.
7. Call `scan_parity` with repository-only observation first; add live URLs only when useful and authorized.

No semantic project mapping is created.

## Migrating the current hosted Development Intelligence service

The current deployment can be migrated without changing the public plugin identity:

1. deploy this repository beside the existing service;
2. preserve the existing external OAuth/auth gateway where practical using proxy auth mode;
3. register the same canonical projects with clean public names;
4. run `refresh_codebase` and prove exact SHA/index status;
5. run a repository-only parity scan;
6. for the first proving project, compare generic Parity output with the existing project-specific Product Reality checkpoint;
7. add authorized live runtime scans and verify unavailable/auth states are truthful;
8. switch the existing MCP hostname/gateway to the new service only after the above acceptance passes;
9. retain the old service as rollback until a normal observation window succeeds;
10. retire the duplicate project-specific parity implementation once generic replacement evidence is sufficient.

Do not combine this migration with a cloud-provider move unless the current host still cannot meet measured resource requirements after Codebase Memory worker/memory tuning.

## Backup and recovery

Back up:

- project registry (without secrets if separately managed);
- `DEVINT_DATA_DIR` parity scans/state if scan history is valuable;
- `CBM_CACHE_DIR` if avoiding reindex cost matters.

Canonical repositories do not depend on Development Intelligence state. All service state is derived and can be rebuilt from source, though historical parity scans are not reproducible if live/runtime sources have changed.
