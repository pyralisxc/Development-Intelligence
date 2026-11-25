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

| Record | What it carries | How to read it |
| --- | --- | --- |
| Subject or occurrence | Stable ID, kind, source and locator, value, optional distinct source text, evidence IDs and producer contributions | One identifiable thing in the selected source state; compiler and indexer contributions enrich that same subject. |
| Relationship | ID, direction and endpoints, kind, analysis strategy, status, optional confidence and evidence | A typed connection supported at the stated certainty. An unresolved endpoint may be absent; an established source relationship does not by itself prove runtime execution. |
| Derived context | Existing subject and relationship IDs, their roles and supporting relationship IDs | A navigable selection derived from the graph, not separately stored semantic meaning. |

### Stable entities

Nodes belong to three layers:

- **semantic** — durable current-reality concepts such as surfaces, capabilities, actions, features/owners, routes/APIs, MCP tools, tools/workbenches, and providers;
- **structural** — files, symbols, imports, exports, calls, and other code structure;
- **representation** — UI elements, HTTP calls, navigation, configuration fields, runtime representations, and other observable presentations.

Semantic identity uses explicit stable IDs. Structural identity follows language semantics where DI can prove them: line movement does not create a new symbol, overload declarations coalesce into one symbol, and distinct same-name declarations remain distinct. Source locations remain provenance.

### Consolidated subjects and derived context

Each node identifies one subject or occurrence. Its name, typed value, source locator, producer contributions and evidence links describe that same subject; a source occurrence is not collapsed into its declaration. `raw` is present when it preserves distinct source text and may be absent when it would only repeat the name and value. Consumers use the name/value for that case. SCIP definitions produced on the selected checkout enrich matched declaration nodes with their producer, symbol and exact locator; references and unresolved definitions remain separate graph facts.

TypeScript call occurrences retain both their source start and end. Nested calls can share a start, so both coordinates identify the occurrence when the compiler and cross-file producers bind it to a declaration. A shared question projection can expose the resulting call sites in written source order with their existing relationship IDs; source order alone is not an execution sequence, especially across arguments, branches and loops.

PowerShell and Bash use tree-sitter grammars to contribute function declarations and written command and variable occurrences to the same graph. Occurrences belong to their lexical owner; dynamic targets remain unidentified. These syntax facts do not establish variable binding or values, command binding, argument values, conditions or execution. An operator may also supply a bounded Joern slice during a local graph build; source-matched candidate flows and explicit partial provider coverage then accompany the graph into retrieval. Where a verified Joern occurrence lies within a compiler-derived source-expression span, a lexical containment relationship connects it to that existing source fact and its owning subject; this link does not establish that the reported flow occurred. Joern is not run automatically by this option.

Related context is derived from the selected graph's existing subjects and relationships at retrieval time; it is not saved as additional node knowledge. The derived memberships identify the subject, roles and supporting relationship IDs. Structural components and direct callers and dependencies remain navigable without transitively absorbing unrelated workflows. Literal callbacks and their direct dependencies remain available in their lexical context without claiming invocation. Candidate relationships remain visibly candidate in their memberships and source paths; same-name facts do not become deployment bindings. A process-local cache may reuse the derived view for the lifetime of an immutable graph.

Ordinary question filtering returns derived context (the existing `families` response field) and paged members alongside the underlying graph records. Broad matches are presented as pageable paths between selected subjects rather than one transitive component. Recorded intermediate occurrences and relationship IDs preserve each path, including explicitly candidate handoffs; shared dependencies alone do not merge workflows. A subject can appear in multiple paths. Source and written-test subjects remain separate while retaining their cross-source relationships in family details; explicit test questions rank test sources first. Answers include matched source-expression lines and their conditions where the subject and source together match the question, while retaining complete expressions and other facts in graph details. Language-aware word forms help match identifiers, and the answer includes the applicable source analyzer’s stated precision so analyzed files are not mistaken for complete behavioral relationships. Membership helps select connected context; its relationships, source facts and conditions establish what the group actually does. The Workbench inspector presents a subject's memberships and members, allows selecting relationship evidence, and exposes graph source/coverage beside the graph. CLI, MCP and Workbench read the same graph contract.

