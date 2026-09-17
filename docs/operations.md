# Operations

## Hosting principle

Development Intelligence does not require a permanently administered graph server, persistent graph disk, external object bucket, or graph database.

Durable accepted intelligence lives with each inspected Git project as `/.development-intelligence/manifest.json` plus deterministic semantic NDJSON shards under `/.development-intelligence/graph/`. It follows ordinary Git history, review, branching, backup, and access control.

Repositories can enforce that authority with the root composite GitHub Action. Consumers should pin `pyralisxc/Development-Intelligence` to a reviewed full commit SHA, check out their own repository first, and invoke the action with a stable project identifier. The default `check` mode is read-only and fails closed on stale or invalid checkpoints. Optional `seal` mode writes a deterministic candidate but never commits or pushes; the consuming repository owns review and acceptance.

The **source repository and running service have independent visibility**. The Development Intelligence repository may be public for collaboration, inspection, and reuse while a deployed Workbench/MCP endpoint remains privately gated. Repository privacy must not be treated as the service's authentication boundary.

The hosted service needs only:

- Node.js 22+;
- Git;
- temporary filesystem capacity for exact-revision checkout;
- the project access registry and referenced credentials;
- HTTP/MCP authentication;
- on horizontally scaled OAuth hosts such as Vercel, a tiny shared Redis store for one-time authorization codes.

GitHub may own source/history and a platform may host the Workbench/MCP plus disposable compute. The hosting provider is not durable graph authority. Shared OAuth code state is operational authentication state only and never becomes graph/project authority.

## Configuration

| Variable | Purpose |
|---|---|
| `DEVINT_PROJECTS_FILE` | Operational repository/ref/runtime/technical-source allowlist registry |
| `DEVINT_PROJECTS_JSON` | Optional inline hosted registry; takes precedence over the file when set |
| `DEVINT_GITHUB_ALLOWED_OWNERS` | Optional comma-separated GitHub owners whose repositories may be inspected dynamically as `owner/repository` |
| `DEVINT_GITHUB_TOKEN_ENV` | Optional credential environment-variable name for dynamic GitHub repositories; defaults to `DEVINT_GITHUB_TOKEN` |
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
| `DEVINT_PUBLIC_BASE_URL` | Stable external origin used as OAuth issuer/resource origin in `oauth` mode. Vercel previews publish their exact system-injected branch/deployment origin instead; production keeps this stable value. |
| `DEVINT_ALLOWED_HOSTS` | Comma-separated exact request hostnames. On Vercel only, exact system-injected deployment, branch, and production hostnames are added automatically; no wildcard is used. |
| `DEVINT_OAUTH_ALLOWED_REDIRECT_ORIGINS` | Comma-separated trusted OAuth callback origins; defaults to `https://chatgpt.com` |
| `DEVINT_OAUTH_ALLOW_LOOPBACK` | Set to `1` to permit native OAuth clients to return only to HTTP loopback hosts with dynamic ports |
| `DEVINT_OAUTH_SCOPES` | Resource scopes; defaults to `development-intelligence.read` |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Shared one-time OAuth authorization-code state for serverless/horizontally scaled hosts |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Accepted legacy Vercel aliases for the same Redis backing service |
| `DEVINT_REQUIRE_SHARED_OAUTH_STATE` | Set to `1` to fail OAuth configuration closed unless the shared code store is available |

There is no required durable `DEVINT_DATA_DIR` or graph database. Local/single-instance OAuth can use process-memory authorization codes. Vercel and other horizontally scaled deployments require a small shared Redis authorization-code store so separate authorization and token requests remain reliable and one-time.

## Project access registry

The registry may define only operational access:

- repository URL;
- default and allowlisted refs;
- revision policy (`allowlisted` by default, or explicit `repository-history`);
- repository credential source;
- runtime origins;
- runtime request headers backed by environment variables;
- optional read-only technical sources.

It must not define project ontology, feature meaning, source authority, desired product behavior, or project-specific analyzer branches.

`DEVINT_GITHUB_ALLOWED_OWNERS` adds a project-neutral GitHub access policy rather than project configuration. A caller points DI at `owner/repository`; DI constructs the canonical GitHub HTTPS URL, authenticates with the configured read-only token, and may resolve `HEAD` or a typed historical selector: `commit:<full-sha>`, `branch:<name>`, `tag:<name>`, `pr:<number>/head`, `pr:<number>/base`, or `pr:<number>/result`. Owners not in the policy fail closed. The credential's GitHub permissions remain an independent second boundary, so an allowlisted name that the token cannot read is still unavailable.

Configured projects remain allowlisted-only unless `revisionPolicy` is explicitly set to `repository-history`. This keeps existing narrow deployments closed while dynamic owner-scoped repositories expose their authorized history.

