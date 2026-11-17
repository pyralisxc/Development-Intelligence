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

Git/source owns implementation truth. DI produces rebuildable technical and semantic projections of exact Git revisions or of a fingerprinted local working state. Local working graphs include current non-ignored files and record HEAD as context, not as a claim that those files equal the commit. Historical evidence remains bound to its own exact Git revision.

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

Relationship certainty and claim proof are deliberately separate. `resolved` means DI proved that graph relationship under its relationship rule; it does not mean the edge is admissible for every downstream claim. Assessment proof applies a declared purpose (`existence`, `realization`, `contract`, or `audit`). Realization/contract proof rejects structural declaration, containment, import/re-export, resolution, and naming-correlation edges even when those edges are themselves resolved. Candidate relationships remain hypotheses for follow-up inspection and never become findings or proof merely because they are nearby.

### Canonical source-control facts

DI's supported TypeScript/JavaScript source-control interpreter is a **single bounded parser rule**, shared by graph construction and historical source-only projections. During the source analyzer's existing AST pass it compiles source-located guards and effects into **the same revision-bound W graph**: `source-control-summary`, `source-condition` and `source-effect` nodes, with `has-source-control`, `has-condition`, `has-effect` and `requires-condition` relationships. Each supported condition/effect has an independent source occurrence identity (including offset) and source evidence. Effect values retain **which guard is required and whether its true or false branch is required**. These are not separate answer cards, a second graph, or persisted source-analysis authority outside W.

The summary states the interpreter's source file hash, observed branch/effect population, unmodeled syntax and bounded/exhaustive status **within the supported statement subset**. Function and callback bodies have distinct ownership. The graph's source syntax may prove that a conditional branch, return, throw, call or assignment is written and where it is located; it does **not** prove that a guard is satisfied, that all possible paths were modeled, that the call or effect executed, or that a provider or database changed. `resolved` edges for these facts are *not* realization/execution proof. Unsupported loops, switches and exception/finally constructs remain explicit scope limitations rather than fabricated absence.

Ordinary questions use one language-to-graph filter. Wink NLP extracts terms and preserves negative wording; graph names, source facts and relationships determine the selected subjects and their neighborhoods. Conditions and effects retain their exact source expressions and linked requirements. Clients can refine scope, node kinds, relationship kinds, status and direction, and page through the selected population. A negative phrase remains visible in the interpretation; it is not turned into an unsupported claim that a relationship is absent. Explicit technical-source queries and caller-owned realization expectations remain separate source/assessment capabilities.

`investigate`, ordinary `query_intelligence`, and the Workbench use that same filter. Language terms bind to the graph's relationship vocabulary; the selected subject and sentence order determine inbound or outbound navigation, with explicit direction available as an override. `offset` and `limit` page the subjects, nodes and relationships; `sourceFamilies` groups the selected page's condition and effect occurrences by their owning subject, including source requirements and the analyzer's coverage summary. Optional `conditionContains`, `conditionTruth` and `effectKinds` filter those facts. Wording-matched facts are identified separately, without dropping the rest of the family.

Negative relationship selection requires `comparisonIds`, `comparisonScope`, or `comparisonKinds` to establish the finite comparison set. Each member is classified as related, candidate, unknown, or not related. An absent edge is classified as not related only when graph `relationshipCoverage` explicitly establishes completeness for that relationship, subject, direction and target; current analyzers do not yet provide that general completeness. The optional `scope`, `nodeKinds`, `relationshipKinds`, `statuses`, and `direction` parameters refine the same graph selection. The filter defaults to a one-hop neighborhood; `depth` requests broader traversal over the same relationship filters. Bidirectional traversal also returns relationships among the selected neighbors. Multi-hop negative results remain unknown unless an appropriate completeness contract is available.

### Coverage

Coverage is part of the truth model. Eligible sources are described as:

- `complete`;
- `partial`;
- `unsupported`;
- `skipped`;
- `failed`.