Broad selection counts inflection alternatives as one question concept, distinguishes matches in subject names from mentions elsewhere, and exposes those ranking signals with the path. For equally strong name matches, existing connected paths precede isolated subjects; a candidate connection remains a candidate, and all selected paths remain pageable. Presentation may group direct sibling paths sharing the same target, relationship kind and status without merging their identities. Directly matching call excerpts are prioritized, while matching conditions and effects remain visible and the full source facts remain in investigation details.

When a question has at least two term groups and any subject matches two or more, the broad term filter currently selects only those stronger matches. It reports the number of weaker lexical matches excluded from that selection; they are not evidence that excluded subjects are irrelevant. A different scope or question can inspect them.

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

TypeScript/JavaScript call expressions are graph occurrences with source offsets and evidence. `calls-site` connects a callable to a call occurrence; it establishes the syntax, not a particular target declaration or runtime execution. Compiler and module binding may connect the occurrence to a directly identified declaration; a lexical parameter instead remains a distinct parameter node. Where the called declaration and positional handoff are established, argument occurrences connect to their formal parameters, and identifier arguments may reference their lexical declarations. These links describe source binding and argument positions, not guaranteed runtime values or dispatch. Unbound property, external, optional, spread, and dynamic cases remain visible without inventing a target.

DI's supported TypeScript/JavaScript source-control interpreter is a **single bounded parser rule**, shared by graph construction and historical source-only projections. During the source analyzer's existing AST pass it compiles source-located guards and effects into **the same revision-bound W graph**: `source-control-summary`, `source-condition` and `source-effect` nodes, with `has-source-control`, `has-condition`, `has-effect` and `requires-condition` relationships. Each supported condition/effect has an independent source occurrence identity (including offset) and source evidence. Effect values retain **which guard is required and whether its true or false branch is required**. These are not separate answer cards, a second graph, or persisted source-analysis authority outside W.

The summary states the interpreter's source file hash, observed branch/effect population, unmodeled syntax and bounded/exhaustive status **within the supported statement subset**. Function and callback bodies have distinct ownership. The graph's source syntax may prove that a conditional branch, return, throw, call or assignment is written and where it is located; it does **not** prove that a guard is satisfied, that all possible paths were modeled, that the call or effect executed, or that a provider or database changed. `resolved` edges for these facts are *not* realization/execution proof. Unsupported loops, switches and exception/finally constructs remain explicit scope limitations rather than fabricated absence.

Conditional expressions in supported statement expressions contribute their predicate and true/false requirements for nested call occurrences. Nested functions retain their own ownership. Short-circuit and optional evaluation can add unmodeled requirements; such call facts retain that control context and mark their requirements incomplete. This does not establish that argument evaluation completes or a call executes.

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

Negative/exhaustive answers must not collapse “nothing found” with “DI could not fully inspect this scope.” Coverage is evaluated at the claim scope. Positive proof can cite the exact covered source paths that support it; a repository-wide absence claim requires exhaustive tracked-source coverage. `unsupported`, `partial`, `skipped`, `failed`, or unavailable sources therefore block a definitive negative when they could contain contrary evidence. `check_graph_coverage` exposes detailed file-level status and reasons; its path-scope counts are computed before the optional status filter, while repository totals and proof summary are labeled separately. A scope with no matching files is distinct from a matching scope whose status filter returns no files. These descriptive counts do not change claim proof. Higher-level lenses carry compact coverage context.

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

### Local graph retrieval index

The retained graph remains the source of facts. A generation-bound SQLite index provides derived lookup keys and references to its records; it is not an independent source of nodes, relationships or evidence.

