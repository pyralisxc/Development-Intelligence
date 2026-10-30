# Operations

## Hosting principle

Development Intelligence does not require a permanently administered graph database or persistent graph disk. Git remains source/history authority, while hosted canonical A/W and semantic-review authority use configured DI canonical persistence (currently Vercel Private Blob). Local checkouts, query artifacts, and analyzer caches remain reconstructable compute.

Vercel container deployment is runtime-change scoped. `vercel.json` compares the candidate Git SHA with Vercel's last successful deployment SHA over runtime source, dependency manifests/lockfile, TypeScript runtime build configuration, `Dockerfile.vercel`, Vercel configuration, and Docker ignore rules. Documentation, tests, benchmarks, GitHub workflow edits, packaged-action-only edits, and other runtime-neutral repository changes skip the expensive container build and do not push a new image. Missing previous-deployment identity, an unavailable comparison revision, and same-SHA redeploys fail open to a real build so first deploys, failed-build recovery, and provider/environment-triggered redeploys cannot be hidden by the optimization. Preview/Main correctness remains owned by GitHub verification; runtime-affecting commits still deploy normally.

Inspected repositories do not need a generated semantic checkpoint. Consumers should pin `pyralisxc/Development-Intelligence` to a reviewed full commit SHA and use checkpointless `mode: analyze` when they want repository-side CI evidence. DI canonical persistence owns semantic acceptance/review state; repository source and product/architecture documents retain their own authority roles.

The legacy `check` / `seal` checkpoint modes remain for DI self-verification and migration compatibility, not as the normal authority model for inspected repositories.

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

### Managed Windows compute trial

The Windows package under `packaging/windows` is a per-machine x64 **unsigned laboratory artifact**. It bundles pinned Node 22, MinGit (including the askpass shell), native parsers, production dependencies and WinSW. WinSW uses the OS-serviced .NET Framework 4.8+ runtime; the installer fails if that prerequisite is absent and never installs it. MSI owns service registration/removal and major upgrades; WinSW supervises the process. The installer creates a manual, stopped `DevelopmentIntelligenceTrial` service under LocalService with an unrestricted service SID. No firewall rule, scheduled task, production credential, global PATH entry or global runtime is installed.

Versioned binaries live under Program Files. ProgramData/DevelopmentIntelligenceTrial contains protected `config`, retained `test-data`, bounded rotating `logs`, and disposable `scratch`. Service-SID ACLs permit configuration reads and scratch/log writes; Administrators and SYSTEM retain control. The actual SID and ACL behavior is a disposable Windows CI acceptance gate, not an assumption based on installer XML.

Activation requires an administrator-provided `config/service.json` with `formatVersion: 1`, `authMode: "bearer"`, an `agentToken` of at least 32 characters and an explicit `projects` access registry. Optional `remoteStorage` contains the approved remote Blob `storeId` and `token`. Never commit this file or put production credentials into trial CI. The launcher strips inherited provider/runtime settings, binds only 127.0.0.1:8788 and installs no reconciliation scheduler. Local canonical filesystem configuration is unavailable in this managed profile. Unconfigured startup fails closed.

Remote DI persistence remains durable authority. Git/source remains implementation evidence. A compute node does not acquire semantic acceptance rights or become a concurrent production publisher by being installed. Initial trial state/credentials must be isolated from production; production publisher transfer and simultaneous nodes require separate publication coordination and approval. Existing source read/currentness guards remain unchanged.

The launcher fixes `DEVINT_COMPUTE_ONLY=1`; configuration cannot override this role. All three canonical persistence writers reject it explicitly, even with a configured remote credential. HTTP reconciliation and semantic mutation routes and mutable MCP bootstrap are denied. `scan_graph` permits only immutable `commit:<full-sha>` replay. Cache-loss graph reconstruction uses the existing replay path, while ordinary canonical/A reads retain exact revision/currentness validation. The role is inherited by worker threads; it is not an absent-credential convention or merely a disabled scheduler.

