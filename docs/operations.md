# Operations

## Hosting principle

Development Intelligence does not require a permanently administered server, persistent graph disk, external object bucket, or graph database.

Durable accepted intelligence lives with each inspected Git project as `/.development-intelligence/manifest.json` plus deterministic sharded NDJSON records under `/.development-intelligence/graph/` and therefore follows normal Git history, review, branching, backup, and access controls.

The hosted service needs only:

- Node.js 22+;
- Git;
- temporary filesystem capacity sufficient for an exact-revision checkout;
- the project access registry and referenced credentials;
- HTTP/MCP authentication.

This fits a GitHub + Vercel shape: GitHub owns source/history; Vercel can host the API/MCP/viewer and provide disposable Sandbox compute when heavier analysis warrants it. Vercel is not required to become durable graph authority.

## Configuration

| Variable | Purpose |
|---|---|
| `DEVINT_PROJECTS_FILE` | Operational repository/ref/runtime allowlist registry |
| `DEVINT_SCRATCH_DIR` | Optional disposable checkout root (defaults to OS temp) |
| `DEVINT_GRAPH_CACHE_SIZE` | Warm in-process exact-revision graph cache bound |
| `DEVINT_GRAPH_MAX_FILES` | Maximum eligible tracked files analyzed in one graph build |
| `DEVINT_GRAPH_MAX_FILE_BYTES` | Maximum individual text file size analyzed |
| `DEVINT_GRAPH_MAX_RUNTIME_BYTES` | Runtime response body cap |
| `DEVINT_RUNTIME_TIMEOUT_MS` | Runtime GET timeout |
| `DEVINT_VIEWER_MAX_NODES` | Human viewer first-frame node bound |
| `DEVINT_HOST` | Optional bind host; defaults to loopback locally and `0.0.0.0` when a platform `PORT` is supplied |
| `DEVINT_PORT` | Optional explicit local/service port override |
| `PORT` | Hosting-platform port, used when `DEVINT_PORT` is not set |

There is no required durable `DEVINT_DATA_DIR`, graph database, or provider-specific storage configuration.

## Repository credentials

Repository URLs must not contain credentials. Token credentials are read from configured environment variables and supplied through a short-lived Git askpass helper. Scratch checkout paths and credentials are never graph identities.

## Normal remote read

1. Validate project/ref against the registry.
2. Resolve the exact remote SHA.
3. Create a disposable checkout.
4. Fetch only the requested ref at shallow depth.
5. Verify fetched SHA still matches the resolved SHA.
6. Build/query the graph.
7. Delete the checkout.

Warm process-memory graph reuse is allowed but never authoritative.

## Candidate sealing

Graph sealing belongs in the inspected project's own candidate workflow:

1. make the intended source changes;
2. generate B with `graphCli seal` against the candidate working tree;
3. review/check the A→B delta as appropriate;
4. commit the source + `.development-intelligence/` checkpoint together;
5. merge through the project's normal review/release process;
6. after merge, B is the new A by ordinary Git semantics.

If the checkpoint is absent, DI can still generate W and answer technical questions. Absence of a checkpoint means there is no accepted A for graph-diff purposes; it does not make source unavailable.

## Authentication

Current service modes:

### Bearer

`DEVINT_AUTH_MODE=bearer` + `DEVINT_BEARER_TOKEN`.

### Trusted proxy

`DEVINT_AUTH_MODE=proxy` + `DEVINT_PROXY_SHARED_SECRET`; the proxy supplies `X-Devint-Proxy-Secret`.

### Local development only

Unauthenticated mode fails closed unless both `DEVINT_AUTH_MODE=none` and `DEVINT_ALLOW_UNAUTHENTICATED=1` are present.

The eventual hosted OAuth boundary remains separable from graph semantics.

## Recovery

There is almost no service-local recovery procedure:

- lost scratch checkout → regenerate from Git;
- lost in-process cache → regenerate from Git;
- lost host instance → regenerate from Git;
- accepted graph checkpoint damaged → regenerate/seal from the corresponding source revision and review the repair through Git.

The canonical repository remains usable even if Development Intelligence is unavailable.
