# Testing

Run:

```bash
npm run verify
```

The permanent suite protects durable infrastructure contracts rather than implementation details.

## Durable contracts

### Source/index atomicity

A failed Codebase Memory generation cannot replace the selected last-known-good source/index pair.

### Bounded derived state

Old Codebase Memory generations and detached worktrees are pruned according to the configured retention window.

### Public identity

Internal Codebase Memory generation IDs and managed filesystem paths do not leak through normal public project/status/query responses.

### Universal parity

An unknown project with no project-specific analyzer or semantic mapping can still produce useful technical observations and relationships from ordinary source/runtime structures.

### Evidence discipline

Deterministic syntax relationships remain resolved; similarity relationships remain candidates; unresolved relationships remain unresolved.

### Sensitive values

Secret-like structured JSON values are redacted from persisted parity observations.

### Tool boundary

Development Intelligence exposes technical intelligence tools and excludes workflow/intent operations such as ADR management, Build authorization, or PR creation.

### MCP protocol

The HTTP acceptance test covers modern `2026-07-28` discovery, routing headers, complete results, cache hints, tool calls, and header mismatch rejection.

### Generic source boundary

`scripts/check-generic-boundary.mjs` prevents known project/workflow names from entering generic production source.

## Temporary evidence

Benchmarks, one-off deployment probes, and migration comparison scripts are temporary by default. Promote them only when they protect a durable operational guarantee.