Negative/exhaustive answers must not collapse “nothing found” with “DI could not fully inspect this scope.” Coverage is evaluated at the claim scope. Positive proof can cite the exact covered source paths that support it; a repository-wide absence claim requires exhaustive tracked-source coverage. `unsupported`, `partial`, `skipped`, `failed`, or unavailable sources therefore block a definitive negative when they could contain contrary evidence. `check_graph_coverage` exposes detailed file-level status and reasons; higher-level lenses carry compact coverage context.

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

## Source graph lifecycle

Current understanding is reconstructed from one selected source graph: an exact Git revision or explicitly fingerprinted local working files. Source-derived facts retain their evidence and applicable conditions; no separate semantic approval history is required. Committed source states and local working files can be compared directly, including the retained Main, Preview and working targets.

Canonical persistence may retain a reconstructable source graph and query artifacts for access. Existing historical review records remain stored but do not determine current source understanding. Source observations, provider observations and caller-owned expectations remain distinguishable. The old checkpoint format remains available only for explicit compatibility and migration work.

Older canonical records may bundle a historical accepted graph with the source graph. The current loader retains the historical shard references without reading them into source understanding; an unavailable historical shard does not prevent the source graph from loading. On a later graph publication those references remain attached, so the historical data can be recovered when its storage is available. Current source shards still require identity and integrity validation.

## Exact revision context

Each project/ref operation resolves an allowlisted Git ref once to one immutable SHA. That revision context is carried through checkout, cache identity, graph construction, source search/snippets, and returned metadata. Source fingerprinting passes working bytes through Git's configured content filters so the same tracked content has one portable identity across Windows, Linux, local worktrees, and CI.

DI fetches that exact SHA into disposable compute and verifies `FETCH_HEAD`. A moving branch may cause explicit failure/retry; it must never silently substitute a different revision midway through one operation.

Ref-to-ref change analysis rebuilds both revisions with the same current analyzer.

## Canonical W and runtime snapshots

Canonical project/ref queries always address source-derived W. Canonical `repo-…` graph identifiers carry the complete immutable Git SHA plus analyzer/source identity and are reconstructible from Git after process-local cache loss. Process memory accelerates canonical reads but is not their owner.

The Vercel Preview runtime builds its own revision-bound replay and cannot publish canonical or accepted authority. This keeps Preview's analyzer and graph format from changing Main's stored state. Canonical graph populations are persisted as independently stored shards with a manifest published after the shards, so a large graph does not depend on a single graph-wide JSON value.

The derived query index is serialized and compressed incrementally, written in bounded storage parts, and published by a manifest after its parts. Each part and the complete compressed artifact retain integrity checks. An explicit scan can rebuild an older derived index from its saved source graph without changing that graph's identity. Current graph building and query-index reading still materialize large structures in memory; multipart storage alone does not make those operations scale independently of repository size.

If `scan_graph` is supplied runtime URLs, DI overlays bounded runtime evidence onto the same graph model and returns an explicit ephemeral `graphId`. Graph, source, parity, evidence, and Viewer tools may address that `graphId` directly.

Runtime snapshots are disposable and do not become the implicit “latest graph.” A previous agent's runtime scan must never change another agent's ordinary project/ref result.

If an ephemeral `snapshot-…` graph expires, callers recreate it; DI does not create a durable service database merely to preserve runtime observations.

## Code intelligence

The repository graph build runs `scip-typescript` against the selected clean
checkout when it contains JavaScript or TypeScript. Existing project
configurations are used together; where none exists, DI supplies a temporary
configuration outside the checkout. The producer does not install repository
dependencies or run repository build scripts. Its definitions, individual
reference occurrences and source-located relationships join the same graph as
DI's other source facts. A reference identifies a symbol; it does not by itself
assert a function call. A producer may add a declaration even when the native
analyzer did not create it first.