The managed profile supports explicit protected GitHub App material as described below, but no live private-source credentials or production access are established by its disposable tests. Owner OAuth remains outside this profile. Existing hosted production authentication remains at its current owner. Windows SCM and the supplied operator commands are the server-management surface; no separate Start-menu application or destructive purge command is claimed. Normal uninstall intentionally retains protected state. Same-source MSI-version tests prove package replacement/recovery, not cross-schema or cross-analyzer compatibility. Those compatibility and production-access gates remain required before a production replacement is considered.

#### Protected managed private-source binding

Format 1 remains supported for the original bearer/projects/optional remote-storage configuration. Private-source binding requires explicit `formatVersion: 2`, an optional `githubApp` object containing a positive decimal-string `appId` and exactly `privateKeyFile: "github-app.pem"`, and at least one configured project with `credential: {"type":"github-app-bound","binding":"managed-github-app"}`. Bound projects must use explicit GitHub HTTPS repository URLs. The managed profile accepts no arbitrary credential environment passthrough, token fallback or automatic owner discovery. It neither creates an App installation nor grants repository access.

The operator-provided, unencrypted RSA PEM (at least 2048 bits, at most 32 KiB) belongs at `ProgramData/DevelopmentIntelligenceTrial/config/github-app.pem`. No key is supplied by MSI. The loader refuses missing/malformed/oversized/weak material, hard links and reparse ancestors. Native Windows ACL inspection is read-only and bounded; data-root/config directories must have protected DACLs and SYSTEM/Administrators ownership, and effective rules may allow only SYSTEM, Administrators and the exact service SID. The service SID must have read access and no write/delete/ACL-changing rights. Both `service.json` and the key must have trusted ownership and equally restrictive ACLs, either inherited or explicit; config-file ACLs are checked even when no App is configured. Generic LocalService, Users or Everyone grants are not accepted. The launcher never repairs permissions automatically or changes execution policy. An administrator-readable file alone is not proof of restricted-service access; disposable Windows lifecycle verifies the actual service identity.

Preflight and service activation use the same protected-material loader. Preflight reports only local validation, never successful provider authentication or private-source reachability, and does not mint tokens. The service keeps a native key object in process memory, not a PEM environment variable, command argument, child process environment, graph, health response or backup. Explicit bound references reuse the existing per-repository GitHub App reader, requesting only repository contents/pull-request reads; managed token requests reject redirects, exceed neither 10 seconds nor 64 KiB, and refuse malformed, non-read, unexpected-scope or non-short-lived token responses. Git receives only the resulting short-lived token through its existing askpass mechanism. Normal uninstall/update/rollback preserve protected material; fixture backups deliberately exclude it. Credential revocation remains with the provider owner. Real credentials/private-repository access need separate approved configuration and acceptance; generated keys and mocked providers prove software boundaries only.

Native ACL metadata collection uses one OS-only-environment PowerShell invocation for at most four explicit paths, bounded to 15 seconds and 32 KiB. Authorization pins the exact DI service SID independently of returned metadata; installed lifecycle compares it with Windows' actual service identity. Operator preflight has a 45-second enclosing process deadline and exact service health has a 60-second readiness window. Fixed failure-stage codes distinguish native launch/process/timeout/output failures without returning raw stderr or credential values. These deadlines account for native runtime cold start; they do not relax ownership or access rules.

`Manage-Trial.ps1` provides Status, Preflight, Start, Stop, Restart, Update, Uninstall, Backup and Restore. Update requires independently verified SHA256 values for both candidate and known-good MSI, checks candidate compatibility before stopping owned work, installs the candidate and verifies exact managed health. An unhealthy candidate is removed and the prior MSI is reinstalled with protected state retained. This is explicit recoverable replacement, not a claim of atomic upgrade. Preserve both installers outside their installed version directories. Normal uninstall clears owned scratch and removes the MSI-owned service/binaries while retaining configuration, credentials, logs and test fixtures. MSI runs a small Framework cleanup helper cached in its Binary table after service stop and before removing binaries, including direct MSI removal. The helper targets only scratch and does not depend on installed Node, scripts, configuration or ambient ProgramData. A reparse boundary refuses cleanup and leaves the uninstall incomplete for inspection. No shared credential revocation or remote deletion is implied. Backup/Restore covers only nonsecret lab fixtures; remote accepted authority requires its provider-owned recovery procedure.

