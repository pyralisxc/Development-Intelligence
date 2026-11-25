# Operations

## Hosting principle

Development Intelligence does not require a permanently administered graph database or persistent graph disk. Git remains source/history authority, while reconstructable hosted source graphs use configured DI canonical persistence (currently Vercel Private Blob). Local checkouts, query artifacts, and analyzer caches remain reconstructable compute.

Vercel container deployment is runtime-change scoped. `vercel.json` compares the candidate Git SHA with Vercel's last successful deployment SHA over runtime source, dependency manifests/lockfile, TypeScript runtime build configuration, `Dockerfile.vercel`, Vercel configuration, and Docker ignore rules. Documentation, tests, benchmarks, GitHub workflow edits, packaged-action-only edits, and other runtime-neutral repository changes skip the expensive container build and do not push a new image. Missing previous-deployment identity, an unavailable comparison revision, and same-SHA redeploys fail open to a real build so first deploys, failed-build recovery, and provider/environment-triggered redeploys cannot be hidden by the optimization. Preview/Main correctness remains owned by GitHub verification; runtime-affecting commits still deploy normally.

Inspected repositories do not need a generated semantic checkpoint. Consumers should pin `pyralisxc/Development-Intelligence` to a reviewed full commit SHA and use checkpointless `mode: analyze` when they want repository-side CI evidence. DI derives current knowledge from source graphs; repository source and product/architecture documents retain their own authority roles.

The legacy `check` / `seal` checkpoint modes remain for DI self-verification and migration compatibility, not as the normal authority model for inspected repositories.

The **source repository and running service have independent visibility**. The Development Intelligence repository may be public for collaboration, inspection, and reuse while a deployed Workbench/MCP endpoint remains privately gated. Repository privacy must not be treated as the service's authentication boundary.

The hosted service needs only:

- Node.js 22.13+ (or 23.4+ on Node 23);
- Git;
- temporary filesystem capacity for exact-revision checkout;
- the project access registry and referenced credentials;
- HTTP/MCP authentication;
- on horizontally scaled OAuth hosts such as Vercel, a tiny shared Redis store for one-time authorization codes.

GitHub may own source/history and a platform may host the Workbench/MCP plus disposable compute. The hosting provider is not durable graph authority. Shared OAuth code state is operational authentication state only and never becomes graph/project authority.

## Configuration

For the user-local Linux and Windows application, setup, storage, graph retention, backup, and desktop/MCP access, see [Local Development Intelligence](local-workbench.md). The Windows local distribution is separate from the managed compute trial below.

### Managed Windows compute trial

The Windows package under `packaging/windows` is a per-machine x64 **unsigned laboratory artifact**. It bundles pinned Node 22, MinGit (including the askpass shell), native parsers, production dependencies and WinSW. WinSW uses the OS-serviced .NET Framework 4.8+ runtime; the installer fails if that prerequisite is absent and never installs it. MSI owns service registration/removal and major upgrades; WinSW supervises the process. The installer creates a manual, stopped `DevelopmentIntelligenceTrial` service under LocalService with an unrestricted service SID. No firewall rule, scheduled task, production credential, global PATH entry or global runtime is installed.

Versioned binaries live under Program Files. ProgramData/DevelopmentIntelligenceTrial contains protected `config`, retained `test-data`, bounded rotating `logs`, and disposable `scratch`. Service-SID ACLs permit configuration reads and scratch/log writes; Administrators and SYSTEM retain control. The actual SID and ACL behavior depends on Windows and can be examined through use of the installed package; the current build workflow does not exercise an installer lifecycle.

Activation requires an administrator-provided `config/service.json` with `formatVersion: 1`, `authMode: "bearer"`, an `agentToken` of at least 32 characters and an explicit `projects` access registry. Optional `remoteStorage` contains the approved remote Blob `storeId` and `token`. Never commit this file or put production credentials into trial CI. The launcher strips inherited provider/runtime settings, binds only 127.0.0.1:8788 and installs no reconciliation scheduler. Local canonical filesystem configuration is unavailable in this managed profile. Unconfigured startup fails closed.

Remote DI persistence remains durable authority. Git/source remains implementation evidence. A compute node does not become a concurrent production publisher by being installed. Initial trial state/credentials must be isolated from production; production publisher transfer and simultaneous nodes require separate publication coordination and approval. Existing source read/currentness guards remain unchanged.