The graph records the producer version, index digest and reconciliation counts
in `producerCoverage`. Missing project dependencies, unsupported ranges,
external symbols and unreconciled occurrences limit relationship coverage even
when every source file was read. A producer failure is recorded on the graph;
it is not represented as an empty set of relationships. New revisions rebuild
producer facts rather than carrying relationships forward from an older index.
Source RPC occurrences are also connected to same-named tracked SQL routine
declarations as candidate relationships. Each migration and overload stays
distinct; a source name match does not select a deployed database routine.

The `scip-evidence` command also accepts a separately generated index and an
optional `--scip-project-prefix` for a producer rooted in a subproject. Its
source-located facts are returned as a disposable projection. Because that
index was not generated by DI during the selected checkout, its relationships
remain candidates unless independently corroborated by the TypeScript checker.
For producers with unspecified position encoding, the local caller can supply
`--scip-legacy-position-encoding utf16`; the choice is recorded with the index.

TypeScript/JavaScript analysis currently provides:

- stable language-aware symbol identities;
- file/symbol containment;
- static and dynamic imports;
- re-exports;
- import-to-definition resolution;
- provable cross-file calls;
- a bounded TypeScript compiler-signature lens that links existing file nodes to uniquely matched declaration nodes with compile-time `references-symbol` edges and exact callsite evidence, without adding competing symbol nodes or asserting runtime dispatch;
  Its real-source budget permits at most 1,600 tracked TypeScript/JavaScript roots and 12 MiB of source content, with a separately disclosed maximum of 3,000 source-proven binding observations. Beyond those budgets the compiler lens is bounded-out or partial, while the ordinary syntax graph remains available; no exhaustive or runtime conclusion follows from this optional frontend.
- UI/HTTP/navigation/MCP representation evidence;
- source search and exact-revision snippets.

Textual symbol queries never silently choose between multiple substantive identities. Ambiguous queries return candidates so callers can retry with an exact node ID.

C#, Java, and Python use pinned ast-grep/tree-sitter parser packages behind one declarative analyzer boundary. They currently provide:

- stable file-relative declaration identities that do not depend on line number;
- namespace/package, type, callable, property, and field structure where the language exposes it;
- overload-aware callable identity;
- lexical containment between declarations;
- explicit `partial` coverage when a parser recovers through syntax-error nodes.

This syntax-derived structure remains structural, not semantic. C#, Java, and Python resolve supported local module/file imports and exact imported symbols, but do not claim general cross-file call binding. Python source analysis now also recognizes direct module-scope simple or initialized annotated assignments as source-declared names, enabling qualified `from .config import NAME` resolution without claiming runtime value or execution. Nested, conditional, destructured, chained, annotation-only, and ambiguous repeated assignments do not establish unique positive bindings. An exact tracked Python package may also resolve `from package import child` to a unique sibling `child.py` or `child/__init__.py` module node, provided the source package has one `__init__.py`, the child has one tracked module, and the package does not declare or reexport that name or define `__getattr__`. Colliding tracked paths, dynamic exports and missing files remain unresolved. This is structural module identity, never proof that Python runtime import or application execution succeeds. CSS contributes selectors, declarations, at-rules, custom properties, and nesting context without inferring which application component uses a selector. The analyzer does not infer product meaning from syntax or reinterpret compiled Java bytecode or Unity scenes/assets as source. Unsupported precision is reported through coverage rather than guessed. `get_graph_schema` returns the deployed source-analysis support matrix.

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

Callers may supply an explicit bounded **Parity Contract** as expectation overlay E. E contains required or forbidden entity/relationship obligations and bounded selector-based reachability predicates evaluated against canonical W or an explicit snapshot. Reachability predicates select graph node sets by exact IDs, kinds, layers, or source IDs, then evaluate `any` or `all` traversal over caller-bounded relationship kinds, direction, and depth. The result distinguishes `satisfied`, `missing`, `forbidden-present`, `unproven`, and `not-applicable`; it returns resolved counterexample paths for violations, keeps candidate/unresolved paths tentative, refuses vacuous selector success, and does not treat absence as proven when source coverage is incomplete.