#### Operator deadlines and uncertain installer outcomes

Retain the exact-source `operator` directory (three PowerShell scripts plus hash metadata) alongside both independently verified MSIs. Use that current bundle for recovery if uninstall removed installed scripts; older operators without the uncertainty protocol do not provide these guards. Hashes identify unsigned lab bytes, not publisher trust. Preflight always uses the installed engine's checked runtime, not an adjacent unversioned engine.

Before an update/uninstall command submits MSI work, it snapshots those three hash-verified tools into protected `config/operator-tools` under the operator lock and no-pending fence. This one bounded tool set survives removal of versioned runtime directories and supplies every waiter in the whole command, including rollback; it is never refreshed from the candidate while recovery is in progress. Intent records bind the snapshot metadata digest, and waiter/resolution checks verify that identity. The retained snapshot also provides the observational/resolution CLI after uninstall. No pending command may replace it. It is operational recovery material, not a second installer/version database or canonical graph state.

Each mutating command holds a protected exclusive operator-file lock. Before launching MSI it persists one bounded, atomically replaced intent under protected `config/operator-msi.json`; this operational fence contains no credentials and is not installation or graph authority. The independently approved MSI hash is retained, not recomputed into a new approval. Caller and waiter hold read leases against ordinary file replacement, and the waiter rechecks the approved hash before launch. Installer registration, exact manifests and payload integrity remain authoritative for observed installed state. Prior-state metadata capture is advisory: malformed candidate bytes must not prevent removal through the exact registered, hash-verified candidate MSI.

The caller waits at most five minutes for retained terminal evidence. A transient inbox-Windows-PowerShell waiter holds the real MSI process handle and records its exit even after the caller returns; it is not a service/task or a retrying daemon. A deadline, interrupted waiter or unreadable/malformed intent means **uncertain**, not failed. No installer/waiter kill, replay, activation, cleanup or automatic rollback is submitted from that state. Every later mutating operator action refuses the unresolved fence. Keep the waiter and source MSI available; a permanently stuck installer or lost completion evidence requires native Windows Installer/operator investigation, not an inferred retry. Local intent is retained across package removal; reboot/power-loss robustness still needs later host acceptance.

`Status` and `Reconcile` are observational and never clear the fence; missing/reused PIDs and current HTTP health are not terminal evidence. Administrative `Resolve` is a separate explicit mutation of the fence only: it requires retained terminal evidence, no observed busy installer, and operation-specific exact installed identity/integrity (or verified service/product absence after successful uninstall). It never installs, rolls back or starts the service. A known nonzero terminal failure is distinct from uncertainty. Busy 1618, suspended 1604 and success requiring reboot 1641/3010 never enter automatic rollback. Busy resolution additionally waits for installer-idle observation; suspended transactions require native recovery. Reboot-required resolution requires a changed observed boot identity and matching installed state; that path is not reboot acceptance. Unexpected/corrupt installed state remains refused for native recovery rather than fabricated health.

Observations report installer `busy`/`idle`/`unavailable` separately from the tracked MSI terminal result. Exit 0 is not an idle observation. `Resolve` rechecks the native service state itself and refuses busy or unavailable status; callers may poll read-only `Reconcile` within their own finite budget, then make one explicit resolution attempt. The `mutationAllowed` field describes only the MSI fence, not ownership of the separate command lock or permission to skip fresh validation.