The launcher fixes `DEVINT_COMPUTE_ONLY=1`; configuration cannot override this role. All three canonical persistence writers reject it explicitly, even with a configured remote credential. HTTP reconciliation remains unavailable to this compute-only role. `scan_graph` permits only immutable `commit:<full-sha>` replay. Cache-loss graph reconstruction uses the existing replay path, while ordinary canonical reads retain exact revision and integrity validation. The role is inherited by worker threads; it is not an absent-credential convention or merely a disabled scheduler.

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

Receipt readers allow delete sharing and retain an immutable opened-file snapshot while the producer atomically replaces its name. Transient sharing/lock/file-observation failures may be re-read within the original wait deadline; no trust/schema/permission check is relaxed and no installer write is retried. An initiating error is preserved beneath the no-mutation fence as exception type/numeric code/source-line diagnostics rather than replaced by an apparent installer failure.

The caller waits at most five minutes for retained terminal evidence. A transient inbox-Windows-PowerShell waiter holds the real MSI process handle and records its exit even after the caller returns; it is not a service/task or a retrying daemon. A deadline, interrupted waiter or unreadable/malformed intent means **uncertain**, not failed. No installer/waiter kill, replay, activation, cleanup or automatic rollback is submitted from that state. Every later mutating operator action refuses the unresolved fence. Keep the waiter and source MSI available; a permanently stuck installer or lost completion evidence requires native Windows Installer/operator investigation, not an inferred retry. Local intent is retained across package removal; reboot/power-loss robustness still needs later host acceptance.

`Status` and `Reconcile` are observational and never clear the fence; missing/reused PIDs and current HTTP health are not terminal evidence. Administrative `Resolve` is a separate explicit mutation of the fence only: it requires retained terminal evidence, no observed busy installer, and operation-specific exact installed identity/integrity (or verified service/product absence after successful uninstall). It never installs, rolls back or starts the service. A known nonzero terminal failure is distinct from uncertainty. Busy 1618, suspended 1604 and success requiring reboot 1641/3010 never enter automatic rollback. Busy resolution additionally waits for installer-idle observation; suspended transactions require native recovery. Reboot-required resolution requires a changed observed boot identity and matching installed state; that path is not reboot acceptance. Unexpected/corrupt installed state remains refused for native recovery rather than fabricated health.

Observations report installer `busy`/`idle`/`unavailable` separately from the tracked MSI terminal result. Exit 0 is not an idle observation. `Resolve` rechecks the native service state itself and refuses busy or unavailable status; callers may poll read-only `Reconcile` within their own finite budget, then make one explicit resolution attempt. The `mutationAllowed` field describes only the MSI fence, not ownership of the separate command lock or permission to skip fresh validation.

