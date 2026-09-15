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

A committed checkpoint whose source fingerprint matches the project source is current A. Source changes make A stale while W reflects working reality. Sealing and committing B restores checkpoint/source parity; Git owns accepted history.

### No durable service database

Remote analysis uses disposable exact-revision checkouts. Scratch state is removed after use. Losing service-local files/caches must not lose accepted intelligence.

### Deterministic checkpoint

`/.development-intelligence/manifest.json` plus deterministic sharded NDJSON records under `/.development-intelligence/graph/` contains stable records and excludes its own directory from source fingerprinting. Volatile observation timestamps/service paths do not enter the checkpoint. The same graph must produce byte-identical manifest/shard content.

### Source provenance and safety

Remote reads are exact-SHA. Tracked symlinks are never followed as source content. Repository/runtime credentials never enter graph output. Secret-like structured values are redacted.

### Universal analysis

An unknown project with no project-specific semantic mapping can still produce useful file/symbol/UI/API/MCP/config/document observations and relationships. The generic source guard prevents known project/workflow nouns from entering production analyzers.

### Cross-file structural intelligence

For TypeScript/JavaScript projects, generic module resolution must represent file imports, import bindings, re-exports, import-to-definition resolution, and provable cross-file calls. Representative CardForge benchmarking must demonstrate that traces reach known consumers rather than only returning large node counts.

### Evidence discipline

Syntax-proven relationships may be resolved. Heuristic cross-source matches remain candidates. Unresolved relationships remain explicit rather than being silently promoted.

### Runtime isolation

Runtime observation is allowlisted, GET-only, bounded, and must not forward configured credentials across origins through redirects.

### Agent/human graph parity

The human `/graph` viewer renders the same canonical graph records used by MCP query/trace tools.

### MCP protocol

Acceptance covers modern `2026-07-28` discovery, routing headers, complete results, private cache hints, and tool listing.

## Evidence strategy

Use focused deterministic proof while changing graph/analyzer boundaries, then one full `npm run verify` candidate gate. The CardForge benchmark runs read-only against a pinned source SHA and produces disposable W plus review artifacts; it must not write a checkpoint into CardForge. Provider/host behavior should be proven at that real boundary only when hosting configuration is actually changed.

Do not preserve tests merely because they protected retired persistent-cache or external-engine behavior. Preserve the guarantees that still matter under the intrinsic Git-native architecture.
