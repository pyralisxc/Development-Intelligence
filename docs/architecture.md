# Architecture

## System shape

```text
Development Intelligence MCP
├── Codebase Memory
│   ├── managed Git source lifecycle
│   ├── atomic index generations
│   └── upstream Codebase Memory query proxy
└── Parity Engine
    ├── generic technology analyzers
    ├── observations/evidence
    ├── deterministic + candidate resolution
    └── scan/query/diff/status
```

The two engines do not depend on one another.

## Project registry

The registry is operator-controlled access configuration. A project entry defines repository/ref access and optional allowlisted runtime origins. It does not define product semantics.

Public project identity is the registry key. Internal Codebase Memory generation names and managed worktree paths are derived implementation details and are removed from public proxy results.

## Codebase Memory lifecycle

Development Intelligence treats Git as canonical source revision mechanics and Codebase Memory as the code graph/index engine.

For each project it maintains:

- a bare managed Git mirror;
- immutable detached worktrees by source SHA;
- generation metadata;
- one selected last-known-good Codebase Memory generation;
- bounded previous generations for rollback/debugging.

Each index attempt gets a unique internal Codebase Memory project identity, even when re-indexing the same SHA after derived-state damage. Selection changes only after both `index_repository` and `index_status` are healthy.

`project_status` keeps source freshness and graph freshness separate.

## Parity Engine model

Durable primitives:

- **Source** — where an observation came from.
- **Observation** — a directly observed technical value/entity/structure.
- **Evidence** — support for an observation/resolution.
- **Resolution** — a relationship between observations.
- **Revision** — source-specific revision or observation point.

Resolution states:

- `resolved`
- `candidate`
- `unresolved`

Generic analyzers currently include:

- TypeScript / JavaScript / JSX / TSX
- JSON (secret-like structured values are redacted)
- Markdown / MDX
- HTML
- read-only runtime HTTP HTML/JSON

Repository analyzers are selected from file type/technical evidence only. Runtime analysis is selected from response content type only.

The TypeScript analyzer can observe ordinary structured declarations, UI controls/handlers, HTTP calls, navigation calls, MCP registrations, and local symbol relationships. It does not know project-specific nouns. Secret-like structured values are redacted before observations are persisted or returned, regardless of whether they were found in JSON or TypeScript.

Cross-source similarity produces candidates rather than facts. Naming divergence is only derived after a relationship has already been resolved.

## Runtime boundary

Runtime URLs must use an operator-allowlisted HTTP(S) origin. Every redirect is revalidated against the allowlist. Runtime requests are GET-only, bounded by timeout/response-size limits, and may receive credentials only through server-side environment-backed headers.

Credentials are never persisted as observations. Secret-like structured JSON fields are redacted.

## MCP transport

HTTP supports modern stateless MCP revision `2026-07-28` including:

- `server/discover`;
- `MCP-Protocol-Version`, `Mcp-Method`, and applicable `Mcp-Name` header validation;
- `resultType: complete`;
- response `_meta` server identity;
- per-request protocol-version/client-capabilities metadata;
- `tools/list` cache hints.

A limited initialize-era compatibility path remains. The service itself does not require MCP sessions.

Authentication is deliberately outside product semantics:

- bearer token mode;
- trusted reverse-proxy shared-secret mode (for an existing OAuth/auth gateway);
- explicit local unauthenticated mode for development only.