Predicate results also state their replacement boundary. A bounded resolved positive path, or a coverage-qualified exhaustive negative, may replace an equivalent source-only assertion after project-owner review. It does not replace runtime execution, browser interaction, concurrency, package-byte, provider, or rendered-artifact evidence. This classification belongs to the existing parity projection and exact-revision transition verifier rather than a second test or verification registry.

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
- `project_overview`
- `query_intelligence`
- `inspect_entity`
- `list_sources`
- `query_source`
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
- `analyze_impact`
- `query_parity`
- `evaluate_parity`

The Assessment Engine is a derived query layer over this graph, not a second authority. `query_intelligence` and the Workbench use the same engine to produce deterministic, revision/analyzer-bound claims, purpose-aware proof bundles, typed capability-realization paths, candidate hypotheses, and coverage/conflict/relationship/realization findings. Proof cites existing node, edge, and evidence identities and discloses both admissibility and claim-scope coverage. Assessments and caller-required facets are ephemeral and are not checkpointed. A required but unobserved facet is contradicted only when its repository-wide claim scope is exhaustively covered across tracked sources; incomplete, unsupported, skipped, failed, or unavailable coverage keeps the conclusion unproven or indeterminate.

Graph-consuming tools address canonical project/ref W, a reconstructible canonical `repo-…` graph ID, or an explicit ephemeral runtime `snapshot-…` graph ID where applicable. `search_graph` and `query_parity` also accept up to 20 independent `queries`, evaluated over one loaded graph.

`diff_graph` owns change intelligence:

- no `baseRef` → the default source state vs the selected source state;
- `baseRef` → two immutable revision selectors under the same current analyzer.

`analyze_impact` composes Git change truth with graph reach. It seeds from actual changed paths between two resolved revisions, maps those paths into both graphs, and traverses bounded dependency relationships. It does not infer that unchanged topology means unchanged implementation, and it reports unmapped paths/coverage rather than silently dropping unsupported evidence.

Authorized repository-history selectors are full commits, branches, tags, and explicit pull-request head/base/result identities. Resolution happens once before graph construction. PR result fails when the PR was not merged; Development Intelligence never silently replaces accepted history with an abandoned proposal.

Semantic diff equality uses stable semantic topology shape. Locator, source ID, timestamps, and evidence-reference movement are provenance/evidence changes rather than semantic changes. Evidence/analyzer drift is reported separately.

No provider-specific graph database query language or public cache-management tool is part of the contract.

## Runtime observation boundary

Runtime URLs must use operator-allowlisted HTTP(S) origins. Redirects are revalidated. Authenticated redirects remain on the originally requested origin. Requests are GET-only and bounded by timeout/size. Credentials come from server-side environment-backed headers and never enter accepted checkpoints.

A runtime URL is not proof that the inspected Git ref is deployed. Before fetching it, DI now requires an operator-authorized deployment-state source to report exactly one ready/active deployment whose full immutable Git SHA matches the selected revision and whose deployed origin matches an allowlisted runtime origin. A live GET then contributes a bounded, ephemeral response/deployment observation link. Unknown, mismatched, stale-branch, ambiguous, or unconfigured deployments yield no runtime observation; arbitrary Git branches are not privileged or forbidden by name. The provider report proves a deployment/source correspondence, not that any specific source function executed. URL query/fragment credentials and cross-origin redirects are rejected; HTML scripts/form values and untrusted JSON row data are sanitized before graph projection.

External technical-source data is sanitized before constructing normalized evidence, graph IDs or outward query results. Arbitrary provider row contents, nested secrets, request/response bodies, credentials and personal identifiers are not returned by default; the envelope reports redaction/truncation counts and retains bounded technical metadata only. Source discovery exposes provider origins rather than credential-bearing query/path details. Such observations remain ephemeral, never accepted graph truth.

