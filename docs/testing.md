# Testing

Run:

```bash
npm run verify
```

Permanent evidence protects durable Development Intelligence contracts, not historical analyzer/provider implementation.

## Durable contracts

### One intrinsic graph

Code inspection and Parity operate on the same nodes/relationships. Public tooling must not depend on a second external graph owner or separate parity database.

Parity Contract tests protect the boundary between caller intent and observed truth: E is evaluated ephemerally, resolved evidence satisfies requirements, forbidden observations fail explicitly, candidate/unresolved evidence remains unproven, and unsupported as well as partial/skipped/failed coverage prevents absence from manufacturing a negative conclusion.

### Git-owned A/W/B lifecycle

A committed checkpoint is accepted semantic topology for its source state. Currentness is dimensional: source/topology integrity controls accepted semantic currency while evidence/analyzer drift is reported separately rather than automatically manufacturing product drift.

### No durable service database

Remote analysis uses disposable exact-revision checkouts. Scratch state is removed after use. Losing service-local files/caches must not lose accepted intelligence.

### Deterministic and tamper-evident checkpoint

`/.development-intelligence/manifest.json` plus deterministic semantic NDJSON shards under `/.development-intelligence/graph/` excludes its own directory from source fingerprinting. Checkpoint reads recompute semantic topology from shard contents rather than trusting manifest counts/fingerprints alone. The same semantic topology must produce byte-identical checkpoint content.

The `action-smoke` GitHub Actions job invokes the repository's root composite action against Development Intelligence itself. This proves the published packaging path can install, build, and enforce the accepted checkpoint independently of the ordinary repository verification command.

### Source provenance and safety

A mutable ref is resolved once to an exact SHA and that revision context is carried through checkout, caching, graph generation, and source reads. Source fingerprints use Git's content-filtered identity so line-ending checkout policy cannot manufacture platform drift. Tracked symlinks are never followed outside the repository. Credentials never enter graph output. Secret-like structured values, including CSS custom properties, are redacted.

Historical revision tests additionally protect typed commit/branch/tag and GitHub PR head/base/result identities, rejection of ambiguous raw refs under repository-history access, failure of `pr:<number>/result` for an unmerged PR, and current-analyzer replay between distant immutable revisions.

### Runtime snapshot isolation

Runtime observation creates an explicit ephemeral `graphId`. Later canonical project/ref queries must not inherit another request's runtime evidence.

Canonical `repo-…` graph IDs must reconstruct the exact Git revision after process-local cache loss. Runtime `snapshot-…` IDs must remain ephemeral and fail clearly after that cache is lost.

### Universal analysis

An unknown project with no project-specific semantic mapping can still produce useful file/symbol/UI/API/MCP/config/document observations and relationships. The generic source guard prevents known project/workflow nouns from entering production analyzers.

### Stable structural identities

For TypeScript/JavaScript, comment/line movement must not manufacture new symbols. Overload declarations coalesce where they represent one language symbol, while distinct lexical/static/instance identities remain distinct.

For C#, Java, and Python, declaration IDs must likewise survive comment/line movement. C#/Java overloads remain distinct through signature-derived identity, nested declarations retain lexical containment, and a recovered parser error produces `partial` rather than `complete` coverage.

CSS fixtures protect selector, declaration, at-rule, and custom-property visibility. Tests do not imply source-to-selector usage resolution, which remains an explicit boundary.

### Cross-file structural intelligence

Generic module resolution must represent file imports, dynamic `import()` dependencies, import bindings, re-exports, import-to-definition resolution, and provable cross-file calls. Representative CardForge benchmarking demonstrates traces reach known consumers rather than only returning large node counts.

Grouped search/parity tests protect the one-graph/many-independent-queries contract so exploratory agent work does not require one network round trip per term.

### Evidence and conflict discipline

Independent agreeing observations may accumulate evidence for one stable identity. Contradictory semantic assertions remain explicit conflicts. Syntax-proven relationships may be resolved; heuristic cross-source matches remain candidates; unresolved relationships remain explicit.

### Coverage honesty

Every eligible source file resolves to an explicit coverage state such as `complete`, `partial`, `unsupported`, `skipped`, or `failed`. Analyzer failure must never count as complete inspection.

