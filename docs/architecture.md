# Architecture

## System shape

```text
                               Development Intelligence
                                        │
                         one canonical intelligence graph
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
       stable entities            relationships             first-class evidence
      semantic/structural       resolved/candidate/        source + locator +
       /representation              unresolved              revision + reason
              ▲                         ▲                         ▲
              └─────────────────────────┼─────────────────────────┘
                                        │
          ┌─────────────────────────────┼──────────────────────────────┐
          │                             │                              │
     Git/source analyzers       runtime/protocol evidence      future generic tools
          │                             │                        (evidence providers)
          └─────────────────────────────┼──────────────────────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
             Code                  Architecture                 Parity
              │                         │                         │
              └─────────────────────────┼─────────────────────────┘
                                        │
                                   Change / Viewer
```

Development Intelligence is the intelligence owner. Code inspection, Architecture, Parity, Change, and visualization are lenses over the same graph; none is a separate database or lifecycle engine.

## Authority

Git/source owns implementation truth. Development Intelligence produces rebuildable technical and semantic projections of exact revisions.

Tools may contribute evidence. They do not own DI identity, graph semantics, lifecycle, storage, query contracts, or product intent.

No analyzer behavior may branch on project identity. Project-specific names, owners, capabilities, and topology must be discovered from source/evidence rather than encoded inside Development Intelligence.

## Graph model

Schema v2 separates **identity** from **evidence**.

### Stable entities

A graph node represents a technical or semantic entity rather than merely a line occurrence. Nodes belong to one of three layers:

- **semantic** — durable current-reality concepts such as surfaces, capabilities, actions, features/owners, routes/APIs, MCP tools, tools/workbenches, and providers;
- **structural** — code structure such as files, symbols, imports, exports, and call relationships;
- **representation** — observable presentations/values such as UI elements, HTTP calls, navigation, configuration fields, and runtime representations.

Structural symbol identity must not depend on line number. Moving a function through comment/whitespace churn may move its evidence locator without manufacturing a new conceptual symbol.

### Evidence

Evidence is first-class and answers why DI believes an entity or relationship exists. Evidence can carry:

- source identity;
- locator;
- observed reason/kind;
- field/value where safe;
- revision/observation context.

Source locators and line numbers are evidence/provenance, not universal semantic identity.

### Relationships

Relationships retain:

- kind;
- strategy;
- confidence when applicable;
- `resolved`, `candidate`, or `unresolved` status;
- evidence references.

A dependency/import is not silently promoted to runtime invocation. A naming similarity is not silently promoted to semantic equivalence. Unknown or ambiguous relationships remain explicit.

## Generic semantic declarations

Some current product semantics cannot be recovered reliably from syntax alone. Projects may optionally place small **source-adjacent Development Intelligence declarations** beside the implementation they describe.

The generic contract is conceptually:

```ts
{
  developmentIntelligence: {
    kind: 'capability',
    id: 'workspace.compare',
    label: 'Compare variants',
    relationships: [
      { kind: 'owned-by', to: 'feature:comparison' },
      { kind: 'exposed-on', to: 'surface:workspace' },
    ],
  },
}
```

Rules:

- declarations describe **current observable reality**, never roadmap/desired intent;
- IDs are stable semantic identities;
- declarations are optional;
- vocabulary remains project-owned/open rather than a centralized DI ontology;
- DI parses the contract generically and contains no project-name special cases;
- declared relationships still carry source evidence.

Expectation/future data (sometimes called **E**) is a caller overlay and must not be stored as accepted current reality merely because it is planned.

## A / W / B lifecycle

The accepted checkpoint lives in the inspected project under `/.development-intelligence/` and follows ordinary Git history.

- **A — accepted reality:** the stable semantic topology checkpoint already accepted on the revision/branch being reasoned about.
- **W — working reality:** the complete graph generated from the exact current ref, including structural, semantic, representation, and optional runtime evidence. W is disposable.
- **B — sealed candidate:** a deterministic stable semantic topology projection generated for the candidate and committed with it.
- after normal Git merge, B becomes the new A; previous A remains in Git history.

DI does not maintain a central promotion pointer or graph-history database.

### Why B is a projection, not the full working graph

Git already stores the source required to rebuild structural intelligence. Persisting tens of thousands of line-level/source-derived records would duplicate that authority and create unnecessary churn.

