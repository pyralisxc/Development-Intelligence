# Operations

## Production topology

Development Intelligence production is designed for managed, scale-to-zero infrastructure rather than a permanently administered server.

Required components:

- one private Google Cloud Storage bucket for immutable artifacts;
- Firestore for project/index/parity control state;
- one Cloud Run service for HTTP/MCP queries;
- one Cloud Run Job for indexing using the same container image;
- Secret Manager/environment injection for credentials;
- TLS/auth at the service or an existing trusted OAuth/auth gateway.

No persistent VM disk, Git mirror, worktree directory, or durable Codebase Memory cache is required.

## Container roles

The default container command runs the query service:

```text
node dist/src/http.js
```

The indexing job runs:

```text
node dist/src/indexJob.js
```

The query service dispatches the configured Cloud Run Job with `DEVINT_INDEX_PROJECT`, `DEVINT_INDEX_REF`, and the exact `DEVINT_INDEX_SHA` observed when the request was accepted. The job sets `DEVINT_INDEX_EXECUTION=1` so it performs indexing directly rather than dispatching itself.

## Required production configuration

| Variable | Purpose |
|---|---|
| `DEVINT_PROJECTS_FILE` | Current operational project access registry |
| `DEVINT_GCS_BUCKET` | Private Revision Bundle / parity artifact bucket |
| `DEVINT_FIRESTORE_ENABLED` | Set `1` outside production auto-detection when Firestore should be used |
| `DEVINT_FIRESTORE_DATABASE` | Optional non-default Firestore database ID |
| `DEVINT_FIRESTORE_COLLECTION` | Control document collection (default `development-intelligence-projects`) |
| `DEVINT_CLOUD_RUN_JOB_RESOURCE` | Full Cloud Run v2 job resource name used by `refresh_codebase` |
| `DEVINT_EPHEMERAL_DIR` | Scratch/hydration root; `/tmp/development-intelligence` in the image |
| `DEVINT_CBM_BINARY` | Codebase Memory executable |
| `DEVINT_CBM_VERSION` | Version recorded in Revision Bundle identity/provenance |
| `DEVINT_INDEX_TIMEOUT_MS` | Indexing timeout |
| `DEVINT_HYDRATE_TIMEOUT_MS` | Bundle-to-query hydration timeout |
| `DEVINT_HYDRATION_CACHE_SIZE` | Warm-instance idle hydration bound |
| `DEVINT_SOURCE_HISTORY_DEPTH` | Bounded Git history retained in `source.tgz` (default 32, max 500) |
| `CBM_WORKERS` | Codebase Memory worker bound |
| `CBM_MEM_BUDGET_MB` | Optional Codebase Memory memory budget |
| `DEVINT_PARITY_MAX_FILES` | Repository parity file cap |
| `DEVINT_PARITY_MAX_FILE_BYTES` | Per-file parity scan cap |
| `DEVINT_PARITY_MAX_RUNTIME_BYTES` | Runtime response cap |
| `DEVINT_RUNTIME_TIMEOUT_MS` | Runtime GET timeout |

Do **not** set a production `CBM_CACHE_DIR` as durable infrastructure. Index/hydration paths provide job/instance-local cache directories to Codebase Memory.

## IAM boundary

Use separate service identities where practical.

Query service needs:

- read access to private bundle/parity objects;
- read/write access to its Firestore control collection (runtime parity scans and status reads);
- permission to invoke the indexing Cloud Run Job, including execution overrides;
- access only to secrets required for MCP/runtime observation.

Index job needs:

- create/read access to bundle/parity objects;
- read/write access to the control collection;
- source-repository credentials;
- no requirement to receive public user traffic.

Cloud Storage objects must not be public. Canonical repository credentials and runtime observation headers belong in Secret Manager/runtime configuration, never bundle artifacts.

## Authentication

Current service modes remain:

### Bearer

```text
DEVINT_AUTH_MODE=bearer
DEVINT_BEARER_TOKEN=<secret>
```

### Existing OAuth/reverse proxy

```text
DEVINT_AUTH_MODE=proxy
DEVINT_PROXY_SHARED_SECRET=<gateway-to-service-secret>
```

The proxy sends `X-Devint-Proxy-Secret`.

### Local only

Unauthenticated mode fails closed unless both are set:

```text
DEVINT_AUTH_MODE=none
DEVINT_ALLOW_UNAUTHENTICATED=1
```

The dedicated MCP OAuth protected-resource implementation remains a separate security candidate; do not expand project semantics to implement identity.

## Index request and concurrency behavior

`refresh_codebase` resolves the upstream allowlisted ref before dispatch and transactionally claims that exact SHA.