### Technical sources

A project may declare generic read-only sources for Workbench/MCP access to operational technical data such as databases, logs, metrics, or provider APIs.

Each source declares:

- `id` and optional display `label`;
- `type`: `read-only-http`;
- HTTPS `endpoint`;
- one or more capabilities: `query`, `logs`, or `metrics`;
- optional environment-backed request headers;
- optional timeout.

DI issues bounded GET requests using query/capability/limit parameters. Credentials remain server-side. Source results are read-only observations/evidence and do not automatically become accepted semantic topology.

Technical-source configuration is operational access, not semantic project configuration.

## Repository credentials

Repository URLs must not contain credentials. Token credentials are read from configured environment variables and supplied through a short-lived Git askpass helper. Scratch paths and credentials are never graph identities.

## Exact remote read

1. Validate the project and revision selector against the configured access policy.
2. Resolve the branch, tag, PR identity, or default ref **once** to an exact SHA. A full commit selector is already immutable.
3. Carry that immutable revision context through the operation.
4. Create a disposable checkout.
5. Fetch that exact SHA and verify `FETCH_HEAD`.
6. Build/query the graph and, when requested, read source from that same SHA.
7. Delete the checkout.

A moving branch may cause an explicit retry/failure. DI must not resolve a mutable ref twice inside one operation and silently combine two revisions.

Warm process-memory graph reuse is allowed only when keyed by the exact project SHA and is never authoritative.

## Canonical W and runtime snapshots

Ordinary project/ref queries always address canonical source-derived W. Canonical `repo-…` graph IDs embed the complete immutable Git SHA and may be reconstructed on any service instance; the bounded warm cache only accelerates that work.

When `scan_graph` receives runtime URLs, DI returns an explicit ephemeral `snapshot-…` graph ID for that observed snapshot. Callers pass that ID to subsequent graph/code/Workbench operations that need the runtime overlay.

Runtime snapshots:

- are bounded process-memory acceleration;
- never become implicit “latest project state”;
- never replace canonical project/ref W;
- may expire and be recreated;
- are not sealed into A/B automatically.

## Human Workbench

The HTTP entry points are:

- `/` — project chooser;
- `/workbench?project=<project>` — project Workbench;
- `/workbench?project=<project>&ref=<revision-selector>` — an exact historical workspace;
- `/workbench/data` — read-only Overview/Explore/Inspector/Sources/Changes projections;
- `/workbench/query` — deterministic read-only query routing;
- `/graph?project=...` — compatibility redirect into Explore/Graph.

The Workbench is not a second data owner. It consumes the same graph/evidence/query/source services as MCP.

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

DI keeps authentication provider-neutral while supporting a small private deployment directly. Authentication is an access boundary only and never enters graph semantics, accepted checkpoints, source authority, or analyzer behavior.

### Native OAuth mode — recommended for hosted ChatGPT

`DEVINT_AUTH_MODE=oauth` combines the existing single-owner Workbench session with a standards-oriented OAuth MCP front door.

Required deployment values:

- `DEVINT_OWNER_PASSWORD` — owner browser sign-in and OAuth approval gate;
- `DEVINT_SESSION_SECRET` — root secret for purpose-separated browser-session and OAuth signing;
- `DEVINT_PUBLIC_BASE_URL` — exact stable external HTTPS origin.

The native OAuth surface provides:

- RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`;
- authorization-server metadata at `/.well-known/oauth-authorization-server`;
- public-client registration at `/oauth/register`;
- authorization at `/oauth/authorize`;
- token/refresh exchange at `/oauth/token`;
- authorization-code flow with PKCE `S256`;
- explicit owner consent after sign-in;
- short-lived signed access tokens scoped to the exact `/mcp` resource;
- signed refresh tokens so refresh continuity does not require a local credential database.

Dynamic registration accepts only allowlisted callback origins. `DEVINT_OAUTH_ALLOWED_REDIRECT_ORIGINS` defaults to `https://chatgpt.com`. Do not broaden that list casually. Loopback HTTP redirects are disabled unless `DEVINT_OAUTH_ALLOW_LOOPBACK=1` is explicitly enabled for local-client testing.

`DEVINT_OAUTH_SCOPES` defaults to `development-intelligence.read`. `offline_access` is accepted at authorization time for refresh continuity but is not itself a Development Intelligence resource capability.

`DEVINT_OAUTH_ACCESS_TOKEN_TTL_SECONDS` and `DEVINT_OAUTH_REFRESH_TOKEN_TTL_SECONDS` may adjust bounded token lifetimes. Rotating `DEVINT_SESSION_SECRET` intentionally invalidates owner sessions, OAuth access/refresh tokens, and dynamically registered client IDs.