Portfolio acceptance also checks exact GitHub revisions of representative C#/Unity (`pyralisxc/Game-Studio-Core`) and Java (`pyralisxc/Medieval-Sim`) repositories. The `polyglot-portfolio-benchmark` CI job pins both revisions, preserves incomplete coverage explicitly, and publishes disposable replay evidence. The hermetic suite protects parser and coverage contracts; the portfolio replay proves those contracts still produce useful graph depth at real scale.

### Portfolio battle-testing and issue routing

Development Intelligence uses real repositories as a standing evidence portfolio, not merely as synthetic fixtures. Most repositories primarily consume DI for development work; DI additionally replays representative repositories to pressure-test its own capability, honesty, latency, uncertainty handling, and actionability.

Portfolio testing must remain read-only and SHA-pinned. When a replay discovers a potentially real repository problem:

1. establish whether the evidence represents a DI limitation or a project-owned defect;
2. inspect that repository's active/upcoming work before creating anything new;
3. attach exact revision/evidence to existing work when it already covers the problem;
4. create a repository-owned GitHub issue only when the project problem is materially useful and not already represented;
5. keep analyzer/coverage/tooling limitations in Development Intelligence rather than exporting false project defects.

Useful portfolio feedback includes orientation call count, warm/cold latency, evidence depth, uncertainty honesty, fix-surface quality, and whether an agent can act without manually rediscovering the codebase. Recurring weaknesses become DI work items backed by real-repository evidence. External repositories do not need to adopt DI-specific product semantics in order to serve as benchmark evidence.

### Human Workbench over agent truth

The human Workbench is a client of the same Development Intelligence services agents use. Durable UI acceptance covers:

- project chooser and project switching;
- Overview quick notes/currentness/coverage/change synthesis;
- Explore using Summary/List/Table/Graph/Raw representations;
- persistent Inspector with Summary/Connections/Code/Evidence/Changes;
- Query routing over DI's own read-only capabilities;
- shared evidence-backed assessment for Claim/Proof, Capability Realization, and audit findings;
- readable Workbench assessment presentation with status, coverage, facets, claims/proof, findings, and an inspectable raw record;
- Sources inventory including Git/runtime and optional technical sources;
- Changes as readable accepted → working semantic intelligence and arbitrary revision-to-revision replay;
- `/graph?project=...` compatibility redirect into Explore/Graph.

The graph remains an important representation, but the human product must not require a person to navigate primarily through dots and lines.

### Workbench / MCP capability parity

Durable intelligence primitives used by the Workbench must also be available to agents. The public MCP surface therefore includes `project_overview`, `query_intelligence`, `inspect_entity`, `list_sources`, and `query_source` in addition to the graph/code primitives.

Assessment acceptance protects deterministic revision-bound claim/finding identities, purpose-aware proof references to canonical graph evidence, typed realization paths over admissible resolved relationships, claim-scoped coverage-qualified negatives, candidate-as-hypothesis behavior, and the rule that absent facets are not treated as missing unless the caller explicitly requires them. Declaration/containment/correlation relationships may remain valid graph facts without being allowed to prove implementation realization.

The site must not grow a second private intelligence backend that agents cannot access.

### Read-only technical sources

Generic technical sources are operational access only, not semantic configuration. Tests protect that:

- source types/capabilities are allowlisted;
- endpoints are HTTPS;
- credential values come from environment variables, not source config;
- queries are GET-only, bounded by timeout/response-size/result-limit rules;
- redirects are rejected;
- query results remain observations/evidence and are not automatically sealed into accepted topology.
- normalized evidence preserves the raw bounded source response alongside typed source/snapshot/freshness/availability/coverage metadata;
- deployment-state and database-schema fixtures prove materially different source shapes through the same contract;
- repository correlations require exact identifiers: revision equality, one unique SQL table, or one exact provider id;
- stale/unknown freshness and unavailable correlation remain visible rather than becoming false negatives;
- adapters remain projections over provider-owned facts and never become graph lifecycle authorities.

### Native private access

Private mode must preserve separate human and machine credentials:

- unauthenticated browser Workbench access redirects to DI's own sign-in page;
- valid owner password creates a bounded signed `HttpOnly` session cookie;
- bad owner credentials fail;
- unauthenticated MCP returns `401` with a Bearer challenge;
- the independent agent token can reach MCP without reusing the browser credential;
- logout invalidates the owner session cookie.