Naming differences are derived only where a written reference or binding resolves to its target. A container and its contents, a caller and callee, or an effect and its condition are distinct subjects; their different names are not a naming discrepancy. Original names and the supporting relationship remain available.

Build and reconcile graph facts first, then generate retrieval indexes before publishing that generation. Identify the index with the project, generation, graph ID, analyzer and source/topology/evidence fingerprints, and index format and producer versions. A working-tree graph retains its content identity and HEAD context; a committed graph retains its exact revision. The published generation and all of its indexes share the local catalog's named-target, retention, backup and restore lifecycle. An interrupted or incomplete index build must not replace the last usable target. Existing generations remain readable, and migration or regeneration must not silently change their graph identities.

Useful general access paths include: node, relationship and evidence identity; names, qualified names, source vocabulary and supported word forms; outgoing and incoming relationships by endpoint, kind and status; source locations and containment; evidence-to-record and record-to-evidence references; and family-to-member and member-to-family navigation with the existing roles and supporting relationship IDs. Kind, tags, producer and source coverage supply general filters and common insight areas including interaction points, calls, conditions, effects, dependencies and unresolved relationships. An index can contain a node in multiple families; a view selected through it is not a separate graph or a new truth authority. Family generation preserves the existing callback, candidate and direct-dependency semantics.

Shared graph operations should obtain candidates, follow indexed endpoints, fetch actual records and evidence, apply constraints and produce investigation selections without first materializing the entire graph. Questions, inspection, audit, comparison and visualization should use these operations rather than separate question-specific paths. Ordering, pagination, unresolved/candidate status, direction, negation and graph coverage must survive selection. Missing records in a partial view are not evidence of absence; negative and exhaustive operations need the relevant comparison universe and relationship coverage from the full selected graph.

Each generated index should expose its own graph identity and build status, entry and source-record counts, relevant missing or duplicate references, producer/format identity, duration and size. Audit index structural consistency against graph records, while reporting source/relationship coverage and answer usefulness independently. Counts alone do not establish quality: inspect real questions, alternate word forms, connected callbacks, negative questions, evidence and retained revision comparisons against the graph and source. Report which operations and graph areas were examined rather than a single quality score. Index corruption, missing artifacts and version mismatches must be distinguishable from graph coverage gaps, and repair must regenerate derived access structures without manufacturing facts or overwriting another generation.

Compiler and SCIP output contribute graph facts; winkNLP interprets language; Graphology supports the browser graph. The local index supplies IDs, endpoints, text candidates, family memberships and record locations. A single ordinary question can use these to select subjects and their connected paths before reading the complete records; broad selections and operations that require the full graph use the retained graph instead. The strategy does not limit answer size. Not every retrieval entrance is selective yet, and indexed candidates must remain consistent with graph-filter matching. Hosted revision-bound query artifacts remain separate from the local store.

The local lifecycle stores each retained graph generation in a manifest plus size-bounded JSON parts for nodes, edges and evidence. The derived index is built before publication and follows that generation through retention, backup and restore. Full reads verify and materialize the JSON parts; indexed reads locate selected records within them. Older generations without a compatible index remain readable through the full-graph path. Local generation selection, history and retention remain independent of hosted query artifacts.

The hosted query generation retains the graph's source descriptors, unavailable source IDs and detailed source and relationship coverage alongside its retrieval index. The Workbench source entrance and coverage checks use one metadata reader for local and hosted generations, without materializing all graph records. The records remain owned by the graph; the index copy is rebuilt with its generation. Older query artifact formats are treated as stale and require regeneration.

Exact node and relationship evidence reads use generation-bound record lookups locally. Hosted artifact reads obtain the matching records, follow relationship boundary buckets to both endpoints, and collect their evidence before constructing the same investigation selection. Name resolution and selections that cannot be established from the retained index continue through the ordinary graph path.