Therefore v2 checkpoints persist stable semantic/parity-significant topology while structural/code intelligence is regenerated from exact Git revisions when queried.

Ref-to-ref structural change analysis builds both revisions with the **same current analyzer**, preventing an old analyzer model from masquerading as a product change.

## Checkpoint format and fingerprints

The accepted projection remains deterministic sharded NDJSON:

1. `manifest.json`;
2. stable semantic node/relationship records;
3. deterministic hexadecimal shard assignment.

The v2 manifest distinguishes:

- **source fingerprint** — tracked project content excluding `.development-intelligence/` itself;
- **topology fingerprint** — stable accepted semantic topology;
- **evidence fingerprint** — supporting evidence/provenance;
- **analyzer version** — observation model used to construct the graph.

This lets DI distinguish “the project changed” from “the analyzer learned to observe the project differently.”

Runtime/provider observations are not automatically sealed because they may not be reproducible from repository source.

## Code intelligence

Generic TypeScript/JavaScript analysis currently provides:

- stable symbol identities;
- file/symbol containment;
- imports and re-exports;
- import-to-definition resolution;
- cross-file call relationships where module resolution and syntax can prove them;
- UI/HTTP/navigation/MCP representation evidence;
- source search and exact-revision snippets.

Textual symbol queries never silently choose between multiple substantive identities. Ambiguous queries return candidates so callers can retry with an exact node ID.

Other languages may be added through generic analyzers later; unsupported precision must be reported honestly rather than inferred.

## Parity intelligence

Parity asks how a stable semantic capability/action is represented across observable technical surfaces, for example:

```text
capability/action
   ├─ exposed-on → human surface
   ├─ implemented/owned-by → feature
   ├─ automated-by → MCP/agent tool
   ├─ connected-to → route/API
   └─ integrates-with → provider
```

Parity reports **what is observed**. It does not decide that every capability should have every representation. Optional expectation evidence may challenge current reality, but DI remains independently useful without it.

There is no separate Parity scan database.

## Architecture intelligence

Architecture combines generic structural evidence with stable semantic owner/feature evidence. Declared feature ownership is kept distinct from inferred repository grouping.

The architecture lens can report:

- feature/owner dependencies;
- consumers/fan-in and dependencies/fan-out;
- API/route/MCP/provider relationships;
- structural repository areas for evidence not represented semantically.

Project-specific architecture governance remains the inspected project's responsibility. DI observes architecture; it does not dictate each project's layering rules.

## Query and diff model

The service may keep a bounded in-process cache keyed by project + exact source SHA. It is disposable acceleration only.

Public intelligence operations include:

- full-graph text/kind/layer/status search;
- ambiguity-safe relationship traversal;
- exact-revision source search/snippets;
- evidence inspection;
- architecture projection;
- parity projection;
- accepted semantic A→W diff;
- ref-to-ref semantic/structural/representation diff using one analyzer version.

No provider-specific graph database query language is part of the public contract.

## Source acquisition

For remote projects, DI validates an allowlisted ref, resolves the exact Git SHA, materializes a disposable checkout, verifies the fetched revision, analyzes it, and deletes the checkout.

Local filesystem is **compute**, not durable authority.

A hosted runtime may retain disposable warm state for performance. Losing the host/cache must never lose accepted intelligence.

## Runtime observation boundary

Runtime URLs must use an operator-allowlisted HTTP(S) origin. Redirects are revalidated. Authenticated redirects remain on the original origin. Requests are GET-only and bounded by timeout/size. Credentials come from server-side environment-backed headers and never enter accepted checkpoints.

## Human visualization

`/graph` is a human lens over the same graph agents query. It does not maintain separate identities or lifecycle state.

The viewer has four product lenses:

- **Architecture** — major owners/areas and dependencies;
- **Parity** — semantic entities and their human/agent/API/provider representations;
- **Code** — bounded implementation neighborhoods;
- **Change** — accepted/working or revision change projections.

Search runs against the full graph; selection loads a bounded neighborhood rather than rendering an arbitrary first-N slice. The details panel exposes entity/relationship evidence. Sigma.js/Graphology are replaceable rendering/runtime-index tools only; they do not own canonical graph semantics.

## External-tool boundary

External analyzers may be integrated when they contribute valuable evidence, such as language-precise references or compiler semantics. They must adapt into DI entities/relationships/evidence and may not become graph, lifecycle, or storage authorities.