Service stop submits `Stop-Service -NoWait` before its 45-second status wait. Start submits the native request without an implicit readiness loop. Exact authenticated health uses a 60-second request budget with remaining-time HTTP/CIM bounds; other CIM observations have ten-second limits. These bound caller waits, not every filesystem or native SCM RPC, and do not guarantee an OS or hung installer will finish. Single-operator locking does not control unrelated administrators, raw MSI invocations or a future fleet.

The package includes an exact-source compatibility/capability descriptor: graph schemas, analyzer version, query artifact format, declared language support, fixed role and configured resource bounds. Installed activation compares that descriptor with the compiled engine. Non-listening Preflight is reused by Start and Update; incompatible or corrupt candidates are rejected before service disruption. Major upgrades require the operator's descriptor-check marker to prevent accidental raw-MSI bypass; this is a mechanical guard, not publisher trust or a security boundary. Use the current operator script for upgrades.

Replay compatibility is distinct from canonical-read compatibility and remote availability. Preflight makes bounded GET-only query-pointer observations for every configured project, up to eight projects in batches of four with a 2.5-second request timeout and 128 KiB response bound. Beyond that limit the observation is explicitly incomplete. Remote absence or schema/analyzer drift does not block the default immutable-replay role. Optional `requiredCapabilities: ["canonical-read"]` blocks activation unless every configured project's observed metadata is compatible. Pointer metadata alone does not certify currentness, payload integrity or accepted semantic-authority compatibility; existing readers still enforce those boundaries. Source reachability is not probed. Host memory/processor/storage readings are observations, while software support and resource bounds are declarations, not capacity acceptance. Managed health omits project/revision details from these observations.

Scratch is cleared at each exclusive service start and managed stop, checked every five seconds against a 2 GiB budget, and never pruned during active work. A budget or link-integrity failure stops the service; this polling bound can temporarily overshoot and is not a filesystem hard quota. Logs rotate at 1 MiB with four retained files per stream. Warm graph counts/build concurrency are bounded independently; record budgets and V8 heap limits are not total-memory guarantees.

Builds use `Build-Package.ps1 -MsiVersion <three-part-version>` from committed exact source. The builder creates a fresh Git archive of that SHA, installs lockfile dependencies and rebuilds runtime output inside that disposable snapshot; ignored caller `dist` and untracked source cannot be stamped as the engine SHA. It requires the pinned build Node version without installing prerequisites. Runtime archives are hash-pinned in `dependencies.json`; CI uses pinned Node and WiX 5.0.2. Each payload manifest records engine/package SHA, archive provenance, runtime versions, per-file hashes and MSI version. The external MSI metadata records the final MSI hash. Hashes establish artifact identity, not publisher trust: signing and trusted distribution remain later release gates. Do not bypass operating-system warnings.

The `windows-package` workflow installs only on disposable GitHub-hosted Windows runners. Oakley source editing/build artifacts do not authorize installation there. Reboot, power-loss recovery, actual Oakley resource suitability and public TLS/OAuth/MCP connectivity remain later host acceptance.

