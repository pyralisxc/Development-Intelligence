# Testing

Run:

```bash
npm run verify
```

Permanent evidence protects durable Development Intelligence contracts, not historical analyzer/provider implementation.

## Durable contracts

### One intrinsic graph

Code, Architecture, Parity, Change, evidence inspection, and the human Viewer operate on one graph model. Public tooling must not depend on a second external graph owner or separate Parity database.

### Git-owned A/W/B lifecycle

A/B persists deterministic semantic topology with the inspected project. W is regenerated from one exact Git revision. Source/topology currentness determines accepted semantic A; evidence/analyzer drift is reported separately rather than manufacturing semantic product changes.

### Exact revision acquisition

An allowlisted ref is resolved once per operation. Checkout, cache identity, graph generation, code search, and snippets remain bound to that exact SHA. Tests should detect regressions that accidentally re-resolve a mutable ref mid-operation.

### No durable service database

Remote analysis uses disposable exact-revision checkouts. Runtime graph snapshots and warm caches are disposable. Losing service-local files/caches must not lose accepted intelligence.

### Runtime snapshot isolation

Runtime observation produces an explicit ephemeral `graphId`. A runtime snapshot must be queryable when that ID is supplied and must never alter later ordinary project/ref queries.

### Deterministic and tamper-evident checkpoint

`/.development-intelligence/manifest.json` plus deterministic semantic NDJSON shards excludes its own directory from source fingerprinting. The same accepted topology produces byte-identical checkpoint files. Validation recomputes topology from shard contents, so same-count shard corruption is rejected rather than trusted because the manifest still looks valid.

### Stable identities and conflicts

Semantic IDs remain explicit and stable. Structural identities survive line/comment movement; TypeScript overload declarations coalesce into one language symbol while genuinely distinct same-name symbols remain distinct.

Multiple sources that agree on one semantic identity accumulate evidence. Contradictory claims remain an explicit conflict and the entity is visibly conflicted.

### Source provenance and safety

Tracked symlinks are never followed as source content. Repository/runtime credentials never enter graph output. Secret-like structured values are redacted.

### Coverage honesty

Eligible files have explicit `complete`, `partial`, `unsupported`, `skipped`, or `failed` states. Analyzer failure must not count as successfully analyzed coverage. Negative/exhaustive tools expose compact coverage context, and `check_graph_coverage` exposes the detailed file-level reason.

### Universal analysis

An unknown project with no project-specific semantic mapping can still produce useful file/symbol/UI/API/MCP/config/document observations and relationships. The generic source guard prevents known project/workflow nouns from entering production analyzers.

### Cross-file structural intelligence

For TypeScript/JavaScript, generic module resolution represents file imports, dynamic `import()` dependencies, import bindings, re-exports, import-to-definition resolution, and provable cross-file calls. Representative CardForge benchmarking must demonstrate known cross-file consumers rather than relying only on large node counts.

### Evidence discipline and uncertainty

Syntax/protocol relationships may be resolved when deterministic evidence proves them. Heuristics remain candidates. For example, a direct provider import is resolved evidence while an arbitrary provider hostname string remains candidate evidence. Candidate/unresolved status must survive Parity, Architecture, graph search/tracing, evidence inspection, and the Viewer.

### Semantic diff discipline

Semantic A→W and semantic ref-to-ref diff compare stable topology shape. Line/locator/source-ID/evidence-reference churn alone must not appear as semantic change. Evidence and analyzer drift are reported separately.

### Agent/human graph parity

The human `/graph` viewer addresses the same canonical W or explicit runtime `graphId` as agents. Relationship evidence and certainty remain inspectable rather than being lost in presentation.

### Public MCP contract

The permanent surface is intentionally small:

- `list_projects`
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

Retired duplicate aliases, separate Parity lifecycle tools, development-methodology tools, and public cache housekeeping should remain absent.

### MCP protocol

Acceptance covers modern `2026-07-28` discovery, routing headers, complete results, private cache hints, public tool listing, and correct open-world/read-only annotations.

## CardForge benchmark

CardForge remains a representative large real repository because it exercises cross-file calls, feature topology, routes/APIs, providers, MCP, UI, and source search at useful scale.

The permanent benchmark is read-only against a pinned CardForge SHA and proves generic behavior:

- graph construction and coverage;
- generic semantic kinds;
- imports, resolution, and calls;
- representative exact-symbol traces reaching known cross-file consumers;
- source search;
- canonical Parity and Architecture lenses.

The retired Product Reality checkpoint was migration/cutover evidence. Exact oracle comparison is intentionally not a permanent CI dependency after semantic migration is accepted.

## Evidence strategy

Use focused deterministic proof while changing graph/analyzer boundaries, then one full `npm run verify` candidate gate. Keep only tests that protect durable guarantees. Delete migration probes, obsolete aliases, and implementation-shape assertions once stronger stable contracts supersede them.

Hosted OAuth/proxy behavior is an operational boundary and requires end-to-end acceptance on the deployed candidate when that hosting configuration is rolled out; local unit tests are not a substitute for that provider-owned proof.
