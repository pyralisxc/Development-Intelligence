# Architecture

## System shape

```text
                            Development Intelligence
                                     │
                      one intrinsic evidence graph
                                     │
        ┌────────────────────────────┼───────────────────────────┐
        │                            │                           │
  source/Git analyzers        runtime/protocol evidence    future tools
        │                            │                     (evidence only)
        └────────────────────────────┼───────────────────────────┘
                                     │
                    Source → Observation → Relationship
                               + evidence/confidence
                                     │
             ┌───────────────────────┼──────────────────────┐
             │                       │                      │
        search / trace         parity / diff        architecture / viewer
```

Development Intelligence is the engine. “Code inspection” and “Parity” are capabilities/lenses, not independent graph owners.

## Authority and lifecycle

Git/source owns implementation truth. Development Intelligence produces rebuildable technical projections.

The accepted checkpoint is `/.development-intelligence/graph.ndjson` in the project being inspected.

- **A** — the checkpoint already accepted in the branch/revision being reasoned about.
- **W** — the working graph generated from the exact current source/ref. W may include ephemeral runtime evidence.
- **B** — a sealed deterministic repository checkpoint generated for a candidate and committed with that candidate.
- Git merge/history naturally turns B into A and retains previous A revisions.

Development Intelligence does not maintain a central graph-history database or promotion pointer.

## Checkpoint format

The current schema is record-oriented NDJSON:

1. one `meta` record containing schema version, source fingerprint, and summary;
2. stable `node` records sorted by ID;
3. stable `edge` records sorted by ID.

The fingerprint covers tracked project content but excludes the `.development-intelligence/` directory so graph generation does not create a self-referential hash/commit cycle.

Checkpoint records intentionally omit volatile observation timestamps and service-local paths. Runtime/provider observations are not automatically sealed because they may not be reproducible from repository source; they remain overlays unless a future explicit evidence contract says otherwise.

## Graph model

Durable primitives:

- **Source** — where evidence was observed.
- **Node/Observation** — a directly observed entity/value/structure.
- **Edge/Relationship** — a relationship between nodes.
- **Evidence** — why an observation/relationship exists.
- **Revision** — the source revision/observation point.

Relationship states:

- `resolved`
- `candidate`
- `unresolved`

Current generic analyzers understand TypeScript/JavaScript/JSX/TSX, JSON, Markdown/MDX, HTML, and read-only runtime HTTP HTML/JSON. File nodes and containment edges make source topology part of the same graph.

No analyzer behavior may branch on project identity.

## Source acquisition

For remote projects, DI resolves an allowlisted Git ref to an exact SHA, materializes a shallow checkout in disposable scratch space, verifies the fetched SHA, analyzes it, and deletes the checkout.

Local filesystem is therefore **compute**, not authority.

A future Vercel Sandbox may retain disposable warm working state for performance. Losing it must never lose accepted graph history or project truth.

## Query model

The service keeps a bounded in-process cache keyed by project + exact source SHA. It is acceleration only.

Queries operate on the canonical graph:

- text/kind/source/status search;
- relationship traversal;
- architecture projections;
- source search/snippets from the exact Git revision;
- A→W graph diff;
- parity filtering over cross-representation nodes/relationships.

No provider-specific database query language is part of the public contract.

## Runtime observation boundary

Runtime URLs must use an operator-allowlisted HTTP(S) origin. Every redirect is revalidated. Authenticated redirects remain on the original origin. Requests are GET-only and bounded by timeout/size. Credentials come from server-side environment-backed headers and never enter accepted graph checkpoints.

## Visualization

The `/graph` viewer is a bounded visual projection of the same canonical graph agents query. It must not maintain separate nodes, edges, identities, or lifecycle semantics.

## Tool boundary

External analyzers may be integrated later when they contribute useful evidence (for example language-precise symbol/reference data). They must adapt into DI Source/Node/Edge/Evidence primitives and may not become lifecycle/storage authorities.