Older canonical records may bundle a historical accepted graph with the source graph. The current loader retains the historical shard references without reading them into source understanding; an unavailable historical shard does not prevent the source graph from loading. On a later graph publication those references remain attached, so the historical data can be recovered when its storage is available. Current source shards still require identity and integrity validation.

## Exact revision context

Each project/ref operation resolves an allowlisted Git ref once to one immutable SHA. That revision context is carried through checkout, cache identity, graph construction, source search/snippets, and returned metadata. Source fingerprinting passes working bytes through Git's configured content filters so the same tracked content has one portable identity across Windows, Linux, local worktrees, and CI.

DI fetches that exact SHA into disposable compute and verifies `FETCH_HEAD`. A moving branch may cause explicit failure/retry; it must never silently substitute a different revision midway through one operation.

Ref-to-ref change analysis rebuilds both revisions with the same current analyzer.

## Canonical W and runtime snapshots

Canonical project/ref queries always address source-derived W. Canonical `repo-…` graph identifiers carry the complete immutable Git SHA plus analyzer/source identity and are reconstructible from Git after process-local cache loss. Process memory accelerates canonical reads but is not their owner.

The Vercel Preview runtime retains its own disposable, revision-bound replay and cannot publish canonical or accepted authority. The replay is scoped to the authorized project binding, repository, exact revision, analyzer and deployed engine revision. A cold process can load and validate that graph; on a miss it builds and publishes graph parts before the manifest. Failed producer builds are not retained as complete replays. This keeps Preview's analyzer and graph format from changing Main's stored state. Canonical and Preview graph populations are persisted as independently stored shards, so a large graph does not depend on a single graph-wide JSON value. Preview publishes its own revision-scoped selective query pointer rather than reading Main's pointer. Preview replay retention and removal are not yet managed by the local graph retention settings.

The existing graph worker entrypoint executes local Workbench builds, Preview replay builds and canonical reconciliation. Each task uses the shared source graph builder and publishes to its environment's existing store; the worker returns the saved generation identity rather than transferring a graph-sized result. A bound Preview task retains its server-resolved project scope and asks the parent operation to recheck current authorization throughout the build. The Workbench opens a saved generation using its source metadata rather than materializing every graph record merely to render the workspace shell. A worker thread still has the lifetime of its hosting process: this handoff by itself does not provide a durable background queue or make serverless requests unbounded.

The candidate producer sequence creates a disposable snapshot for both working and committed source, then materializes npm-lockfile dependencies with the same pinned npm and linux/x64 target before running the compiler and SCIP. Install scripts are not run; producer coverage records the lockfile digest and preparation. Projects with a package manifest but no npm lockfile report that dependency preparation is partial. An npm cache under the configured scratch root is disposable and separated by project binding. The account Workbench can run this shared sequence in a Vercel Sandbox with a mounted Drive, separate from the legacy function-based graph path. Actual capacity and producer coverage depend on the selected Sandbox resources and repository; a successful build does not establish capacity for all repositories.

The derived query index is serialized and compressed incrementally, written in bounded storage parts, and published by a manifest after its parts. Each part and the complete compressed artifact retain integrity checks. Source-level substring filters select possible graph-detail buckets without persisting a second graph-wide copy of searchable text. A filter can include extra buckets; matching and evidence still come from graph records. Short or broad queries can select many buckets, and general Workbench investigations do not yet use these hosted artifacts. An explicit scan can rebuild an older derived index from its saved source graph without changing that graph's identity. Graph construction and broad/full reads still need memory proportional to the graph; multipart storage alone does not make those operations scale independently of repository size.

When a saved canonical or Preview graph references a current query generation, both use the same pointer-recovery sequence: if the discovery pointer is missing or stale, DI verifies the referenced index and restores its pointer without rebuilding the graph or index. Preview recovery stays in the revision-bound Preview namespace. An outdated or absent Preview query generation is rebuilt from the retained graph, then its reference is conditionally published in the graph manifest; graph shards are not copied. Concurrent index builders reserve separate slots, and a losing manifest update uses the published winner. Blob conditional writes use provider ETags; file-backed conditional writes use SQLite's process-safe locking for the compare-and-replace operation.

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
  Its default source-file, source-byte, and binding budgets no longer impose the former 1,600-file, 12 MiB, and 3,000-binding cutoffs. Explicit budgets supplied to the lens remain meaningful, and producer coverage reports partial work. The compiler lens supplements the syntax graph; its presence does not by itself establish exhaustive or runtime behavior.