The provider-neutral database-schema projection also represents schema-qualified tables, safe column types, reported RLS state, foreign-key relationships, migration versions and serverless function identity. Source correlations require an exact unique tracked migration version, function entrypoint, or unambiguous SQL table; matching migration version IDs is not proof of schema equivalence or runtime database writes. All provider metadata remains a sanitized ephemeral observation with explicit source, environment and time boundaries.

## Human visualization

`/graph` is a human client of the same graph contracts agents use. It accepts canonical project/ref context or an explicit runtime `graphId`.

The viewer has four lenses:

- **Architecture** — major owners/areas and dependencies;
- **Parity** — semantic entities and observed representations;
- **Code** — bounded implementation neighborhoods;
- **Change** — accepted/working or revision change projections for canonical source reality.

Search runs against the full selected graph; selection loads a bounded neighborhood. Candidate/unresolved relationships remain visually distinct, and both node and relationship evidence are inspectable. Sigma.js/Graphology are replaceable rendering/runtime-index helpers only.

Source selection has no default file-count or file-size cutoff; explicitly configured operator budgets still report omissions. Ordinary JSON extraction retains every scalar in its arrays and objects. npm lockfile extraction currently retains selected package versions and reports partial coverage. The TypeScript compiler producer retains its own declared budgets, and canonical builds and ordinary filtering still materialize the graph in memory. Large-repository scaling requires partitioned producer handoffs and indexed graph access; removing source cutoffs alone does not provide that architecture.

## Authentication boundary

### Account/network foundation (not yet exposed as a hosted sign-in product)

Account configuration is a separate owner from canonical graph/semantic authority. `AccountNetworkService` requires an explicit identity-verification callback; it does not interpret a deployment owner password, MCP read token, email address or client-supplied account ID as a durable account. Stable issuer/subject identity selects one versioned network document. The separate Blob metadata adapter uses conditional writes in `accounts/network-v1`, never the canonical graph namespace. Saving configuration cannot overwrite a concurrent save. Live identity/storage configuration and provider acceptance remain separate deployment gates.

Saved bindings begin requested. A trusted server catalog must verify the complete account/source/project/authority association before activation, and resolve it again for each operation. A locator/read token is not proof of authority ownership. Adoption references the original internal project and canonical backend; it does not rename/copy graphs, transfer publisher rights or claim an entire storage backend. Metadata stores references, not source/storage secrets. Hardware registration records a fresh node ID and public-key thumbprint, not possession proof or an issued execution grant; replacement cannot reuse a registered identity. Revocation does not revoke independent provider credentials.

Account-backed engine work runs in one frozen operation-local `ProjectAccessBinding`. The same scope controls registry resolution, secret lookup, runtime headers, exact canonical backend, graph/snapshot/credential caches, diagnostics and disposable checkout/askpass space. There is no fallback to ambient operator configuration inside a binding, including graphId reconstruction. Graph IDs remain evidence identities, not authorization tokens. Current session, binding version and catalog target are checked before access and before a result returns; adapters must await that result rather than stream protected data before the final check. No account-backed operation can publish canonical/accepted authority or spawn an unscoped canonical reconciliation worker.

The initial scoped source support is explicit HTTPS (plus server-resolved file fixtures/adoption); implicit host SSH/scp credentials and process-global GitHub App bindings are refused. Server-held environment-backed App/token grants remain scoped and App exchanges use the existing bounded read-only repository-token policy. No private keys or broad storage credentials are restored to replacement hardware by the network document.

The existing operator deployment remains supported outside this new scope. Account HTTP/OIDC login, Windows enrollment/credential custody, node execution grants, local control, management after app close/sign-out, public downloads and trusted updates are not delivered by these library contracts. Availability continues to follow actual dependencies; no offline snapshot/sync subsystem is introduced.

DI supports bearer, trusted-proxy, private owner-session, native single-owner OAuth, and explicit local unauthenticated modes. Authentication remains an HTTP/deployment boundary over the graph engine; ChatGPT-specific behavior must not become graph semantics.