| Variable | Purpose |
|---|---|
| `DEVINT_COMPUTE_ONLY` | Set to `1` to deny all canonical/accepted-authority writes and mutating HTTP/MCP operations; immutable source replay and remote authority reads remain available. The managed Windows profile fixes this role. |
| `DEVINT_PROJECTS_FILE` | Operational repository/ref/runtime/technical-source allowlist registry |
| `DEVINT_PROJECTS_JSON` | Optional inline hosted registry; takes precedence over the file when set |
| `DEVINT_GITHUB_ALLOWED_OWNERS` | Optional comma-separated GitHub owners whose repositories may be inspected dynamically as `owner/repository` |
| `DEVINT_GITHUB_APP_ID` | Preferred dedicated read-only GitHub App ID for dynamic GitHub repositories |
| `DEVINT_GITHUB_APP_PRIVATE_KEY` | Private key for the dedicated DI GitHub App; used only to mint short-lived single-repository read-only installation tokens |
| `DEVINT_GITHUB_TOKEN_ENV` | Token fallback environment-variable name for dynamic GitHub repositories; defaults to `DEVINT_GITHUB_TOKEN` |
| `DEVINT_SCRATCH_DIR` | Optional disposable checkout root (defaults to OS temp) |
| `DEVINT_GRAPH_CACHE_SIZE` | Warm canonical exact-revision graph cache bound; zero or a negative integer preserves the legacy minimum of one entry |
| `DEVINT_GRAPH_SNAPSHOT_CACHE_SIZE` | Bound for explicit ephemeral runtime graph snapshots; zero or a negative integer preserves the legacy minimum of one entry |
| `DEVINT_GRAPH_CACHE_MAX_RECORDS` | Combined process-local retention budget across canonical graphs and runtime snapshots; defaults to 150,000 graph records |
| `DEVINT_GRAPH_BUILD_CONCURRENCY` | Maximum unrelated cold graph builds allowed concurrently in one process; defaults to 1 |
| `DEVINT_GRAPH_MAX_FILES` | Maximum eligible tracked files considered in one graph build |
| analyzed source boundary | Git-tracked `node_modules` trees are excluded before fingerprinting, graph-capacity accounting, source search, and semantic analysis; dependency identity remains available through imports, manifests, and lockfiles |
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

Process memory is an accelerator rather than authority. Cache entry counts remain hard upper bounds, while `DEVINT_GRAPH_CACHE_MAX_RECORDS` adds one shared weight budget across canonical graphs and runtime snapshots so a handful of large graphs cannot be treated like a handful of tiny graphs. Record weight counts the graph's retained source, evidence, node, edge, conflict, divergence, coverage, and unresolved-reference records; it is a deterministic retention proxy, not a byte estimate. The currently requested graph survives pruning even when it alone exceeds the budget. Unrelated cold builds pass through a bounded process-local gate, while requests for the same immutable project/SHA continue sharing one in-flight build promise.

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
- optional evidence adapter: `generic-json`, `deployment-state`, or `database-schema`;
- optional exact technical `providerId` used only for exact provider-node correlation;
- optional `freshnessMs` expectation for classifying source-reported timestamps;
- optional environment-backed request headers;
- optional timeout.

DI issues bounded GET requests using query/capability/limit parameters. Credentials remain server-side. The raw bounded provider payload is preserved, while the adapter additionally projects a provider-neutral evidence envelope containing source identity, snapshot/revision identity when observed, freshness, availability, coverage, typed observations, typed external relationships, and exact repository correlations.

The deployment adapter may correlate an externally reported Git SHA only when it exactly equals the inspected repository revision. The database-schema adapter may correlate a table only when it uniquely matches one observed repository `sql-table`. A configured provider id may correlate only to the exact `provider:<id>` node. Ambiguous or unavailable evidence is not promoted to resolved correlation.

These normalized results are read-only investigation evidence. Provider state remains authoritative for provider facts, raw provider data remains inspectable, and neither raw nor normalized external evidence automatically changes accepted semantic topology or graph lifecycle.

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

## Semantic candidate promotion

For an inspected repository:

1. make and verify the intended source changes through that repository's normal Preview-first workflow;
2. DI resolves the exact candidate revision and derives W plus evidence-linked semantic candidates/evolution;
3. review any changed semantic meaning through DI's shared review surface;
4. require a current-revision approval basis for every semantic promotion item;
5. only after the repository's normal human/release gate does DI advance accepted semantic A for the promoted revision;
6. do not commit a generated `.development-intelligence/` authority directory into the inspected repository.

For the **first** enrolled semantic baseline, the owner-authenticated Workbench may use the current-Main bootstrap action. That action is intentionally unavailable to ordinary agent bearer access. It accepts only the explicitly selected current semantic candidates, enrolls `enforced` policy against the full exact-Main candidate census, requires the resulting gate to be `ready`, and then promotes canonical accepted A to that same already-promoted Main revision. The Workbench defaults this action to deterministic factuality-supported **core** candidates; supporting candidates remain proposals unless the owner explicitly accepts them.