Repository visibility is not an authentication mechanism. Public source must remain compatible with a privately gated running service.

### MCP protocol

Acceptance covers modern `2026-07-28` discovery, routing headers, complete results, private cache hints, and the intrinsic public tool listing.

## CardForge evidence strategy

The permanent CardForge benchmark is read-only against a pinned source SHA and produces disposable W plus review artifacts. It protects representative scale, coverage, generic semantic kinds, module/import/call resolution, known cross-file traces, source search, Architecture, and Parity. It also protects three agent-workflow concerns observed in real CardForge tasks: one-call grouped exploration, stateless reconstruction of canonical graph IDs, and searchable CSS structure for camera/responsive/layout evidence. Assessment calibration additionally proves natural feature phrasing, present-symbol existence questions, and subject-scoped audits without manufacturing undeclared capability semantics. Scoped audits declare their resolved relationship radius, group findings by observed cause, and retain the underlying evidence rather than treating a raw count as an intrinsic quality judgment. It does not depend on the retired Product Reality oracle, interpret Product Reality metadata as DI semantics, or write a DI checkpoint into CardForge.

## Capacity evidence strategy

Capacity is measured in layers because no single number describes graph construction, warm-query latency, serverless cache locality, and agent usefulness:

1. `npm run verify` protects deterministic correctness and safety boundaries.
2. `npm run benchmark:capacity` builds deterministic TypeScript repositories at 100, 1,000, 5,000, and 10,000 generated source files. Each scale runs in three fresh worker processes and reports the median/range for graph-build wall time, peak resident memory, CPU time, graph size, and coverage. The largest case has 10,001 eligible files after `package.json`; it must analyze exactly the configured 10,000-file ceiling and report the remainder as skipped.
3. The SHA-pinned CardForge and polyglot portfolio replays measure real language/framework complexity, exact coverage, query usefulness, and end-to-end workflow latency. Synthetic throughput must never be presented as real-repository capacity without these controls.
4. Hosted testing measures routing and cache behavior separately. Use an exact immutable revision, warm it once, then collect at least 30 samples for grouped queries and concurrency levels 1, 4, and 8. Report p50, p95, p99, error rate, and whether each sample was a cache hit or exact-revision reconstruction when observable. Do not run a saturation test against production from CI; use an isolated deployment with the same runtime and memory configuration.

Interpret capacity using the first boundary reached: configured file/byte limits, runtime timeout, memory pressure from retained graphs, or unacceptable tail latency. Process-local retention is bounded by both entry count and deterministic graph-record weight; the record budget is a conservative residency control rather than a claim about exact bytes. Cold builds for unrelated graphs are gated separately, while identical project/SHA requests share one in-flight build. A capacity claim must state the repository revision, analyzed/eligible files, node/edge counts, process memory, cold-build latency, warm-query latency, concurrency, deployment shape, and observed error rate.

## Preview acceptance

The persistent `preview` branch is the normal accumulated integration surface. A push to Preview runs the same deterministic correctness, packaged-action, capacity, CardForge, and polyglot evidence as a Main candidate and produces a non-production Vercel deployment. Provider acceptance must bind the READY deployment to the exact Preview SHA. When testing Development Intelligence against its own candidate source, use the explicit `branch:preview` selector; the production registry default remains `main` by design.

Preview evidence may support multiple coherent work PRs before one owner-approved `preview` → `main` promotion. It does not make Preview accepted truth, replace the final sealed-head check, or prove production OAuth/custom-host behavior.

A PR-scoped Preview is a physical acceptance surface after verify + CardForge are green. It runs the exact PR head, then proves through the public HTTPS tunnel that:

- the native private owner sign-in page is reachable;
- owner sign-in can open the Workbench;
- Overview returns readable quick notes;
- Sources exposes the project technical-source inventory;
- unauthenticated MCP fails closed;
- the separate agent bearer credential can complete modern MCP discovery/tool listing and sees the Workbench intelligence primitives;
- the Workbench is navigable by a human before merge.

Preview proof does not replace production OAuth acceptance when a specific remote MCP client is configured to require OAuth.

Do not preserve tests merely because they protected retired persistent-cache, duplicate parity, graph-only UI, or external-engine behavior. Preserve the guarantees that still matter under the intrinsic Git-native architecture.
