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
 semantic / structural /     resolved / candidate /      source + locator +
     representation               unresolved              revision + reason
              ▲                         ▲                         ▲
              └─────────────────────────┼─────────────────────────┘
                                        │
          ┌─────────────────────────────┼──────────────────────────────┐
          │                             │                              │
     Git/source analyzers       runtime/protocol evidence      future generic tools
          │                             │                        evidence providers
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

Development Intelligence owns one graph model. Code inspection, Architecture, Parity, Change, and human visualization are lenses over that graph; none is a second database or lifecycle engine.

## Authority and independence

Git/source owns implementation truth. DI produces rebuildable technical and semantic projections of exact Git revisions.

External tools may contribute evidence. They do not own DI identity, graph semantics, lifecycle, storage, query contracts, or product intent. No production analyzer may branch on project identity.

Development methodologies and skills may consume DI output, but DI neither requires nor implements Developer OS, Founder-to-Feature, Jarvis, or any other reasoning workflow.

Operational project configuration grants observation access only: repository, refs, credentials, runtime origins, and runtime headers. It must not define project semantics or source-authority hierarchies.

## Graph model

Schema v2 separates **identity**, **evidence**, **certainty**, and **coverage**.

### Stable entities

Nodes belong to three layers:

- **semantic** — durable current-reality concepts such as surfaces, capabilities, actions, features/owners, routes/APIs, MCP tools, tools/workbenches, and providers;
- **structural** — files, symbols, imports, exports, calls, and other code structure;
- **representation** — UI elements, HTTP calls, navigation, configuration fields, runtime representations, and other observable presentations.

Semantic identity uses explicit stable IDs. Structural identity follows language semantics where DI can prove them: line movement does not create a new symbol, overload declarations coalesce into one symbol, and distinct same-name declarations remain distinct. Source locations remain provenance.

### Evidence and conflicts

Evidence answers why DI believes an entity or relationship exists. It may carry source identity, locator, reason/kind, safe field/value, and observation context.

Independent evidence that agrees on one identity accumulates. If two sources assert the same semantic ID with contradictory substantive values, DI records an explicit conflict and marks the entity conflicted rather than silently choosing one claim and treating both sources as corroboration.

### Relationship certainty

Relationships retain kind, strategy, confidence, evidence references, and one of:

- `resolved` — DI has sufficient deterministic evidence for the relation;
- `candidate` — evidence suggests the relation but does not prove it;
- `unresolved` — DI observed a relationship question it could not resolve.

Certainty survives every lens. For example, a direct provider import may resolve an integration, while a provider hostname appearing in arbitrary source text remains a candidate.

### Coverage

Coverage is part of the truth model. Eligible sources are described as:

- `complete`;
- `partial`;
- `unsupported`;
- `skipped`;
- `failed`.

Negative/exhaustive answers must not collapse “nothing found” with “DI could not fully inspect this scope.” `check_graph_coverage` exposes detailed file-level status and reasons; higher-level lenses carry compact coverage context.

## Generic semantic declarations

Some current semantics cannot be proved reliably from syntax alone. Projects may optionally place source-adjacent declarations beside the implementation they describe:

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

- declarations describe current observable reality, never desired future state;
- IDs are stable semantic identities;
- declarations are optional;
- vocabulary remains project-owned/open;
- DI parses them generically without project-name special cases;
- declared relationships still carry source evidence.

Expectation/future data is caller reasoning and is not sealed as accepted current reality merely because it is planned.

## A / W / B lifecycle

The accepted checkpoint lives in the inspected repository under `/.development-intelligence/` and follows ordinary Git history.

- **A — accepted:** stable semantic topology already accepted with the project.
- **W — working:** the complete graph regenerated from one exact Git SHA. Canonical W is source-derived and disposable.
- **B — sealed candidate:** deterministic semantic topology generated for a candidate and committed with it.
- After normal Git merge, B becomes the new A; previous A remains in Git history.

DI does not maintain a central promotion pointer or durable graph-history database.

### Why A/B stores semantic topology only

Git already stores the source required to rebuild structural intelligence. Persisting all source-derived structural records would duplicate authority and create needless churn. A/B therefore persists the semantic topology needed for accepted-reality comparison while structural/code intelligence is regenerated from Git.

Runtime observations are never automatically sealed because they may not be reproducible from repository source.

## Checkpoint integrity and currentness

The checkpoint is deterministic sharded NDJSON:

1. `manifest.json`;
2. stable semantic node/relationship records;
3. deterministic hexadecimal shard assignment.

The manifest records:

- **source fingerprint** — tracked project content excluding `.development-intelligence/`;
- **topology fingerprint** — stable persisted semantic topology;
- **evidence fingerprint** — evidence/provenance attestation at seal time;
- **analyzer version** — observation model used to build the candidate.

Checkpoint validation recomputes topology from shard contents. The manifest is not trusted as a substitute for content integrity.

Currentness is dimensional:

- source currentness;
- topology currentness;
- evidence drift;
- analyzer drift;
- schema support;
- checkpoint integrity.

Accepted semantic A is current only when the checkpoint is valid/supported and its source/topology match canonical W. Evidence or analyzer changes are reported separately so harmless observation improvements do not manufacture semantic product drift.

## Exact revision context