The bootstrap action is a one-time authority migration path, not a shortcut around Preview/Main. It refuses stale review digests, non-current W, unsupported selected candidates, ambiguous lineage, or any revision other than provider-authoritative current Main.

For an owner's first portfolio-wide baseline, Workbench also exposes **Bootstrap semantic authority across portfolio**. This is orchestration only: each authorized repository is reconciled to its exact provider-authoritative default branch, audited independently, and given its own authority ledger, enrollment record, accepted A, and gate. The portfolio action selects every current candidate whose deterministic factuality audit is supported, regardless of core/supporting structural classification, because the owner is explicitly delegating the first factual review to DI. Any unsupported, inaccessible, stale, or ambiguous repository is left untouched and reported. Repositories whose exact current semantic census is empty may enroll an empty enforced baseline; a non-empty census still requires explicit accepted meaning records. No cross-repository mega-authority is persisted.

If canonical A is absent, stale, or contradictory, promotion fails closed and the migration/recovery path must make the discrepancy explicit rather than inventing acceptance.

### Currentness interpretation

`project_status` reports separate dimensions:

- accepted semantic currentness;
- source currentness;
- semantic topology currentness;
- evidence currentness/drift;
- analyzer currentness/drift;
- schema support;
- integrity state.

Evidence/analyzer drift alone does not manufacture product-semantic drift. Changed or unsupported semantic topology requires explicit review; repository-local legacy checkpoints are migration fallback only once DI canonical A exists.

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

## Automatic canonical currentness reconciliation

Production registers a Vercel Cron request to `/internal/reconcile-canonical` every five minutes. Vercel supplies `Authorization: Bearer $CRON_SECRET`; the route fails closed when `CRON_SECRET` is missing or the bearer value does not match. Ordinary project/ref reads independently resolve the live Git revision before loading canonical W, so this schedule controls background prewarming rather than query correctness.

Each cron request still reconciles **exactly one** active authorized repository. The GitHub installation inventory's repository `pushed_at` timestamp is used only as a bounded acceleration hint: if a repository reports provider activity inside the current five-minute window, the most recently active repository receives that slot. DI does not trust that activity to identify a branch or SHA; the normal reconciliation path independently re-resolves the repository's provider-authoritative default branch before any canonical write. A Preview/work/release push may therefore cause one cheap Main recheck, but can never make that non-default branch canonical.

When no repository reports activity inside the current slot, selection falls back to the deterministic sorted-portfolio rotation. The activity window naturally expires without a durable cursor, so a repository is not permanently prioritized merely because it was active earlier; missed activity still recovers through rotation. This keeps one isolated worker and one repository per cron invocation while reducing the common-case latency of a new default-branch push from a full portfolio rotation to the next five-minute slot. Ordinary query/read surfaces remain mutation-free and continue to resolve exact current revisions on demand.

The scheduled route executes the selected repository inside an isolated Node worker thread rather than building the graph in the long-lived HTTP isolate. The worker defaults to a 768 MB old-generation limit and a 45 second timeout (bounded overrides: `DEVINT_CANONICAL_RECONCILE_WORKER_HEAP_MB` and `DEVINT_CANONICAL_RECONCILE_WORKER_TIMEOUT_MS`). Request-scoped Vercel OIDC is forwarded only into worker memory for Blob access and is never logged or returned. A worker OOM, timeout, or crash becomes a structured repository error while the parent server survives for the next minute's repository.

This central fallback intentionally catches default-branch changes made outside Conductor as well as missed provider events. Preview, work, and release branch pushes do not become canonical merely because they were pushed. A future Conductor post-promotion reconcile hint may reduce latency, but it is only an acceleration hint: DI remains responsible for validating the repository default branch before publishing canonical current state.

