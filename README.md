# Development Intelligence

Development Intelligence is a standalone, project-neutral technical intelligence service. It exposes two sibling capabilities:

- **Codebase Memory** — structural code intelligence over an exact repository revision.
- **Parity Engine** — evidence-backed comparison across observable technical representations such as source, UI/runtime, HTTP/API, MCP, structured configuration, tests, and documentation.

Development Intelligence is tooling, not a development methodology. It contains no product intent, workflow stages, Build authorization, PR orchestration, or agent-routing policy.

## Core rules

- Codebase Memory and Parity Engine remain independent siblings.
- Parity Engine has no project-specific extractors and requires no semantic project configuration.
- Generic analyzers may understand languages, frameworks, protocols, and formats; analyzer behavior may never branch on project identity.
- Project-declared semantics are observations, not universal schema.
- Naming differences are preserved rather than normalized away.
- Heuristic relationships retain strategy/evidence/confidence and never silently become facts.
- `unresolved` and unavailable sources are valid results.
- Secret-like structured values are redacted before parity observations are persisted or returned.
- Runtime observation is GET-only and read-only.
- Canonical repositories are never mutated by Development Intelligence.

See [Architecture](docs/architecture.md), [Operations](docs/operations.md), and [Testing](docs/testing.md).

## Revision-bundle lifecycle

The durable unit is an immutable **Revision Bundle**, not a persistent checkout or Codebase Memory process.

```text
repository ref
    ↓
short-lived indexing execution
    ├─ bounded Git checkout/history
    ├─ Codebase Memory full index
    ├─ portable graph.db.zst
    ├─ repository Parity observations
    └─ checksummed source snapshot
    ↓
immutable Revision Bundle
    ↓
durable artifact storage + selected-bundle pointer
    ↓
stateless MCP/API query service
    ↓
ephemeral checked hydration on demand
```

A bundle contains:

- `manifest.json` — project/revision/tool versions, checksums, graph summary;
- `source.tgz` — exact checked-out source plus bounded Git history for source-backed queries and common branch/PR diffs;
- `graph.db.zst` — the upstream Codebase Memory portable graph artifact;
- `repository-parity.json` — repository observations/resolutions produced once at index time.

Failed indexing never changes the selected last-known-good bundle. Bundle promotion requires a healthy Codebase Memory result **and** an actual non-empty portable graph artifact. Query hydration verifies artifact byte counts and SHA-256 checksums before Codebase Memory is allowed to consume the bundle.

## Public MCP surface

Shared:

- `list_projects`
- `project_status`
- `refresh_codebase`
- `delete_project` (derived state only)

Codebase Memory:

- `index_status` (Development Intelligence index/bundle status; no CBM hydration)
- `search_graph`
- `search_code`
- `get_code_snippet`
- `trace_path`
- `query_graph`
- `get_graph_schema`
- `get_architecture`
- `check_index_coverage`
- `detect_changes`

Parity Engine:

- `scan_parity`
- `query_parity`
- `diff_parity`
- `parity_status`

`index_repository` remains an internal Codebase Memory primitive. Runtime-trace ingestion is not part of the immutable canonical revision surface.

## Local development

Requirements:

- Node.js 22+
- Git
- `tar` + `gzip`
- `codebase-memory-mcp` 0.10.8 (or a separately verified compatible release)

```bash
cp config/projects.example.json config/projects.json
cp .env.example .env
npm install
npm run verify
npm run build
npm start
```

Local development/tests use filesystem artifact/control adapters under `.data`. They are intentionally not the production architecture.

## Managed production shape

Production requires:

- a private Google Cloud Storage bucket for immutable artifacts;
- Firestore for project/index/parity pointers;
- a Cloud Run service for HTTP/MCP queries;
- a Cloud Run Job using the same image with `npm run index-job` / `node dist/src/indexJob.js` for indexing;
- Secret Manager / runtime environment injection for credentials;
- an external OAuth/auth gateway or bearer boundary until the dedicated OAuth protected-resource integration is completed.

Set at minimum:

```text
DEVINT_GCS_BUCKET=<private bucket>
DEVINT_FIRESTORE_ENABLED=1
DEVINT_CLOUD_RUN_JOB_RESOURCE=projects/<project>/locations/<region>/jobs/<job>
```

The query service keeps no durable checkout. Warm instances may retain a bounded ephemeral hydration cache; cold instances reconstruct query state from the selected Revision Bundle.

## Project access configuration

The current project registry remains operational configuration only. It tells Development Intelligence where it may observe and which refs/origins are allowed; it never defines what the project means.

Allowed configuration includes repository URL, default/allowlisted Git refs, process-scoped repository credentials, allowlisted runtime origins, and environment-backed runtime headers.

Semantic ontologies, per-project extractors, intent maps, source-authority maps, and project-specific analyzer code are prohibited.

The registry credential seam is intentionally isolated so GitHub App installation-token onboarding can replace static Git credentials without changing Revision Bundle or Parity semantics.

## Refresh behavior

`refresh_codebase` first resolves the requested allowlisted ref.

- If the selected bundle already represents that exact SHA and its manifest is available, it returns without re-indexing.
- In managed hosting, it queues the configured Cloud Run indexing job and returns accepted/index status.
- In local/test mode, it runs the same indexing function directly.

The indexing execution re-checks the upstream ref before promotion. If the ref moved while a job was running, the completed immutable bundle may remain stored, but it is not selected as current.

## Verification

```bash
npm run verify
```

The durable suite protects immutable-bundle promotion, portable-artifact presence, checksum integrity, universal Parity behavior, secret redaction, project isolation, MCP contracts, and the generic source boundary.
