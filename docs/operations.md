# Operations

## Hosting principle

Development Intelligence does not require a permanently administered graph server, persistent graph disk, external object bucket, or graph database.

Durable accepted intelligence lives with each inspected Git project as `/.development-intelligence/manifest.json` plus deterministic semantic NDJSON shards under `/.development-intelligence/graph/`. It follows ordinary Git history, review, branching, backup, and access control.

The **source repository and running service have independent visibility**. The Development Intelligence repository may be public for collaboration, inspection, and reuse while a deployed Viewer/MCP endpoint remains privately gated. Repository privacy must not be treated as the service's authentication boundary.

The hosted service needs only:

- Node.js 22+;
- Git;
- temporary filesystem capacity for exact-revision checkout;
- the project access registry and referenced credentials;
- HTTP/MCP authentication.

GitHub may own source/history and a platform such as Vercel may host API/MCP/Viewer plus disposable compute. The hosting provider is not durable graph authority.

## Configuration

| Variable | Purpose |
|---|---|
| `DEVINT_PROJECTS_FILE` | Operational repository/ref/runtime allowlist registry |
| `DEVINT_SCRATCH_DIR` | Optional disposable checkout root (defaults to OS temp) |
| `DEVINT_GRAPH_CACHE_SIZE` | Warm canonical exact-revision graph cache bound |
| `DEVINT_GRAPH_SNAPSHOT_CACHE_SIZE` | Bound for explicit ephemeral runtime graph snapshots |
| `DEVINT_GRAPH_MAX_FILES` | Maximum eligible tracked files considered in one graph build |
| `DEVINT_GRAPH_MAX_FILE_BYTES` | Maximum individual text file size analyzed |
| `DEVINT_GRAPH_MAX_RUNTIME_BYTES` | Runtime response body cap |
| `DEVINT_RUNTIME_TIMEOUT_MS` | Runtime GET timeout |
| `DEVINT_HOST` | Optional bind host; defaults to loopback locally and `0.0.0.0` when a platform `PORT` is supplied |
| `DEVINT_PORT` | Optional explicit local/service port override |
| `PORT` | Hosting-platform port, used when `DEVINT_PORT` is not set |

There is no required durable `DEVINT_DATA_DIR`, graph database, or provider-specific storage configuration.

## Project access registry

The registry may define only operational access:

- repository URL;
- default and allowlisted refs;
- repository credential source;
- runtime origins;
- runtime request headers backed by environment variables.

It must not define project ontology, feature meaning, source authority, desired product behavior, or project-specific analyzer branches.

## Repository credentials

Repository URLs must not contain credentials. Token credentials are read from configured environment variables and supplied through a short-lived Git askpass helper. Scratch paths and credentials are never graph identities.

## Exact remote read

1. Validate project/ref against the registry.
2. Resolve the remote ref **once** to an exact SHA.
3. Carry that immutable revision context through the operation.
4. Create a disposable checkout.
5. Fetch that exact SHA and verify `FETCH_HEAD`.
6. Build/query the graph and, when requested, read source from that same SHA.
7. Delete the checkout.

A moving branch may cause an explicit retry/failure. DI must not resolve a mutable ref twice inside one operation and silently combine two revisions.

Warm process-memory graph reuse is allowed only when keyed by the exact project SHA and is never authoritative.

## Canonical W and runtime snapshots

Ordinary project/ref queries always address canonical source-derived W.

When `scan_graph` receives runtime URLs, DI returns an explicit ephemeral `graphId` for that observed snapshot. Callers pass that `graphId` to subsequent graph/code/Viewer operations that need the runtime overlay.

Runtime snapshots:

- are bounded process-memory acceleration;
- never become implicit “latest project state”;
- never replace canonical project/ref W;
- may expire and be recreated;
- are not sealed into A/B automatically.

## Candidate sealing

Graph sealing belongs in the inspected project's own candidate workflow:

1. make the intended source changes;
2. generate B with `graphCli seal` against the exact candidate working tree;
3. run `graphCli check` and review semantic A→B drift as appropriate;
4. commit source + `.development-intelligence/` checkpoint according to the project's workflow;
5. merge through normal review/release process;
6. after merge, B is the new A by ordinary Git semantics.

If A is absent or damaged, DI can still generate W from Git. Checkpoint failure must not make source unavailable.

### Currentness interpretation

`project_status` reports separate dimensions:

- source match;
- semantic topology match;
- evidence match/drift;
- analyzer match/drift;
- supported checkpoint schema;
- checkpoint integrity.