Each project/ref operation resolves an allowlisted Git ref once to one immutable SHA. That revision context is carried through checkout, cache identity, graph construction, source search/snippets, and returned metadata.

DI fetches that exact SHA into disposable compute and verifies `FETCH_HEAD`. A moving branch may cause explicit failure/retry; it must never silently substitute a different revision midway through one operation.

Ref-to-ref change analysis rebuilds both revisions with the same current analyzer.

## Canonical W and runtime snapshots

Canonical project/ref queries always address source-derived W.

If `scan_graph` is supplied runtime URLs, DI overlays bounded runtime evidence onto the same graph model and returns an explicit ephemeral `graphId`. Graph, source, parity, evidence, and Viewer tools may address that `graphId` directly.

Runtime snapshots are disposable and do not become the implicit “latest graph.” A previous agent's runtime scan must never change another agent's ordinary project/ref result.

If an ephemeral snapshot expires, callers recreate it; DI does not create a durable service database merely to preserve runtime observations.

## Code intelligence

Generic TypeScript/JavaScript analysis currently provides:

- stable language-aware symbol identities;
- file/symbol containment;
- static and dynamic imports;
- re-exports;
- import-to-definition resolution;
- provable cross-file calls;
- UI/HTTP/navigation/MCP representation evidence;
- source search and exact-revision snippets.

Textual symbol queries never silently choose between multiple substantive identities. Ambiguous queries return candidates so callers can retry with an exact node ID.

Other languages may be added through generic analyzers later. Unsupported precision must be reported through coverage rather than guessed.

## Parity intelligence

Parity describes observed representations around semantic entities, for example:

```text
capability/action
   ├─ exposed-on → human surface
   ├─ implemented/owned-by → feature
   ├─ automated-by → MCP/agent tool
   ├─ connected-to → route/API
   └─ integrates-with → provider
```

Confirmed representation lists use resolved relationships only. Candidate and unresolved relationships remain visible separately.

Parity reports what is observed. It does not decide which representations ought to exist.

Callers may supply an explicit bounded **Parity Contract** as expectation overlay E. E contains required or forbidden entity/relationship obligations and is evaluated against canonical W or an explicit snapshot. The result distinguishes `satisfied`, `missing`, `forbidden-present`, and `unproven`; absence is not treated as proven when source coverage is incomplete.

E is caller intent, not a fourth persisted graph role. It is never written into A/W/B, stored as service authority, or automatically promoted into accepted topology. Product-resolution methods own why an expectation exists; DI owns deterministic evaluation against observed evidence.

There is no separate Parity scan lifecycle or database.

## Architecture intelligence

Architecture combines structural evidence with semantic owner/feature evidence. Proven feature dependencies/consumers and API/route/MCP/provider relationships are separated from candidate/unresolved relationships. Structural repository areas remain available for observations without semantic owners.

Project-specific architecture governance remains the inspected project's responsibility. DI observes architecture; it does not dictate each project's layering rules.

## Query and diff model

The permanent agent-facing tools are:

- `list_projects`
- `resolve_revision`
- `project_status`
- `scan_graph`
- `search_graph`
- `trace_path`
- `search_code`
- `get_code_snippet`
- `get_graph_schema`
- `get_architecture`
- `check_graph_coverage`
- `get_evidence`
- `diff_graph`
- `query_parity`
- `evaluate_parity`

Graph-consuming tools address either canonical project/ref W or an explicit runtime `graphId` where applicable.

`diff_graph` owns change intelligence:

- no `baseRef` → accepted semantic A vs canonical W;
- `baseRef` → two immutable revision selectors under the same current analyzer.

Authorized repository-history selectors are full commits, branches, tags, and explicit pull-request head/base/result identities. Resolution happens once before graph construction. PR result fails when the PR was not merged; Development Intelligence never silently replaces accepted history with an abandoned proposal.

Semantic diff equality uses stable semantic topology shape. Locator, source ID, timestamps, and evidence-reference movement are provenance/evidence changes rather than semantic changes. Evidence/analyzer drift is reported separately.

No provider-specific graph database query language or public cache-management tool is part of the contract.

## Runtime observation boundary

Runtime URLs must use operator-allowlisted HTTP(S) origins. Redirects are revalidated. Authenticated redirects remain on the originally requested origin. Requests are GET-only and bounded by timeout/size. Credentials come from server-side environment-backed headers and never enter accepted checkpoints.

## Human visualization

`/graph` is a human client of the same graph contracts agents use. It accepts canonical project/ref context or an explicit runtime `graphId`.

The viewer has four lenses:

- **Architecture** — major owners/areas and dependencies;
- **Parity** — semantic entities and observed representations;
- **Code** — bounded implementation neighborhoods;
- **Change** — accepted/working or revision change projections for canonical source reality.

Search runs against the full selected graph; selection loads a bounded neighborhood. Candidate/unresolved relationships remain visually distinct, and both node and relationship evidence are inspectable. Sigma.js/Graphology are replaceable rendering/runtime-index helpers only.

## Authentication boundary

DI supports bearer, trusted-proxy, private owner-session, native single-owner OAuth, and explicit local unauthenticated modes. Authentication remains an HTTP/deployment boundary over the graph engine; ChatGPT-specific behavior must not become graph semantics.
