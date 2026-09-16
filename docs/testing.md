# Testing

Run:

```bash
npm run verify
```

Permanent evidence protects durable Development Intelligence contracts, not historical analyzer/provider implementation.

## Durable contracts

### One intrinsic graph

Code inspection and Parity operate on the same nodes/relationships. Public tooling must not depend on a second external graph owner or separate parity database.

### Git-owned A/W/B lifecycle

A committed checkpoint is accepted semantic topology for its source state. Currentness is dimensional: source/topology integrity controls accepted semantic currency while evidence/analyzer drift is reported separately rather than automatically manufacturing product drift.

### No durable service database

Remote analysis uses disposable exact-revision checkouts. Scratch state is removed after use. Losing service-local files/caches must not lose accepted intelligence.

### Deterministic and tamper-evident checkpoint

`/.development-intelligence/manifest.json` plus deterministic semantic NDJSON shards under `/.development-intelligence/graph/` excludes its own directory from source fingerprinting. Checkpoint reads recompute semantic topology from shard contents rather than trusting manifest counts/fingerprints alone. The same semantic topology must produce byte-identical checkpoint content.

### Source provenance and safety

A mutable ref is resolved once to an exact SHA and that revision context is carried through checkout, caching, graph generation, and source reads. Tracked symlinks are never followed outside the repository. Credentials never enter graph output. Secret-like structured values are redacted.

### Runtime snapshot isolation

Runtime observation creates an explicit ephemeral `graphId`. Later canonical project/ref queries must not inherit another request's runtime evidence.

### Universal analysis

An unknown project with no project-specific semantic mapping can still produce useful file/symbol/UI/API/MCP/config/document observations and relationships. The generic source guard prevents known project/workflow nouns from entering production analyzers.

### Stable structural identities

For TypeScript/JavaScript, comment/line movement must not manufacture new symbols. Overload declarations coalesce where they represent one language symbol, while distinct lexical/static/instance identities remain distinct.

### Cross-file structural intelligence

Generic module resolution must represent file imports, dynamic `import()` dependencies, import bindings, re-exports, import-to-definition resolution, and provable cross-file calls. Representative CardForge benchmarking demonstrates traces reach known consumers rather than only returning large node counts.

### Evidence and conflict discipline

Independent agreeing observations may accumulate evidence for one stable identity. Contradictory semantic assertions remain explicit conflicts. Syntax-proven relationships may be resolved; heuristic cross-source matches remain candidates; unresolved relationships remain explicit.

### Coverage honesty

Every eligible source file resolves to an explicit coverage state such as `complete`, `partial`, `unsupported`, `skipped`, or `failed`. Analyzer failure must never count as complete inspection.

### Human navigation over agent truth

The human `/graph` Viewer renders the same graph used by MCP tools but is tested as a navigation surface, not merely an HTML container. Durable UI acceptance includes named Architecture/Parity/Code/Change destinations, full-graph search, focused neighborhoods, an Inspector, readable connection navigation, evidence access, and graph fit/zoom controls. Raw graph JSON remains optional technical detail.

### Native private access

Private mode must preserve separate human and machine credentials:

- unauthenticated browser Viewer access redirects to DI's own sign-in page;
- valid owner password creates a bounded signed `HttpOnly` session cookie;
- bad owner credentials fail;
- unauthenticated MCP returns `401` with a Bearer challenge;
- the independent agent token can reach MCP without reusing the browser credential;
- logout invalidates the owner session cookie.

Repository visibility is not an authentication mechanism. Public source must remain compatible with a privately gated running service.

### MCP protocol

Acceptance covers modern `2026-07-28` discovery, routing headers, complete results, private cache hints, and the frozen public tool listing.

## CardForge evidence strategy

The permanent CardForge benchmark is read-only against a pinned source SHA and produces disposable W plus review artifacts. It protects representative scale, coverage, generic semantic kinds, module/import/call resolution, known cross-file traces, source search, Architecture, and Parity. It does not depend on the retired Product Reality oracle and never writes a DI checkpoint into CardForge.

## Preview acceptance

A PR-scoped Preview is a physical acceptance surface after verify + CardForge are green. It runs the exact PR head, then proves through the public HTTPS tunnel that:

- the native private owner sign-in page is reachable;
- owner sign-in can open the human Viewer;
- unauthenticated MCP fails closed;
- the separate agent bearer credential can complete modern MCP discovery/tool listing;
- the Viewer is navigable by a human before merge.

Preview proof does not replace production OAuth acceptance when a specific remote MCP client is configured to require OAuth.

Do not preserve tests merely because they protected retired persistent-cache, duplicate parity, or external-engine behavior. Preserve the guarantees that still matter under the intrinsic Git-native architecture.