The native query records raw `SERVICE_STATUS_PROCESS` facts. Microsoft documents the active installer control **value** as `SERVICE_ACCEPT_SHUTDOWN` (4); merely testing that bit conflates it with the observed cached/stoppable `SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN` mask (5). Running/4 remains busy; running/5 is the observed quiescent service state; stopped is idle. Other running masks, transitions and query failures remain unavailable. Neither mask 5, service liveness nor process absence proves MSI completion: retained terminal evidence, snapshot identity and operation-specific installed-state checks remain mandatory before explicit resolution. See [Microsoft's installer guidance](https://learn.microsoft.com/en-us/windows/win32/msi/-msiexecute-mutex) and [native status contract](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_status_process).

Service stop submits `Stop-Service -NoWait` before its 45-second status wait. Start submits the native request without an implicit readiness loop. Exact authenticated health uses a 60-second request budget with remaining-time HTTP/CIM bounds; other CIM observations have ten-second limits. These bound caller waits, not every filesystem or native SCM RPC, and do not guarantee an OS or hung installer will finish. Single-operator locking does not control unrelated administrators, raw MSI invocations or a future fleet.

The package includes an exact-source compatibility/capability descriptor: graph schemas, analyzer version, query artifact format, declared language support, fixed role and configured resource bounds. Installed activation compares that descriptor with the compiled engine. Non-listening Preflight is reused by Start and Update; incompatible or corrupt candidates are rejected before service disruption. Major upgrades require the operator's descriptor-check marker to prevent accidental raw-MSI bypass; this is a mechanical guard, not publisher trust or a security boundary. Use the current operator script for upgrades.

Replay compatibility is distinct from canonical-read compatibility and remote availability. Preflight makes bounded GET-only query-pointer observations for every configured project, up to eight projects in batches of four with a 2.5-second request timeout and 128 KiB response bound. Beyond that limit the observation is explicitly incomplete. Remote absence or schema/analyzer drift does not block the default immutable-replay role. Optional `requiredCapabilities: ["canonical-read"]` blocks activation unless every configured project's observed metadata is compatible. Pointer metadata alone does not certify currentness, payload integrity or legacy semantic-history compatibility; existing readers still enforce payload and identity boundaries. Source reachability is not probed. Host memory/processor/storage readings are observations, while software support and resource bounds are declarations, not capacity acceptance. Managed health omits project/revision details from these observations.

Scratch is cleared at each exclusive service start and managed stop, checked every five seconds for link integrity, and never pruned during active work. The protected service configuration can set `capacity.scratchBytes` as an optional budget; when configured, exceeding it stops the service, and polling can temporarily overshoot. There is no default scratch-byte budget or fixed 768 MiB process heap. `capacity.scipHeapMB` and `capacity.buildConcurrency` optionally configure the producer and concurrency; an unset heap uses Node's default. This compute-only service currently builds in its own Node process, so a separate graph-worker heap setting does not control that process. The service must be restarted for configuration changes. Logs rotate at 1 MiB with four retained files per stream. Warm graph counts/build concurrency are bounded independently; record budgets and V8 heap limits are not total-memory guarantees.

Builds use `Build-Package.ps1 -MsiVersion <three-part-version>` from committed exact source. The builder creates a fresh Git archive of that SHA, installs lockfile dependencies and rebuilds runtime output inside that disposable snapshot; ignored caller `dist` and untracked source cannot be stamped as the engine SHA. It requires the pinned build Node version without installing prerequisites. Runtime archives are hash-pinned in `dependencies.json`; CI uses pinned Node and WiX 5.0.2. Each payload manifest records engine/package SHA, archive provenance, runtime versions, per-file hashes and MSI version. The external MSI metadata records the final MSI hash. Hashes establish artifact identity, not publisher trust: signing and trusted distribution remain later release gates. Do not bypass operating-system warnings.

The `windows-package` workflow builds an unsigned package on a disposable GitHub-hosted Windows runner. It no longer runs the removed installer lifecycle suite. Oakley source editing/build artifacts do not authorize installation there. Reboot, power-loss recovery, actual Oakley resource suitability and public TLS/OAuth/MCP connectivity remain later host acceptance.

| Variable | Purpose |
|---|---|
| `DEVINT_COMPUTE_ONLY` | Set to `1` to deny all canonical/accepted-authority writes and mutating HTTP/MCP operations; immutable source replay and remote authority reads remain available. The managed Windows profile fixes this role. |
| `DEVINT_DEPLOYMENT_SCOPE` | Set to `preview` on a non-Vercel Preview host to select revision-bound Preview replay storage and prohibit canonical-authority writes. Supply `DEVINT_BUILD_SHA` or `DEVINT_PREVIEW_ENGINE_REVISION` for generation isolation across code updates. Vercel Preview is detected from its own environment. |
| `DEVINT_GRAPH_WORKER_HEAP_MB` | Optional Node worker old-generation heap size in MiB for local and Preview graph builds. When unset, Node chooses its default. The host must have enough memory, and a process-wide Node heap option can override worker settings. |
| `DEVINT_SCIP_HEAP_MB` | Optional old-generation heap size in MiB for the separate SCIP TypeScript producer process. Unset uses that process's Node default; worker heap settings do not set the producer heap. |
| `DEVINT_PROJECTS_FILE` | Operational repository/ref/runtime/technical-source allowlist registry |
| `DEVINT_PROJECTS_JSON` | Optional inline hosted registry; takes precedence over the file when set |
| `DEVINT_GITHUB_ALLOWED_OWNERS` | Optional comma-separated GitHub owners whose repositories may be inspected dynamically as `owner/repository` |
| `DEVINT_GITHUB_APP_ID` | Preferred dedicated read-only GitHub App ID for dynamic GitHub repositories |
| `DEVINT_GITHUB_APP_PRIVATE_KEY` | Private key for the dedicated DI GitHub App; used only to mint short-lived single-repository read-only installation tokens |
| `DEVINT_GITHUB_TOKEN_ENV` | Token fallback environment-variable name for dynamic GitHub repositories; defaults to `DEVINT_GITHUB_TOKEN` |
| `DEVINT_SCRATCH_DIR` | Optional disposable checkout root (defaults to OS temp) |
| `DEVINT_MACHINE_GRAPH_DIR` | In Preview scope on a persistent machine, stores the same retained graph and SQLite indexes used locally; engine, repository and access scope isolate generations. |
| `DEVINT_MACHINE_GRAPH_RETAIN` | Number of retained machine Preview graph generations per project and access scope; defaults to 3. |
| `DEVINT_GIT_TIMEOUT_MS`, `DEVINT_DEPENDENCY_INSTALL_TIMEOUT_MS` | Optional process timeouts. Unset means DI imposes no timer; the host may still end the process. |
| `DEVINT_DERIVED_OBJECT_MAX_BYTES` | Optional maximum per derived storage object; callers may request a smaller bound. Unset imposes no additional DI size cap. |
| `DEVINT_TECHNICAL_SOURCE_MAX_BYTES` | External technical-source response bound; defaults to 2 MiB. |
| `DEVINT_JOERN_MAX_SLICE_BYTES`, `DEVINT_JOERN_MAX_NODES`, `DEVINT_JOERN_MAX_EDGES`, `DEVINT_JOERN_MAX_SOURCE_FILES`, `DEVINT_JOERN_MAX_CODE_CHARS` | Optional Joern input limits; unset means no additional DI cutoff. |
| `DEVINT_CANONICAL_INCREMENTAL_MAX_CHANGED_FILES`, `DEVINT_CANONICAL_INCREMENTAL_MAX_FRONTIER_FILES` | Optional thresholds for switching to a complete rebuild. Unset does not impose the former 32/64-file thresholds; other producer and coverage constraints still require a full rebuild. |
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

The default runtime has no required durable `DEVINT_DATA_DIR` or graph database. The optional persistent-machine Preview store uses `DEVINT_MACHINE_GRAPH_DIR`; the installed local application uses its chosen data directory. Local/single-instance OAuth can use process-memory authorization codes. Vercel and other horizontally scaled deployments require a small shared Redis authorization-code store so separate authorization and token requests remain reliable and one-time.

### Capacity and limits

`di capacity` inventories the installed working files without building a graph. The installation page has the same measurement, and `project_capacity` inventories an authorized committed revision for an agent. The output identifies the selection, recognized file paths and bytes by extension, host/Node observations, free space for scratch and the graph data location, and selected settings. Recognized paths do not establish relationship coverage. Source bytes are the space for one materialized source copy, not a prediction of graph, index, dependency, peak memory, or total scratch consumption. These unknowns must be calibrated with actual builds by language and producer; free memory and free space can change during a build. Scratch may be memory-backed even when the graph data directory has ample disk space.

For sizing, peak RAM is the maximum over time of the simultaneous DI process, graph worker, producer subprocesses and memory-backed scratch, not the sum of every phase's individual peak. Required disk at peak includes source checkout copies, installed dependencies, producer intermediates, retained graph generations and indexes, and temporary publication files on their respective volumes. Retained storage depends on how many revisions are kept. A heap setting constrains V8's old generation, not total resident memory. Measure phase peaks and artifact sizes for representative repositories, then use those observations to estimate similar workloads; source byte counts alone do not determine graph cardinality or producer cost.

An initial source census on 2026-11-23 measured CardForge revision `a38a5fa7d0b4d4f769d8205921ff5a18ae4e93b8` at 2,006 regular files / 33,546,027 bytes, of which 1,893 files / 13,040,376 bytes had paths recognized by DI. The public Unity C# reference revision `cf583fbe6da6b9fb11e3a1ac03f23df4eb120e9b` had 9,055 regular files / 106,438,324 bytes, including 9,035 C# files / 102,572,676 bytes. Its five `.csproj` files and one `.sln` were not recognized source paths in this census. These are source-inventory measurements, not a claim of complete C# relationships or a Unity graph build. An existing single CardForge graph generation and its local index occupied about 2.8 GiB on disk, illustrating why the source size is not a graph-size formula. The measurements describe those revisions and configurations, not a universal expansion factor.

A subsequent CardForge machine-mode build of that revision on 2026-11-24 took 469 seconds, and opening its retained metadata took 49 milliseconds. It analyzed 1,893 files, with one partial file and no skipped or failed eligible files. SCIP reported partial coverage, including one skipped index document and unresolved definition locations. `/usr/bin/time -v` reported a maximum resident size of 4,205,052 KiB for the command's largest process; that is not a measurement of simultaneous whole-system or producer-plus-worker peak memory. The retained generation and its index occupied approximately 2.8 GiB. The run used a 6,144 MiB graph-worker old-generation setting and a separate 4,096 MiB SCIP setting; these are settings, not measured consumption.

On a persistent-machine Preview host, opening an unbuilt revision queues its graph, immediately opens the Workbench, and exposes actual source preparation, producer, analysis, relationship, and publication stages. Agents can use `start_graph_build` and `graph_build_status` for the same job. Requests for the same project and exact revision share one in-process job; retained generations survive a server restart, while an in-progress job and its status do not. A later request can build again if no completed generation was retained. This mode does not create a machine host or override a serverless provider's execution lifetime.

The serverless Preview artifact store and the persistent-machine SQLite store do not yet have equivalent question retrieval: a Workbench question can materialize the full serverless graph, while the machine store can select indexed graph records. On 2026-11-24 an actual serverless Preview Workbench request ran out of JavaScript heap while parsing data; a later request against the same revision succeeded in a fresh runtime. A successful retry does not establish that the hosted handoff handles larger graphs. The initial overview also requests a default-to-selected comparison. Keep those graph reads and their possible overlap in capacity planning until the shared investigation uses selective storage access on this host too.

The investigation interface accepts multiple questions without a fixed question-count ceiling. Questions execute in order, preserve their positions and can use the previous subject; their processing and response size still grow with the request. The current multiple-question path can materialize the graph rather than use the single-question local selective reader.

Captured SQL catalog reconciliation filters the graph by an exact schema-qualified routine instead of rejecting a repository because of its total graph node count. It still has separate bounds for provider observations, candidate cross-products and pages; exceeding them is an explicit unavailable comparison, not evidence of absence. Those remaining bounds require capacity-aware pagination before they can be removed without materializing an unbounded cross-product.

Capacity has distinct owners: optional graph/producer source budgets determine work included, and coverage reports omissions; a worker's heap is only part of process memory; concurrency determines overlapping work; cache limits evict derived in-memory accelerators; graph retention controls persisted history; response page sizes constrain one presentation rather than the underlying source graph. External request and OAuth body bounds, sanitized external evidence and provider limits are separate transport constraints. Joern's heap and deadline are optional operator settings, and its default slice depth is 12 unless selected otherwise. Removing a DI cutoff does not remove physical memory, disk, runtime, provider or language-integration boundaries.

The separately packaged managed Windows trial declares its default resource profile in its package descriptor and accepts optional capacity settings in the protected service configuration. Its scratch location remains the managed service directory; the normal local installation separately allows the user to choose scratch and graph locations. The package changes require Windows build and service validation; the descriptor alone is not a capacity measurement.

Process memory is an accelerator rather than authority. Cache entry counts remain hard upper bounds, while `DEVINT_GRAPH_CACHE_MAX_RECORDS` adds one shared weight budget across canonical graphs and runtime snapshots so a handful of large graphs cannot be treated like a handful of tiny graphs. Record weight counts the graph's retained source, evidence, node, edge, conflict, divergence, coverage, and unresolved-reference records; it is a deterministic retention proxy, not a byte estimate. The currently requested graph survives pruning even when it alone exceeds the budget. Unrelated cold builds pass through a bounded process-local gate, while requests for the same immutable project/SHA continue sharing one in-flight build promise.

## Observability ownership and log correlation

DI has multiple operational evidence owners. None is a second source of graph or semantic authority.

| Owner | Evidence / inspection | Limit |
|---|---|---|
| DI application | `project_status` and `project_statistics` expose exact-revision graph/cache/build measurements and a scoped, volatile last-tool duration; `orient_scope` / `investigate` return query-phase timings | In-process timing is not a durable log; it does not certify runtime execution |
| GitHub Actions | Exact SHA + workflow run/job log + pinned benchmark artifacts | Distinct runners and samples are not causal performance comparisons; preserve failed runs |
| Vercel | Exact deployment source revision, build logs and HTTP runtime request logs | Deployment READY or /mcp HTTP 200 alone does not prove authenticated semantic answer acceptance |
| Managed Windows trial | Protected local rotating service stdout/stderr and separate native installer/operator receipts | 1 MiB with four retained files per stream; uncertain MSI state is not resolved by missing log lines |

**Correlate before attributing:** project/access scope, exact Git SHA, analyzer version and graphId for DI source; workflow run/job ID for CI; deployment ID and request timestamp for Vercel. A universal cross-provider request identifier and durable cross-platform trace join are **not** currently established; report them as gaps, not working features.

Repository-level orientation now includes a bounded request-local `observability` projection recording durations for `graphAccess`, `scopeSelection`, `adjacencyIndex`, `rankingAndRoles`, and `semanticUnderstanding`, tied to exact graphId/revision. The request projection can expose these timings during real investigations. A high-level `What does this project do?` question now selects the same full current-source semantic explanation directly and reports `projection.kind=repository-semantic-summary`; it does not compute a large unused structural ranking. Explicit `orient_scope` still exposes ranked structural entities, boundaries, roles and uncertainty. Omitted structural detail is marked as not materialized, never misreported as absent. These measurements are not cumulative across independent requests and are separate from cold graph construction and full MCP/HTTP response time. No budget is relaxed.

Never log raw question text, source bodies, cookies, auth headers, bearer tokens or provider secrets in tracing metadata. Maintain each existing platform's access control and retention. A successful log entry is operational observation, not graph proof.

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

These normalized results are read-only investigation evidence. Provider state remains authoritative for provider facts, raw provider data remains inspectable, and neither raw nor normalized external evidence automatically rewrites source facts or graph lifecycle.

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
- do not replace the selected source graph.

## Human Workbench

For the account Workbench, configure `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_DEVICE_CLIENT_ID`, `DEVINT_ACCOUNT_NAMESPACE`, and a Redis REST URL/token. Set `DEVINT_ACCOUNT_WORKBENCH=1` for the account landing page at `/`. Namespace Preview and Main independently. The Clerk OAuth application must be public and enable device authorization with `openid profile offline_access`. The account UI produces a one-use link command; run it on the installed computer. It starts the linked process, which also starts when the local Workbench is opened. `di-local account-status` checks the connection and `di-local account-run` runs it in the foreground. A linked computer must be running for its stored graph to be opened or built.

Account records are isolated from the existing single-owner registry. A graph name, source, build computer, storage location and linked query computer are independent settings, with snapshots by default. The query computer must have a configured path to the retained graph. For a build and storage on different linked computers, the shared-folder handoff needs the folder path as seen from each computer; its end-to-end cross-computer behavior has not yet been accepted. The candidate account Workbench offers Vercel Sandbox execution with a per-account, per-environment Drive; graph builds and queries can be configured separately, with CPU counts and session duration selected per graph. It prefers an available linked computer for new definitions. Moving a graph between a linked computer and hosted storage is not yet implemented; select hosted build, storage and query together or use linked computers with an accessible graph path. The GitHub selector uses the signed-in GitHub identity; private repositories require a custom GitHub OAuth connection whose token Clerk can return, as shared development credentials support only public listing. The existing single-owner MCP credentials do not automatically grant access to account-owned projects.

The HTTP entry points are:

- `/` — account landing page when enabled, otherwise the single-owner project chooser;
- `/account` — account Workbench;
- `/workbench?project=<project>` — project Workbench;
- `/workbench?project=<project>&ref=<revision-selector>` — an exact historical workspace;
- `/workbench/data` — read-only Overview/Explore/Inspector/Sources/Changes projections;
- `/workbench/query` — deterministic read-only query routing;
- `/graph?project=...` — compatibility redirect into Explore/Graph.

The Workbench is not a second data owner. It consumes the same graph/evidence/query/source services as MCP.

## Source understanding and change

DI derives current technical understanding from the selected source graph and its evidence. The Workbench Semantics view and MCP expose that same understanding without a separate semantic review or promotion gate. To assess change, compare explicit revisions or the configured default source against the selected state. Existing historical review data is not deleted and is not used as current source authority.

`project_status` reports the selected revision, graph identity, coverage, cache and persistence diagnostics. It does not report an old approval checkpoint as source currentness. Product release and Main promotion remain separate owner-controlled decisions.

## Authentication

DI keeps authentication provider-neutral while supporting a small private deployment directly. Authentication is an access boundary only and never enters graph semantics, source authority, or analyzer behavior.

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

The repository's `verify` workflow can expose a temporary human-review Preview for an exact PR head after the service build succeeds.

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

Runtime origins are operator-allowlisted. Requests are GET-only and bounded by timeout/body size. Redirect origins are revalidated; configured authenticated headers cannot be forwarded to a different origin. Credential values remain server-side and never enter graph evidence.

## Recovery

There is deliberately little service-local recovery procedure:

- lost scratch checkout → regenerate from Git;
- lost canonical cache → regenerate from exact Git revision;
- lost runtime snapshot → rescan if still needed;
- lost host instance → regenerate from Git;
- expired/lost OAuth authorization code → restart the client authorization flow;
- damaged current source graph → rebuild from the selected source revision; preserve any historical records independently.

The canonical repository remains usable even if Development Intelligence is unavailable.

## Automatic canonical currentness reconciliation

Canonical portfolio reconciliation is available only to the authority-capable runtime. Preview and compute-only instances do not expose the portfolio action or start that work; they can inspect and build their own revision-bound derived graphs through the normal graph lifecycle.

Production registers a Vercel Cron request to `/internal/reconcile-canonical` every five minutes. Vercel supplies `Authorization: Bearer $CRON_SECRET`; the route fails closed when `CRON_SECRET` is missing or the bearer value does not match. Ordinary project/ref reads independently resolve the live Git revision before loading canonical W, so this schedule controls background prewarming rather than query correctness.

Each cron request still reconciles **exactly one** active authorized repository. The GitHub installation inventory's repository `pushed_at` timestamp is used only as a bounded acceleration hint: if a repository reports provider activity inside the current five-minute window, the most recently active repository receives that slot. DI does not trust that activity to identify a branch or SHA; the normal reconciliation path independently re-resolves the repository's provider-authoritative default branch before any canonical write. A Preview/work/release push may therefore cause one cheap Main recheck, but can never make that non-default branch canonical.

When no repository reports activity inside the current slot, selection falls back to the deterministic sorted-portfolio rotation. The activity window naturally expires without a durable cursor, so a repository is not permanently prioritized merely because it was active earlier; missed activity still recovers through rotation. This keeps one isolated worker and one repository per cron invocation while reducing the common-case latency of a new default-branch push from a full portfolio rotation to the next five-minute slot. Ordinary query/read surfaces remain mutation-free and continue to resolve exact current revisions on demand.

The scheduled route executes the selected repository inside an isolated Node worker thread rather than building the graph in the long-lived HTTP isolate. DI adds no worker heap override or deadline by default; operators may set `DEVINT_CANONICAL_RECONCILE_WORKER_HEAP_MB` and `DEVINT_CANONICAL_RECONCILE_WORKER_TIMEOUT_MS`. Node and the host still impose their own resource limits, and the timeout cannot exceed Node's timer maximum. A process-wide `--max-old-space-size`, including one set in `NODE_OPTIONS`, overrides the thread's heap setting. A successful worker result reports its effective total V8 heap limit. Request-scoped Vercel OIDC is forwarded only into worker memory for Blob access. A worker OOM, timeout, or crash becomes a structured repository error. Query-artifact publication failures are reported separately with graph persistence status.

This central fallback intentionally catches default-branch changes made outside Conductor as well as missed provider events. Preview, work, and release branch pushes do not become canonical merely because they were pushed. A future Conductor post-promotion reconcile hint may reduce latency, but it is only an acceleration hint: DI remains responsible for validating the repository default branch before publishing canonical current state.