- UI/HTTP/navigation/MCP representation evidence;
- source search and exact-revision snippets.

Textual symbol queries never silently choose between multiple substantive identities. Ambiguous queries return candidates so callers can retry with an exact node ID.

Go source uses the pinned ast-grep/tree-sitter Go grammar in the same shared parser registry. DI records package, type, callable and import identities, lexical containment, written conditions, and individually located invocation-shaped expressions. A Go call expression can also be a type conversion, so its call-site relationship is a candidate. Same-package names and a method's lexical receiver can connect those occurrences to candidate declarations; shadowing, build constraints, conversion and dispatch remain unbound until a qualified producer establishes them. Parser completeness is source coverage, not complete call or control-flow coverage. Qualified names and explicit source scope bind subjects through the same filter in the Workbench, MCP and local CLI.

C#, Java, and Python use pinned ast-grep/tree-sitter parser packages behind one declarative analyzer boundary. They currently provide:

- stable file-relative declaration identities that do not depend on line number;
- namespace/package, type, callable, property, and field structure where the language exposes it;
- overload-aware callable identity;
- lexical containment between declarations;
- explicit `partial` coverage when a parser recovers through syntax-error nodes.

This syntax-derived structure remains structural, not semantic. C#, Java, and Python resolve supported local module/file imports and exact imported symbols, but do not claim general cross-file call binding. Python source analysis now also recognizes direct module-scope simple or initialized annotated assignments as source-declared names, enabling qualified `from .config import NAME` resolution without claiming runtime value or execution. Nested, conditional, destructured, chained, annotation-only, and ambiguous repeated assignments do not establish unique positive bindings. An exact tracked Python package may also resolve `from package import child` to a unique sibling `child.py` or `child/__init__.py` module node, provided the source package has one `__init__.py`, the child has one tracked module, and the package does not declare or reexport that name or define `__getattr__`. Colliding tracked paths, dynamic exports and missing files remain unresolved. This is structural module identity, never proof that Python runtime import or application execution succeeds. CSS contributes selectors, declarations, at-rules, custom properties, and nesting context without inferring which application component uses a selector. The analyzer does not infer product meaning from syntax or reinterpret compiled Java bytecode or Unity scenes/assets as source. Unsupported precision is reported through coverage rather than guessed. `get_graph_schema` returns the deployed source-analysis support matrix.

## Parity intelligence

Interaction parity compares two selected graph states without requiring a question or expectation contract. Concrete interaction subjects (including source-backed UI elements, event registrations, routes and tool registrations) retain their own identities and an `interaction-point` classification. An optional source/name filter selects interactions matching the filter themselves or reaching matching subjects and source facts through captured paths, including across files. The comparison follows captured directed execution, binding, condition, effect and state relationships for each paged interaction, returns revision-bound graph selections and distinguishes changed, added, removed, ambiguous, incomplete and matching captured paths. It does not equate a matching captured path with complete behavior or establish retirement intent. Candidate component-prop handoffs remain visible as unresolved possibilities until their instance context is established. The Workbench, `compare_interactions` MCP operation and `di-local parity` use the same graph comparison; existing expectation contracts remain an optional separate overlay.