- Current selected SHA + current analysis versions + all referenced artifacts present: returns unchanged.
- Missing referenced artifact or analysis-version mismatch: requests a fresh immutable bundle for the same SHA automatically.
- `force=true`: requests a fresh immutable bundle for the same SHA even when the objects still exist; use this after checksum/integrity failure or another confirmed derived-state problem.
- Same SHA already queued/running: returns a deduplicated accepted result without invoking another job.
- Newer SHA while an older job is queued/running: the newer SHA replaces the active claim. The old job can no longer mutate current index status or promote a bundle.
- Managed production: the exact claimed SHA is passed to the Cloud Run Job.
- Local/test: the same exact-SHA indexing function executes inline.

The job revalidates the mutable ref before expensive indexing and again before promotion. A job whose ref moved becomes `superseded`; it does not follow the mutable ref to a different commit.

Every bundle generation receives unique object keys. Cloud Storage uploads use `ifGenerationMatch: 0` create-only preconditions, so a concurrent writer cannot overwrite an immutable artifact. Firestore transactions guard exact-SHA claim, status transition, and selected-bundle/Parity promotion.

## Indexing behavior

The job uses an ephemeral bounded-history Git checkout. It requires Codebase Memory to produce a healthy index and a non-empty `graph.db.zst`. It then runs repository Parity analysis, creates a source archive, hashes every artifact, uploads artifacts create-only, and writes `manifest.json` last.

The full index uses one hidden Codebase Memory identity derived from the public project and immutable bundle ID. That same identity is reused later when the portable graph is hydrated for queries.

The upstream ref is resolved again before selected-pointer promotion. Failed or superseded indexing never replaces the previous selected bundle.

## Query behavior

Graph/source tools hydrate the selected bundle on demand. Hydration verifies manifest identity, artifact byte counts, and SHA-256 before extracting source or bootstrapping Codebase Memory. The graph is placed at the upstream `.codebase-memory/graph.db.zst` bootstrap location and opened using the same bundle-scoped CBM project identity that created it.

Cold hydration may be slower; warm instances share the hydrated bundle across concurrent requests. A query instance can disappear at any time without recovery work because all durable state is outside the instance.

## Parity lifecycle

Repository Parity is generated once per indexed revision and stored with the bundle. `scan_parity` without runtime URLs returns that indexed repository scan rather than rescanning a source checkout.

Authorized runtime URLs are observed on demand. Those timestamped combined scans are persisted as derived artifacts. A runtime scan may become the latest Parity pointer only while its repository revision still matches the currently selected SHA; a slow scan from an older revision cannot replace current Parity truth after a newer bundle is promoted.

Runtime unavailable/error state is preserved rather than treated as empty or authoritative.

## Project onboarding (current implementation)

1. Add the public project identity and canonical repository to the operator registry.
2. Allowlist only refs Development Intelligence may observe.
3. Inject repository credentials through the referenced environment variable where needed.
4. Optionally allowlist runtime origins and environment-backed request headers.
5. Call `refresh_codebase`.
6. Watch `index_status` until the requested SHA is selected, failed, or superseded.
7. Query graph/Parity only from the validated selected bundle.

No semantic project mapping is created.

GitHub App installation-token onboarding is the intended production replacement for long-lived Git credentials. It is deliberately isolated from this bundle-lifecycle cut and must reuse the same repository/ref authorization seam rather than creating another intelligence path.

## Verification and provider cutover

The repository gate includes a pinned real `codebase-memory-mcp@0.10.8` smoke proving explicit index → portable artifact → clean ephemeral hydration → graph query.

Before production cutover, separately prove the Google Cloud-owned boundaries in the target project:

- Cloud Storage create-only object writes and private access;
- Firestore exact-SHA transactions under concurrent requests;
- Cloud Run Job invocation with environment overrides and least-privilege IAM;
- query-service read access versus index-job create access;
- Secret Manager/runtime credential injection;
- scale-to-zero cold hydration within chosen memory/time bounds.

Do not claim those provider behaviors from local mocks or GitHub CI alone.

## Backup/recovery

Canonical repositories do not depend on Development Intelligence state.

Back up or retain according to policy:

- private Cloud Storage Revision Bundles and runtime parity history you care to preserve;
- Firestore control documents;
- operator access configuration (without duplicating secrets).

No local service filesystem needs backup. A lost hydration/index scratch directory is disposable.

Cloud Storage lifecycle policy should eventually expire unreferenced PR/branch bundles after the chosen retention period while retaining selected/default/history artifacts required by product policy. Do not delete referenced bundles merely to reduce storage.