Authorization codes are intentionally different from access/refresh tokens: they are random, short-lived, and one-time. A single-process/local service keeps them in memory. Horizontally scaled/serverless services use the Redis code store. Code consumption uses atomic `GETDEL`, preserving replay rejection even when the authorization and token requests hit different instances. Vercel sets `VERCEL`, so OAuth configuration there fails closed when shared Redis credentials are absent. `DEVINT_REQUIRE_SHARED_OAUTH_STATE=1` enables the same requirement on other scaled hosts.

A deployment may optionally set `DEVINT_AGENT_TOKEN` in OAuth mode for a trusted non-OAuth client. This does not change what ChatGPT should use: ChatGPT should authenticate through OAuth.

If a client cannot use dynamic registration, a static public client may be configured with `DEVINT_OAUTH_CLIENT_ID`, `DEVINT_OAUTH_CLIENT_NAME`, and the exact `DEVINT_OAUTH_REDIRECT_URIS` supplied by that client. Do not guess callback URLs.

See [Vercel hosting](vercel-hosting.md) for the preferred hosted deployment and [ChatGPT publishing](chatgpt-publishing.md) for account-side setup and the required mixed Development Intelligence + GitHub acceptance.

### Native private mode — direct/local single owner

`DEVINT_AUTH_MODE=private` separates human and machine access:

- `DEVINT_OWNER_PASSWORD` signs the owner into the browser Workbench;
- `DEVINT_SESSION_SECRET` signs a bounded `HttpOnly`, `SameSite=Strict` owner session cookie;
- `DEVINT_AGENT_TOKEN` is a separate Bearer credential for agent/MCP access;
- `DEVINT_SESSION_TTL_SECONDS` optionally changes the owner-session lifetime (default 12 hours);
- secure cookies are on by default and should remain on for HTTPS deployments. `DEVINT_COOKIE_SECURE=0` exists only for local HTTP development/testing.

Private mode intentionally does **not** create user accounts, roles, or a credential database. It represents one owner plus explicitly credentialed agents. Deployment secrets remain outside Git, so the repository may stay public without exposing the running service.

### Bearer

`DEVINT_AUTH_MODE=bearer` + `DEVINT_BEARER_TOKEN` protects every Workbench/MCP request with one bearer credential.

### Trusted proxy

`DEVINT_AUTH_MODE=proxy` + `DEVINT_PROXY_SHARED_SECRET`; an authenticated gateway supplies `X-Devint-Proxy-Secret`.

A gateway remains a valid interoperability option for deployments that need an external identity provider or multi-user policy, but it is no longer required merely to connect one-owner Development Intelligence to an OAuth-capable MCP client.

### Local development only

Unauthenticated mode fails closed unless both `DEVINT_AUTH_MODE=none` and `DEVINT_ALLOW_UNAUTHENTICATED=1` are present.

### Hosted OAuth release acceptance

A successful unit test, native-private test, or proxy test does not substitute for physical acceptance through the real hosted client. A release intended for ChatGPT must prove end-to-end:

1. the final HTTPS origin exposes correct resource and authorization metadata;
2. OAuth client registration/configuration succeeds;
3. owner authorization and PKCE token exchange succeed;
4. MCP discovery and tool calls succeed with the issued access token;
5. unauthorized requests fail closed with the expected OAuth challenge;
6. refresh/reauthorization behavior is appropriate for ChatGPT;
7. the candidate exact SHA/version is the service actually reached;
8. Development Intelligence and GitHub can both execute in the same ChatGPT task when that surface supports multi-app orchestration;
9. a fresh Work session can repeat the mixed-source task when Work is part of the release scope.

## Pull-request Preview acceptance

The repository's `verify` workflow can expose a temporary human-review Preview for an exact PR head after the normal verify and CardForge benchmark jobs succeed.

The Preview lane:

- checks out the exact PR head rather than the synthetic merge ref;
- serves only that local repository through an isolated project registry;
- runs DI in **native private mode** with an ephemeral owner password, agent bearer token, and session-signing secret;
- exposes DI directly through a pinned, checksum-verified Cloudflared HTTPS tunnel;
- proves an unauthenticated Workbench redirects to DI's own sign-in page;
- proves owner sign-in opens the Workbench and its Overview/Sources projections;
- proves unauthorized MCP fails with `401`;
- proves the separate agent token reaches modern MCP discovery/tool listing including Workbench primitives such as `project_overview` and `inspect_entity`;
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
- expired/lost OAuth authorization code → restart the client authorization flow;
- damaged accepted checkpoint → regenerate/seal from the corresponding source revision and review the repair through Git.

The canonical repository remains usable even if Development Intelligence is unavailable.