The TypeScript analyzer captures JSX event attributes, property spreads and DOM event registrations as source occurrences, preserving their event and callback bindings. A lexical containment edge connects each captured JSX interaction to its owning callable; the family view can follow the existing interaction, handler, callback and call-site edges without treating lexical containment as runtime rendering. When a broad selection includes a UI element, its displayed path and graph selection also carry its recorded handler, inline callback, call occurrences and resolved targets; named target bodies remain separate subjects. The compiler contributes candidate spread-value and cross-component callback handoffs and source-bound reads of statically initialized values. The repository audit can also find callables with no resolved path from captured interaction roots. This is an investigation over the current graph, not proof that code is dead: uncaptured entry points, dynamic dispatch and incomplete source or relationship coverage remain relevant.


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

### Account and linked-computer workspace

The hosted Workbench verifies Clerk account sessions and keeps account-owned project, graph, computer and layout records in a distinct Redis namespace per deployment environment. A graph definition retains a name, source, build computer, storage computer, storage location, query service and snapshot policy as separate values. A graph generation retains its own source state and evidence. Account metadata is not a second graph authority.

An installed Linux or Windows computer links through Clerk device authorization and a one-use Workbench pairing code. The device keeps its refresh token and device credential in user-scoped storage (Windows DPAPI or owner-only files on Linux). The linked process polls its account's queue, claims work and uses the existing local graph worker and investigation routes. The Workbench can browse directories on the selected computer and list branches and repositories from the user's GitHub identity. Shared Clerk development credentials provide public GitHub listings; a custom GitHub OAuth connection is required for provider tokens and private repositories.

Build and investigation results are stored separately from queue state; work claims have leases and account-specific credentials. The account remains visible when a computer is offline. The account Workbench places the selected graph investigation in its center, keeps questions in a dock, and exposes revision-bound source files and inspection in a side panel. Source files use the graph revision or require the working-tree fingerprint to match; the account layout retains panel order and dimensions. A linked query service can read the selected retained graph at a separately configured path without cloning its Git source or rebuilding it; the path must expose the graph store to that service. A shared-folder handoff stages a built generation and publishes it into the selected storage location. For a linked-computer build stored on hosted Drive, a claim-scoped Sandbox receives the existing generation over streaming HTTPS, verifies its files, and publishes through the same local graph import. Account Drive writes are coordinated with hosted builds. Interrupted direct transfers retain a staged build for retry; successful imports remove the staging copy. The candidate account Workbench also offers Vercel Sandbox execution and account- and environment-scoped Drive storage. A query uses a read-only snapshot of the same retained graph in a separate Sandbox. Cross-computer shared-folder handoff still requires end-to-end acceptance. Hosted-to-computer transfer and automatically making a remotely stored graph available to a different query service remain unimplemented. The legacy single-owner HTTP/MCP modes remain separate from the account Workbench; account-backed MCP and synchronized client layouts across the graph view remain future work.

DI supports bearer, trusted-proxy, private owner-session, native single-owner OAuth, and explicit local unauthenticated modes. Authentication remains an HTTP/deployment boundary over the graph engine; ChatGPT-specific behavior must not become graph semantics.


### Investigation selections

An investigation binds an operation to an exact graph identity and source state, then selects graph nodes and relationships. Question filters, inspection, trace, parity and audit retain their own result semantics while exposing the selected records and their attached evidence, coverage and page or scope. The selection is an ephemeral projection, not a graph store or an additional fact authority. Relationship endpoints are included as context; focus identifies the records selected by the operation. Missing expectations remain in parity results without creating graph entities.

A comparison has separate selections for its base and head graphs. Its page determines which change records are selected on each side; a moved or changed record is taken from the corresponding source state. Workbench graph following, node and edge inspection, and subsequent questions use the selection's graph identity. The graph renderer displays those records rather than re-running a different search; switching back to context is explicit. Unresolved and candidate relationships retain their status. Building and animating graphs are separate from this investigation sequence.

Interaction parity can return a summary without embedding every connected graph selection. The Workbench loads the changed facts or a selected side on demand, bound to the exact graph identities from the summary. Account investigations transfer their result in bounded parts when necessary; these parts carry the same selected graph records and evidence and are not another graph authority.
