# Testing

Run:

```bash
npm run verify
```

The permanent suite protects durable product/infrastructure contracts rather than historical filesystem shape.

## Durable contracts

### Selected-bundle atomicity

A failed, stale, incomplete, or superseded indexing execution cannot replace the selected last-known-good Revision Bundle.

### Exact-revision request ownership

An accepted index request is bound to the exact SHA observed when the mutable ref was resolved. Repeated queued/running requests for the same SHA deduplicate before provider dispatch. A worker that loses the active SHA claim cannot mark a newer request failed/succeeded and cannot promote its bundle.

### Immutable artifact creation

Every bundle generation has unique object keys. Production Cloud Storage uploads use create-only generation-match preconditions; local test/development storage also refuses to overwrite an existing artifact key.

### Portable artifact presence

A healthy Codebase Memory status is not sufficient for promotion. Indexing must also produce a non-empty portable `graph.db.zst` artifact.

### Stable bundle-scoped Codebase Memory identity

The explicit index that creates a portable graph artifact and every later hydration of that artifact use the same hidden Codebase Memory project identity derived from the immutable Revision Bundle. Process role (`index` versus `query`) never changes artifact identity.

### Bundle integrity

Revision Bundle artifacts carry byte counts and SHA-256 checksums. Query hydration fails closed before Codebase Memory consumes a source/graph artifact whose stored bytes do not match the manifest.

### Ephemeral runtime state

Public state and bundle manifests contain no retained worktree, local CBM project, cache path, or hydration directory. Query/index scratch state is disposable and reconstructible from durable artifacts/control state.

### Public identity

Internal Codebase Memory identities and ephemeral filesystem paths do not leak through normal project/status/query responses.

### Universal parity

An unknown project with no project-specific analyzer or semantic mapping can still produce useful technical observations and relationships from ordinary source/runtime structures.

Repository observations are produced at index time for an exact revision. Runtime observations remain timestamped, optional, and read-only. A runtime scan may become `latest` only while its repository revision still matches the selected SHA.

### Evidence discipline

Deterministic syntax relationships remain resolved; similarity relationships remain candidates; unresolved relationships remain unresolved. Naming divergence is not manufactured by normalization.

### Sensitive values

Secret-like structured JSON and TypeScript declaration values are redacted from persisted parity observations.

### Runtime credential isolation

Allowlisted runtime observation must not forward configured credentials across origins through redirects.

### Project identity isolation

Project identities that normalize to the same storage key are rejected during registry loading.

### Tool boundary

Development Intelligence exposes technical-intelligence tools and excludes development-methodology/workflow operations. Mutable runtime trace ingestion is excluded from the canonical immutable revision surface.

### MCP protocol

The HTTP acceptance test covers modern `2026-07-28` discovery, routing headers, complete results, cache hints, tool calls, and header mismatch rejection.

### MCP safety metadata

Read-only tools expose `readOnlyHint`; index requests/runtime parity scans and derived-state deletion expose accurate mutation/destructive annotations.

### Generic source boundary

`scripts/check-generic-boundary.mjs` prevents known project/workflow names from entering generic production source.

## Verification layers

Use focused unit/contract evidence while changing a boundary, then one full repository `npm run verify` candidate gate.

GitHub CI additionally installs the pinned upstream `codebase-memory-mcp@0.10.8` binary and runs `npm run smoke:cbm`. That smoke creates a real throwaway Git repository, performs an explicit full CBM index, verifies the portable `graph.db.zst` was captured in a Revision Bundle, hydrates that bundle into a clean ephemeral cache using the same bundle-scoped CBM identity, and resolves a known symbol from the hydrated graph.

The real-CBM smoke proves the upstream artifact boundary used by Development Intelligence. It does not claim to prove Google Cloud deployment, IAM, Firestore transaction behavior, or Cloud Storage preconditions; those still require provider-backed acceptance before production cutover.

## Temporary evidence

Benchmarks, one-off deployment probes, cold-start measurements, provider setup scripts, and migration-comparison harnesses are temporary by default. Promote only checks that protect a durable guarantee rather than freezing one implementation choice.