Evidence/analyzer drift alone does not invalidate accepted semantic topology. Corrupted shard topology, unsupported schema, or source/topology mismatch does.

## Authentication

DI keeps authentication provider-neutral while supporting the small private deployment directly.

### Native private mode — recommended for a single owner

`DEVINT_AUTH_MODE=private` separates human and machine access:

- `DEVINT_OWNER_PASSWORD` signs the owner into the browser Viewer;
- `DEVINT_SESSION_SECRET` signs a bounded `HttpOnly`, `SameSite=Strict` owner session cookie;
- `DEVINT_AGENT_TOKEN` is a separate Bearer credential for agent/MCP access;
- `DEVINT_SESSION_TTL_SECONDS` optionally changes the owner-session lifetime (default 12 hours);
- secure cookies are on by default and should remain on for HTTPS deployments. `DEVINT_COOKIE_SECURE=0` exists only for local HTTP development/testing.

Private mode intentionally does **not** create user accounts, roles, or a credential database. It represents one owner plus explicitly credentialed agents. Deployment secrets remain outside Git, so the repository may stay public without exposing the running service.

### Bearer

`DEVINT_AUTH_MODE=bearer` + `DEVINT_BEARER_TOKEN` protects every Viewer/MCP request with one bearer credential.

### Trusted proxy

`DEVINT_AUTH_MODE=proxy` + `DEVINT_PROXY_SHARED_SECRET`; an authenticated gateway supplies `X-Devint-Proxy-Secret`.

### Local development only

Unauthenticated mode fails closed unless both `DEVINT_AUTH_MODE=none` and `DEVINT_ALLOW_UNAUTHENTICATED=1` are present.

### Hosted OAuth

OAuth is an interoperability boundary, not the graph engine's identity model. A ChatGPT-facing or other OAuth deployment may terminate OAuth at an appropriate gateway/proxy and forward authenticated requests into DI's trusted proxy boundary. Native private mode remains useful for direct browser and bearer-capable agent access.

When an OAuth client requires the standard MCP authorization flow, the deployment must expose the appropriate OAuth discovery/resource metadata, issue resource-scoped tokens, and preserve refresh-token connectivity where the client requires it. DI must not mislabel a static bearer token as OAuth.

A release that changes or replaces the hosted OAuth gateway must prove end-to-end:

1. OAuth authorization succeeds for the intended client;
2. the gateway forwards to DI using the trusted boundary;
3. MCP discovery and tool calls succeed;
4. unauthorized requests fail closed;
5. refresh/reauthorization behavior is appropriate for the client;
6. the candidate exact SHA/version is the service actually reached.

A successful native-private or proxy test does not substitute for this hosted OAuth acceptance when the real client uses OAuth.

## Pull-request Preview acceptance

The repository's `verify` workflow can expose a temporary human-review Preview for an exact PR head after the normal verify and CardForge benchmark jobs succeed.

The Preview lane:

- checks out the exact PR head rather than the synthetic merge ref;
- serves only that local repository through an isolated project registry;
- runs DI in **native private mode** with an ephemeral owner password, agent bearer token, and session-signing secret;
- exposes DI directly through a pinned, checksum-verified Cloudflared HTTPS tunnel;
- proves an unauthenticated Viewer redirects to DI's own sign-in page, owner sign-in opens the Viewer, unauthorized MCP fails with `401`, and the separate agent token reaches modern MCP discovery/tool listing;
- publishes the exact candidate SHA plus ephemeral owner/agent credentials only in a one-day private Actions artifact;
- ends when the job is cancelled or reaches its timeout and creates no durable graph authority.

The lane is intentionally a physical pre-merge acceptance surface for the same owner/agent access model recommended for small deployments. Passing it does not substitute for hosted OAuth acceptance when a client such as ChatGPT is configured to require OAuth.

## Runtime observation safety

Runtime origins are operator-allowlisted. Requests are GET-only and bounded by timeout/body size. Redirect origins are revalidated; configured authenticated headers cannot be forwarded to a different origin. Credential values remain server-side and never enter accepted checkpoints.

## Recovery

There is deliberately little service-local recovery procedure:

- lost scratch checkout → regenerate from Git;
- lost canonical cache → regenerate from exact Git revision;
- lost runtime snapshot → rescan if still needed;
- lost host instance → regenerate from Git;
- damaged accepted checkpoint → regenerate/seal from the corresponding source revision and review the repair through Git.

The canonical repository remains usable even if Development Intelligence is unavailable.
