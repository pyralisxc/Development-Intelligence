# Architecture

## Durable system shape

```text
                         Development Intelligence

 repository ref ──► short-lived index execution ──► immutable Revision Bundle
                            │                               │
                            │ Codebase Memory               ├─ source.tgz
                            │ repository Parity             ├─ graph.db.zst
                            │ checksums/provenance          ├─ repository-parity.json
                            ▼                               └─ manifest.json

                 durable artifact storage + control pointer
                                  │
                                  ▼
                    stateless MCP/API query service
                                  │
                                  ▼
                     ephemeral checked hydration
                                  │
                       ┌──────────┴──────────┐
                       ▼                     ▼
                 Codebase Memory        Parity Engine
                    queries          query/runtime overlay
```

Codebase Memory and Parity Engine remain independent siblings. The Revision Bundle lifecycle composes their outputs around an exact source revision without making either engine depend on the other.

## Revision Bundle

A Revision Bundle is immutable. Its identity includes the exact source SHA, bundle/engine schema fingerprint, and a unique indexing-generation suffix. More than one valid immutable bundle may therefore exist for the same repository SHA when an analysis is intentionally rebuilt; the selected control pointer decides which validated generation is current.

The manifest records:

- public project identity and repository;
- requested ref and exact source commit SHA;
- bundle schema, Codebase Memory version, and Parity schema version;
- graph node/edge summary;
- SHA-256 + byte count for every artifact;
- creation timestamp.

Artifacts:

- `source.tgz` contains the exact checked-out source and bounded Git history. It is produced from an ephemeral checkout and excludes `.codebase-memory` so the graph has one canonical artifact owner.
- `graph.db.zst` is the upstream Codebase Memory portable artifact.
- `repository-parity.json` contains repository observations/resolutions generated once during indexing.
- `manifest.json` is written last and acts as the bundle commit marker.

Production Cloud Storage writes use create-only generation-match preconditions. A bundle object cannot be silently overwritten by another indexing execution. Local test/development storage enforces the same create-only rule.

The selected bundle pointer is durable control state. Local CBM project names, caches, checkouts, and extraction directories are not durable state.

## Index lifecycle

`refresh_codebase` resolves the mutable repository ref once and transactionally claims the exact observed SHA. Repeated requests for the same queued/running SHA deduplicate before provider dispatch. A newer SHA may replace the active claim; an older worker then loses ownership and cannot update that project's current index state.

Managed indexing receives **project + ref + expected SHA**. A short-lived execution:

1. transactionally transitions its exact SHA claim from queued to running;
2. re-checks that the ref still points at that expected SHA before expensive work;
3. fetches a bounded Git checkout into ephemeral storage and verifies the checkout still equals the expected SHA;
4. retains bounded default-branch history where useful for common branch/PR diff analysis;
5. runs Codebase Memory full indexing with a job-local `CBM_CACHE_DIR`;
6. requires healthy CBM status **and** a real non-empty `.codebase-memory/graph.db.zst`;
7. runs repository Parity analyzers against the same exact checkout;
8. archives source/Git context;
9. creates a unique immutable bundle generation;
10. hashes and uploads bundle artifacts with create-only storage preconditions;
11. writes `manifest.json` last;
12. re-checks the upstream ref;
13. uploads the queryable repository Parity scan;
14. transactionally promotes the selected bundle and repository-Parity pointer only if the execution still owns the expected SHA claim;
15. exits and deletes all local indexing state.

If the ref moves before or during indexing, that execution becomes `superseded`. If a newer request has already claimed another SHA, the stale worker cannot mark the newer request failed/succeeded and cannot replace its eventual selected bundle.

Multiple valid immutable analysis generations may exist for one SHA; object keys never alias those generations. Repeated active requests for the same SHA are deduplicated at the control plane rather than by allowing multiple workers to write one supposedly immutable object key.

## Query lifecycle

The HTTP/MCP service does not need a permanent Codebase Memory process or checkout.

On a graph/source query:

1. resolve the selected bundle from control state;
2. read and validate its manifest;
3. download the source archive and graph into ephemeral instance storage;
4. verify byte counts and SHA-256 checksums;
5. extract source/Git context;
6. place `graph.db.zst` at the upstream bootstrap location;
7. invoke Codebase Memory against an instance-local cache;
8. serve the query through the upstream public CLI contract;
9. sanitize internal project names/paths from output.

Concurrent requests for the same bundle in one warm instance share one hydration promise. A small idle LRU-style cache bounds warm-instance reuse; scale-to-zero may discard it at any time without data loss.

## Parity Engine model

Durable conceptual primitives remain:

- **Source** — where an observation came from.
- **Observation** — a directly observed technical value/entity/structure.
- **Evidence** — support for an observation/resolution. (The current implementation still carries resolution evidence inline; first-class evidence records remain a model-hardening follow-up.)
- **Resolution** — a relationship between observations.
- **Revision** — source-specific revision or observation point.

Resolution states:

- `resolved`
- `candidate`
- `unresolved`

Repository analysis occurs at index time and is stored with the Revision Bundle. Runtime HTTP observations occur only when requested and are combined with the selected repository observation set without treating runtime as authority.

A runtime/combined scan advances the project's latest Parity pointer only while its `repositoryRevision` still matches the selected repository SHA. This prevents a slow observation against an old revision from becoming the current Parity view after a newer bundle is promoted.

Generic analyzers currently include TypeScript/JavaScript/JSX/TSX, JSON, Markdown/MDX, HTML, and read-only runtime HTTP HTML/JSON. Analyzer selection is based on technical evidence only. Cross-source similarity remains a candidate rather than a fact. Naming divergence is derived only after a relationship is resolved.

## Storage/control ownership

Production adapters:

- **Google Cloud Storage** — private immutable bundle/scans, written create-only.
- **Firestore** — project selected-bundle pointer, exact-SHA index claim/status, and parity latest/recent pointers. Claim/transition/promotion operations that establish current truth use transactions.
- **Cloud Run service** — MCP/API query surface; minimum instances may be zero.
- **Cloud Run Job** — indexing execution using the same container image with `src/indexJob.ts` as entrypoint.

Filesystem artifact/control adapters exist for local development/tests only. Production fails closed when the Cloud Storage artifact backend is absent.

## Project registry

The current registry is operator-controlled access configuration. It defines repository/ref access and optional runtime origins/headers; it does not define product semantics.

The storage/control architecture does not depend on this registry format. GitHub App installation-token onboarding can replace static Git credentials through the Git-auth seam without changing bundle, query, or Parity contracts.

## Runtime observation boundary

Runtime URLs must use an operator-allowlisted HTTP(S) origin. Every redirect is revalidated. Authenticated redirects must remain on the original origin. Requests are GET-only and bounded by timeout/response-size limits. Runtime credentials come only from server-side environment-backed headers and are never persisted as observations.

## MCP transport

HTTP supports stateless modern MCP revision `2026-07-28`, including discovery, routing-header validation, complete results, private cache hints, and per-tool safety annotations. A limited initialize-era compatibility path remains.

The service itself does not require MCP sessions.

Authentication transport remains intentionally separable from product semantics. Current bearer/proxy modes remain supported while the dedicated OAuth protected-resource boundary is implemented as a separate security candidate.
